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

-- Email templates: MJML + Handlebars, VERSIONED. Every save snapshots a new
-- version; messages pin the version they were fanned out with, so an edit
-- never changes an email that's already in flight.
create table if not exists templates (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  key             text not null,
  name            text not null,
  subject         text not null,
  mjml            text not null,
  current_version int  not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists template_versions (
  template_id uuid not null references templates(id) on delete cascade,
  version     int  not null,
  subject     text not null,
  mjml        text not null,
  created_at  timestamptz not null default now(),
  primary key (template_id, version)
);

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

-- Conversations layer: an AGENT is a customer-registered brain (a bridge
-- URL we call with normalized conversation events, HMAC-signed with a
-- per-agent secret sealed like integration credentials). Conversations
-- thread inbound subscriber messages with the agent's replies; the message
-- rows are the durable transcript, deduped so retried jobs can never
-- duplicate a turn.

create table if not exists agents (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  identifier     text not null,   -- stable id used by SDKs/routes
  name           text not null,
  description    text,
  bridge_url     text,            -- required for runtime='bridge' (app layer)
  signing_secret text not null,   -- sealed (AES-256-GCM, see secret-box.ts)
  status         text not null default 'active', -- active | disabled
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, identifier)
);

-- Managed LLM brain (runtime='managed'): we run the model loop ourselves —
-- zero customer code. llm_base_url points at any Anthropic-compatible
-- endpoint (default api.anthropic.com); the API key is sealed, write-only.
alter table agents alter column bridge_url drop not null;
alter table agents add column if not exists runtime text not null default 'bridge'; -- bridge | managed
alter table agents add column if not exists model text;
alter table agents add column if not exists system_prompt text;
alter table agents add column if not exists llm_base_url text;
alter table agents add column if not exists llm_credentials text; -- sealed {apiKey}
alter table agents add column if not exists max_tokens int; -- managed reply cap (null = default)
-- Platform backstop: resolve conversations idle for N MINUTES (null = off).
-- Was auto_resolve_hours for one release; the DO block migrates ×60.
do $$ begin
  if exists (select from information_schema.columns
             where table_name = 'agents' and column_name = 'auto_resolve_hours') then
    alter table agents add column if not exists auto_resolve_minutes int;
    update agents set auto_resolve_minutes = auto_resolve_hours * 60
     where auto_resolve_minutes is null and auto_resolve_hours is not null;
    alter table agents drop column auto_resolve_hours;
  else
    alter table agents add column if not exists auto_resolve_minutes int;
  end if;
end $$;

-- Phase 17: agent speaks first. welcome_message (≤2000 chars, app layer)
-- renders client-side in the widget (zero rows until the user acts) and
-- as the bare-/start reply on telegram (dedupe welcome-<convId>).
-- suggested_prompts: jsonb [{title ≤40, message ≤200}] max 6 (app layer);
-- widget chips / telegram keyboard / slack manifest suggested_prompts.
alter table agents add column if not exists welcome_message text;
alter table agents add column if not exists suggested_prompts jsonb;

-- Channel connections: an agent's identity on an external messaging
-- platform (v1: telegram). Credentials (bot token + the webhook secret we
-- mint) are sealed; config holds public facts (bot username/id).
create table if not exists agent_connections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  agent_id    uuid not null references agents(id) on delete cascade,
  channel     text not null, -- telegram
  credentials text not null, -- sealed JSON {botToken, webhookSecret}
  config      jsonb not null default '{}', -- {botId, botUsername}
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  agent_id        uuid not null references agents(id) on delete cascade,
  subscriber_id   uuid not null references subscribers(id),
  -- The channel connection this thread belongs to (channel conversations key
  -- by connection; inapp + legacy rows stay null and key by agent+channel).
  connection_id   uuid references agent_connections(id) on delete set null,
  channel         text not null default 'inapp',
  -- One conversation per (agent, channel, thread): for in-app the thread IS
  -- the subscriber; external channels (Phase 2) put their thread id here.
  thread_key      text not null,
  status          text not null default 'active', -- active | resolved
  metadata        jsonb not null default '{}',    -- ctx.metadata.*, <=64KB
  summary         text,
  message_count   int not null default 0,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists conversations_tenant_recent_idx
  on conversations (tenant_id, last_message_at desc);

-- The inactivity sweep's hot path: cost scales with the number of ACTIVE
-- conversations (the matches), never with total table size.
create index if not exists conversations_active_stale_idx
  on conversations (last_message_at) where status = 'active';

-- ---- Phase 12 Slice A: connection/endpoint model split ----
-- Connections become re-pointable (mutable agent_id = v1 routing table) and
-- channel conversations re-key to (connection_id, thread_key). Idempotent:
-- each step is gated on the old shape still existing, so a second run no-ops.
alter table conversations add column if not exists connection_id
  uuid references agent_connections(id) on delete set null;

