-- System of record. Postgres 13+ (gen_random_uuid is built in).

create extension if not exists pgcrypto; -- digest() for api-key hashing in backfill

-- Accounts layer: users belong to organizations; an organization owns
-- environments (the `tenants` table — every data row already scopes to it);
-- each environment has rotating hashed API keys.

create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists org_members (
  organization_id uuid not null references organizations(id),
  user_id         uuid not null references users(id),
  role            text not null default 'member', -- owner | admin | member
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- "tenants" = ENVIRONMENTS (an organization's Development / Production).
-- Legacy column api_key remains for pre-accounts installs; new keys live in
-- api_keys (hashed, rotatable).
create table if not exists tenants (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  api_key            text unique,
  rate_limit_per_sec int  not null default 50,
  created_at         timestamptz not null default now()
);

alter table tenants alter column api_key drop not null;
alter table tenants add column if not exists organization_id uuid references organizations(id);

create table if not exists api_keys (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  name       text not null default 'default',
  key_prefix text not null,          -- first chars, for display only
  key_hash   text not null unique,   -- sha256 hex; plaintext is never stored
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists api_keys_tenant_idx on api_keys (tenant_id);

create table if not exists subscribers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  external_id text not null,
  email       text,
  phone       text,
  push_token  text,
  -- e.g. {"channels": {"email": true, "sms": false}}
  preferences jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists workflows (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  key        text not null,
  name       text not null,
  -- [{"channel":"email","subject":"...","body":"...","delaySeconds":0}, ...]
  steps      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  transaction_id  text not null,
  workflow_key    text not null,
  priority        text not null default 'p1',
  payload         jsonb not null default '{}',
  recipients      jsonb not null default '[]',
  recipient_count int  not null default 0,
  -- Broadcast events carry no recipient list: the trigger worker pages
  -- through the subscribers table instead.
  is_broadcast    boolean not null default false,
  status          text not null default 'accepted', -- accepted|processing|completed
  created_at      timestamptz not null default now(),
  -- Idempotency backstop: the same transactionId can never create two events.
  unique (tenant_id, transaction_id)
);

create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  event_id            uuid not null references events(id),
  subscriber_id       uuid not null references subscribers(id),
  transaction_id      text not null,
  channel             text not null,
  step_index          int  not null default 0,
  priority            text not null default 'p1',
  -- Rendered content + target address snapshot taken at fan-out time.
  content             jsonb not null default '{}',
  provider            text,
  provider_message_id text,
  status              text not null default 'queued',
  -- queued|sending|sent|delivered|failed|skipped|bounced
  error               text,
  attempts            int not null default 0,
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Fan-out idempotency: a retried fan-out job can never duplicate a message.
  unique (event_id, subscriber_id, channel, step_index)
);

create index if not exists messages_txn_idx
  on messages (tenant_id, transaction_id);
create index if not exists messages_status_created_idx
  on messages (status, created_at);
create index if not exists messages_provider_msg_idx
  on messages (provider_message_id) where provider_message_id is not null;

-- In-app inbox additions (idempotent for databases created before them).
alter table messages add column if not exists read_at timestamptz;
alter table messages add column if not exists opened_at timestamptz;
alter table events add column if not exists is_broadcast boolean not null default false;
create index if not exists messages_inbox_idx
  on messages (tenant_id, subscriber_id, created_at desc)
  where channel = 'inapp';

-- Topics: named subscriber segments ("beta-users", "org:acme"). Triggers can
-- target a topic instead of enumerating recipients; fan-out pages the
-- membership with the same backpressure machinery broadcast uses.
create table if not exists topics (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  key        text not null,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists topic_subscribers (
  topic_id      uuid not null references topics(id) on delete cascade,
  subscriber_id uuid not null references subscribers(id),
  created_at    timestamptz not null default now(),
  primary key (topic_id, subscriber_id)
);

-- Bring-your-own provider credentials, per environment. Credentials are
-- AES-256-GCM sealed (see src/auth/secret-box.ts) and never leave the API.
create table if not exists integrations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  channel        text not null,
  provider       text not null,   -- smtp | sendgrid | resend | twilio | fcm | ...
  credentials    text not null,   -- sealed
  is_primary     boolean not null default false,
  fallback_order int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists integrations_tenant_channel_idx
  on integrations (tenant_id, channel) where active;

-- Addresses that hard-bounced or complained: never send to them again
-- until explicitly removed. Populated automatically by the status worker.
create table if not exists suppressions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  channel    text not null,
  address    text not null,
  reason     text not null, -- bounced | complaint | manual
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, address)
);

-- Append-only audit trail. Written in batches by the log-writer worker,
-- never synchronously from the send path (protects hot-path database IOPS).
create table if not exists execution_logs (
  id             bigserial primary key,
  tenant_id      uuid,
  transaction_id text,
  message_id     uuid,
  level          text not null default 'info',
  detail         text not null,
  raw            jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists exec_logs_txn_idx on execution_logs (transaction_id);
create index if not exists exec_logs_created_idx on execution_logs (created_at);

-- ---- Backfill for installs created before the accounts layer ----
-- Give orphan environments a default organization, and move their legacy
-- plaintext api_key into the hashed api_keys table (old keys keep working).
insert into organizations (name)
  select 'Default Organization'
  where exists (select 1 from tenants where organization_id is null)
    and not exists (select 1 from organizations where name = 'Default Organization');

update tenants
  set organization_id = (select id from organizations where name = 'Default Organization' limit 1)
  where organization_id is null;

insert into api_keys (tenant_id, name, key_prefix, key_hash)
  select t.id, 'legacy', left(t.api_key, 8), encode(digest(t.api_key, 'sha256'), 'hex')
  from tenants t
  where t.api_key is not null
    and not exists (select 1 from api_keys k where k.tenant_id = t.id and k.name = 'legacy');
