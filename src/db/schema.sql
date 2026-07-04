-- System of record. Postgres 13+ (gen_random_uuid is built in).

create table if not exists tenants (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  api_key            text not null unique,
  rate_limit_per_sec int  not null default 50,
  created_at         timestamptz not null default now()
);

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
alter table events add column if not exists is_broadcast boolean not null default false;
create index if not exists messages_inbox_idx
  on messages (tenant_id, subscriber_id, created_at desc)
  where channel = 'inapp';

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