-- Phase 12 split: runs exactly once, gated on the old weld still existing —
-- which is also what makes the backfill join unambiguous (1:1 by constraint).
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'conversations'::regclass and contype = 'u'
     and cardinality(conkey) = 3;
  if c is not null then
    update conversations cv
       set connection_id = ac.id
      from agent_connections ac
     where cv.connection_id is null
       and cv.channel <> 'inapp'
       and ac.agent_id = cv.agent_id
       and ac.channel  = cv.channel;
    execute format('alter table conversations drop constraint %I', c);
  end if;
end $$;

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'agent_connections'::regclass and contype = 'u';
  if c is not null then
    execute format('alter table agent_connections drop constraint %I', c);
  end if;
end $$;

-- Deleting an agent must not silently destroy a live channel identity:
-- the API 409s first (next slice); this is the raw-SQL backstop.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'agent_connections'::regclass
     and contype = 'f' and confdeltype = 'c';
  if c is not null then
    execute format('alter table agent_connections drop constraint %I', c);
    alter table agent_connections
      add constraint agent_connections_agent_id_fkey
      foreign key (agent_id) references agents(id) on delete restrict;
  end if;
end $$;

-- Same bot/mailbox twice per tenant: older duplicates are already dead
-- (telegram honors only the latest setWebhook) — park, don't delete.
update agent_connections a set status = 'disabled'
 where a.status = 'active' and a.channel in ('telegram','email')
   and exists (select 1 from agent_connections b
                where b.tenant_id = a.tenant_id and b.channel = a.channel
                  and b.status = 'active' and b.created_at > a.created_at
                  and ((a.channel='telegram' and b.config->>'botId' = a.config->>'botId')
                    or (a.channel='email' and b.config->>'address' = a.config->>'address')));

create unique index if not exists agent_connections_tg_identity_uq
  on agent_connections (tenant_id, (config->>'botId'))
  where channel = 'telegram' and status = 'active';
create unique index if not exists agent_connections_email_identity_uq
  on agent_connections (tenant_id, (config->>'address'))
  where channel = 'email' and status = 'active';

-- Channel threads key by connection; inapp (and legacy nulls) stay agent-keyed.
create unique index if not exists conversations_conn_thread_uq
  on conversations (connection_id, thread_key) where connection_id is not null;
create unique index if not exists conversations_agent_thread_uq
  on conversations (agent_id, channel, thread_key) where connection_id is null;

-- One human, many channel identities. Inbound resolution consults this
-- mapping FIRST (one unique-index hit per message); a miss falls back to
-- the auto-created channel-local subscriber (tg-<id> / sender-email row).
-- Linking writes a row here — subscriber rows are never merged/deleted.
create table if not exists channel_identities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  channel       text not null,           -- telegram | email
  external_key  text not null,           -- telegram user id / normalized email
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (tenant_id, channel, external_key)
);

-- Single-use deep-link tokens (t.me/<bot>?start=<token>). Stored hashed;
-- consumed atomically; dead rows purged by the inactivity-sweep tick.
create table if not exists subscriber_link_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  channel       text not null,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists link_tokens_expiry_idx
  on subscriber_link_tokens (expires_at);

-- Phase 17: admin phone-handoff sessions ("set up from your phone").
-- The dashboard mints a 5-minute single-use token; the phone opens
-- {publicUrl}/handoff/<token>, pastes the BotFather message, and the
-- parsed bot token is SEALED into payload until the authed dashboard
-- poll reads it exactly once (payload nulled on read). Token stored
-- hashed only; used_at set atomically on paste; expired rows purged by
-- the inactivity-sweep tick alongside link tokens.
create table if not exists setup_handoffs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  channel        text not null default 'telegram',
  token_hash     text not null unique,
  payload_sealed text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists setup_handoffs_expiry_idx
  on setup_handoffs (expires_at);

-- Email auto-match's hot path: sender address -> existing real subscriber.
create index if not exists subscribers_tenant_email_idx
  on subscribers (tenant_id, email) where email is not null;

create table if not exists conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id       uuid not null references tenants(id),
  role            text not null, -- user | agent | system
  content         text not null,
  -- Idempotency wall: client message ids and reply-to-<inbound id> keys land
  -- here, so API retries and re-run bridge jobs can't duplicate a turn.
  dedupe_key      text not null,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  unique (conversation_id, dedupe_key)
);

create index if not exists conversation_messages_conv_idx
  on conversation_messages (conversation_id, created_at);

alter table conversation_messages add column if not exists edited_at timestamptz;
alter table conversation_messages add column if not exists deleted_at timestamptz;
alter table conversation_messages add column if not exists deleted_by text; -- 'user' | 'operator'

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

-- ---- Phase 13: Slack channel ----
create unique index if not exists agent_connections_slack_identity_uq
  on agent_connections (tenant_id, (config->>'teamId'))
  where channel = 'slack' and status = 'active';

-- Per-scope routing inside ONE workspace connection: #support -> agent A,
-- #billing -> agent B. scope_key = the Slack channel id (C.../G...). DMs never
-- consult this table -- they use the connection's default agent.
create table if not exists connection_routing_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  connection_id uuid not null references agent_connections(id) on delete cascade,
  scope_key     text not null,
  agent_id      uuid not null references agents(id) on delete restrict,
  created_at    timestamptz not null default now(),
  unique (connection_id, scope_key)
);
