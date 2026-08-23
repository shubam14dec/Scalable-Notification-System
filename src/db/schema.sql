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
  -- active | resolved | waiting_human | human  (Phase 26 HITL handoff: a
  -- managed agent handing off flips active -> waiting_human; the first operator
  -- reply -> human; "Return to agent" -> active. No CHECK constraint here (the
  -- column has always been a free text status); the Conversation type union in
  -- conversations.repo.ts is the enforced surface.
  status          text not null default 'active',
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

-- Phase 18: customer-defined agent tools. A tool def is prompt-facing
-- metadata (name/description/parameters tell the MODEL when and how to call
-- it) plus an execution contract (the customer's HTTPS endpoint we POST to,
-- signed with the per-tool sealed secret — bridge HMAC scheme). approval
-- 'required' gates execution behind a human decision. endpoint_url is
-- SSRF-validated at write time (app layer); name is app-validated against
-- ^[a-z][a-z0-9_]{0,63}$ and the built-in tool names.
create table if not exists agent_tool_defs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  agent_id     uuid not null references agents(id) on delete cascade,
  name         text not null,
  description  text not null,
  parameters   jsonb not null default '{"type":"object","properties":{}}',
  endpoint_url text not null,
  secret       text not null,           -- sealed (AES-256-GCM, secret-box)
  approval     text not null default 'auto',   -- auto | required
  status       text not null default 'active', -- active | disabled
  timeout_ms   int not null default 10000,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (agent_id, name)
);

-- Every customer-tool invocation, auto or gated: one table is both the
-- execution/audit log and the approval queue. dedupe_key is content-keyed
-- (tc-<inboundMsgId>-<tool>-<argsHash>) so a retried worker job reuses the
-- stored row/result instead of double-POSTing a side effect. Pending rows
-- expire via the inactivity sweep (default 24h). breadcrumb_message_id
-- points at the transcript system row whose raw.action.result is updated
-- in place at decision time (the replay stays pair-complete throughout).
create table if not exists agent_tool_calls (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  agent_id              uuid not null references agents(id) on delete cascade,
  conversation_id       uuid not null references conversations(id) on delete cascade,
  tool_def_id           uuid references agent_tool_defs(id) on delete set null,
  tool_name             text not null,
  args                  jsonb not null default '{}',
  dedupe_key            text not null unique,
  status                text not null default 'pending',
    -- pending | approved | denied | expired | executed | failed
  result                text,            -- truncated (≤16KB) result string
  note                  text,            -- approver note
  decided_by            text,
  breadcrumb_message_id uuid,
  requested_at          timestamptz not null default now(),
  decided_at            timestamptz,
  expires_at            timestamptz
);

create index if not exists agent_tool_calls_pending_idx
  on agent_tool_calls (tenant_id, requested_at desc) where status = 'pending';
create index if not exists agent_tool_calls_expiry_idx
  on agent_tool_calls (expires_at) where status = 'pending';
create index if not exists agent_tool_calls_conversation_idx
  on agent_tool_calls (conversation_id);

-- Phase 19: channel approvals. cards tracks every approval card posted to
-- an external channel so taps can be correlated and the cards edited in
-- place to the final outcome. Entries:
--   {channel:'slack',    connectionId, channelId, ts}
--   {channel:'telegram', connectionId, chatId, messageId}
-- connectionId is load-bearing: tap webhooks route by :connectionId, and
-- the finalizer needs it to pick the right bot token.
alter table agent_tool_calls add column if not exists
  cards jsonb not null default '[]';

-- The first tenant-WIDE settings store (everything before this was
-- per-agent or per-connection). Generic key/value so future tenant-level
-- config (branding, defaults) reuses it instead of sprouting columns.
-- Phase 19 uses key 'approvals':
--   {slackConnectionId, slackChannelId, telegramConnectionId}
create table if not exists tenant_settings (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

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

-- ---- Phase 20: push & sms hardening ----

-- Multi-device push. subscribers.push_token holds exactly ONE device (laptop
-- OR phone, never both); this table holds up to 10 per subscriber (app-layer
-- cap, oldest last_seen evicted). Re-registering the same token upserts:
-- bumps last_seen and RE-POINTS subscriber_id, so a shared device that logs
-- into a different account moves with the login. The legacy column stays for
-- API back-compat (writes mirror here); fan-out reads THIS table only.
create table if not exists device_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  token         text not null,
  platform      text,             -- web | android | ios | null (unknown/legacy)
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (tenant_id, token)
);

create index if not exists device_tokens_subscriber_idx
  on device_tokens (tenant_id, subscriber_id);

-- Backfill legacy single tokens (idempotent; re-runs no-op via the conflict).
-- Deleting a device also nulls a matching subscribers.push_token (repo layer)
-- so this backfill cannot resurrect an explicitly-removed device.
insert into device_tokens (tenant_id, subscriber_id, token)
  select s.tenant_id, s.id, s.push_token from subscribers s
  where s.push_token is not null
  on conflict (tenant_id, token) do nothing;

-- One message row PER DEVICE for push steps (per-device status/retries).
-- device_key discriminates them inside the fan-out dedupe key; '' for every
-- non-push-device row keeps historic and non-push behavior byte-identical.
-- Index first, THEN drop the old 4-col constraint (same transaction — the
-- dedupe wall never has a gap).
alter table messages add column if not exists device_key text not null default '';

create unique index if not exists messages_dedupe_uq
  on messages (event_id, subscriber_id, channel, step_index, device_key);

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'messages'::regclass and contype = 'u'
     and cardinality(conkey) = 4;
  if c is not null then
    execute format('alter table messages drop constraint %I', c);
  end if;
end $$;

-- ---- Phase 21: agent observability ----
-- The health aggregate joins conversation_messages -> conversations filtered by
-- (tenant_id, agent_id). No existing index covers a bare agent_id lookup — the
-- only agent_id index is the partial conversations_agent_thread_uq (connection_id
-- is null), so channel threads miss it. This makes the join's conversation-side
-- probe an index range scan instead of a seq scan as conversations grows.
create index if not exists conversations_agent_idx on conversations (agent_id);

-- ---- Phase 22: evals-as-gate + guardrails ----

-- Per-agent eval scenarios (same JSON shape as evals/*.json: turns of
-- {user} / {expect}). Stored per agent so the dashboard can gate prompt
-- edits on them; 'enabled=false' keeps drafts (e.g. conversation->eval)
-- out of runs until a human reviews them.
create table if not exists agent_evals (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  agent_id   uuid not null references agents(id) on delete cascade,
  name       text not null,
  scenario   jsonb not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, name)
);

create index if not exists agent_evals_agent_idx on agent_evals (agent_id);

-- One row per eval run (manual or pre-save). results = per-scenario
-- verdicts [{name, passed, failures:[...]}]; status 'error' = the run
-- itself broke (infra), distinct from 'failed' (scenarios failed).
create table if not exists agent_eval_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  agent_id    uuid not null references agents(id) on delete cascade,
  status      text not null default 'running', -- running|passed|failed|error
  trigger     text not null default 'manual',  -- manual|pre_save
  results     jsonb not null default '[]',
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists agent_eval_runs_agent_idx
  on agent_eval_runs (agent_id, started_at desc);

-- Guardrails: per-tool guard config {maxAutoCalls?, windowDays?,
-- maxCallsPerHour?} (null = no guards, today's behavior) and the
-- executor-measured duration of the signed POST (feeds /health avgMs).
alter table agent_tool_defs add column if not exists guard jsonb;
alter table agent_tool_calls add column if not exists duration_ms int;

-- Per-agent daily token circuit breaker (null = off). Enforced via a
-- Redis day-counter; Postgres raw.usage stays the auditable truth.
alter table agents add column if not exists max_daily_tokens int;

-- The repeat-action count's hot path: executed calls per tool def in a
-- window (joined to conversations for the subscriber scope).
create index if not exists agent_tool_calls_guard_idx
  on agent_tool_calls (tool_def_id, requested_at) where status = 'executed';

-- ---- Phase 23: knowledge (RAG) + episodic memory ----
-- Postgres is the SYSTEM OF RECORD: sources, chunk TEXT, statuses, and the
-- vector ids (= row ids). Pinecone holds only id->embedding; deletes are
-- driven from these rows via retryable jobs, never external filter-deletes.

create table if not exists knowledge_sources (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  agent_id   uuid not null references agents(id) on delete cascade,
  name       text not null,
  kind       text not null default 'text',        -- text | url
  -- kind url: {url}; kind text: {} — original content is NOT retained
  -- beyond its chunks (the chunks ARE the indexed copy).
  meta       jsonb not null default '{}',
  status     text not null default 'pending',     -- pending|indexing|ready|error
  error      text,
  chunk_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, name)
);

create index if not exists knowledge_sources_agent_idx
  on knowledge_sources (agent_id);

-- One row per chunk; the row id doubles as the Pinecone vector id.
create table if not exists knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  source_id     uuid not null references knowledge_sources(id) on delete cascade,
  agent_id      uuid not null references agents(id) on delete cascade,
  seq           int  not null,
  content       text not null,
  token_count   int  not null default 0,
  embedding_dim int,                               -- null until embedded
  created_at    timestamptz not null default now()
);

create index if not exists knowledge_chunks_source_idx
  on knowledge_chunks (source_id, seq);
create index if not exists knowledge_chunks_agent_idx
  on knowledge_chunks (agent_id);

-- Episodic memory: one summarized, embedded row per RESOLVED conversation
-- (managed agents, >=2 user turns). Row id doubles as the Pinecone id.
create table if not exists conversation_summaries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  conversation_id uuid not null references conversations(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  subscriber_id   uuid not null references subscribers(id) on delete cascade,
  summary         text not null,
  embedding_dim   int,
  created_at      timestamptz not null default now(),
  unique (conversation_id)
);

create index if not exists conversation_summaries_subscriber_idx
  on conversation_summaries (agent_id, subscriber_id);

-- ---- Phase 24: long-term memory (subscriber profile) + cost ----
-- Durable per-(agent, subscriber) key/value facts the agent chooses to keep
-- for FUTURE conversations (a preference, plan, or constraint — never secrets).
-- Loaded (never searched) into every managed turn's system content as the
-- <customer_profile> section; the caps (<=32 keys, key<=64, value<=300) are
-- law, enforced in memories.repo, not here. Same (agent, subscriber) scoping as
-- episodic memory; cross-agent sharing is a later bucket. GDPR: deleting the
-- subscriber (or agent) cascades these rows away — provable in SQL.
create table if not exists subscriber_memories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  agent_id      uuid not null references agents(id) on delete cascade,
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  key           text not null,
  value         text not null,
  source        text not null default 'agent', -- agent | operator
  updated_at    timestamptz not null default now(),
  unique (agent_id, subscriber_id, key)
);

-- The profile load's hot path: one indexed range read per managed turn
-- (<=32 rows), the same class as the P23 corpus-existence probes.
create index if not exists subscriber_memories_scope_idx
  on subscriber_memories (agent_id, subscriber_id);

-- Per-agent free-form config bag. Slice B (rolling summarization) reads the
-- trigger knobs {triggerTurns?, tailTurns?} from here; slice A only lands the
-- column so the shape is in place.
alter table agents add column if not exists context jsonb not null default '{}';

-- D5 rolling summarization state on the conversation (no new table). As a long
-- managed conversation grows past the trigger, older turns are folded into
-- rolling_summary (a system-block summary, NEVER replayed as an assistant
-- turn); rolling_upto is the newest message id already folded, so the replay
-- loader takes rows strictly AFTER it and injects rolling_summary as the
-- <prior_conversation_summary> system section. The RESOLVE summary column
-- (conversations.summary) is a different signal and stays untouched.
alter table conversations add column if not exists rolling_summary text;
alter table conversations add column if not exists rolling_upto uuid;

-- ---- Phase 26 Slice A: HITL handoff ----
-- A durable, honest flag that a human teammate has engaged on this conversation
-- (set the moment the first operator reply flips waiting_human -> human). It
-- survives handback and the folding-away of the operator turns into the rolling
-- summary, so the post-handback per-turn reminder (D7) can warn the agent NOT to
-- claim to be a person WITHOUT a new query or a fragile string-match on the
-- summary text — the flag rides the conversation row already loaded per turn.
alter table conversations add column if not exists had_human boolean not null default false;

-- ---- Phase A4 Slice A: candidate (pre-save) eval runs ----
-- The config a run GRADED, verbatim: {systemPrompt?, model?}. Set only when the
-- run was started with an override (the dashboard's pre-save check runs the
-- agent's evals against the EDITED prompt before it is committed), so every
-- stored result is attributable to the config that produced it. NULL on every
-- ordinary run — pre-A4 rows and plain runs keep their exact previous shape.
alter table agent_eval_runs add column if not exists candidate jsonb;

-- ---- Phase A5 Slice A: prompt versioning ----
-- Every managed prompt/model save mints an IMMUTABLE snapshot, exactly the
-- template-versioning shape above (parent counter + (id, version) rows): the
-- agent row carries the live pointer, agent_prompt_versions carries the
-- history. Append-only — a restore is a NEW save that copies an old snapshot
-- forward, never a rewrite, so the trail of what the agent has ever said is
-- complete. Bridge agents get no rows (their brain is customer code behind a
-- signed URL — there is no prompt here to version); the guard is at write time.
-- Both snapshot columns are nullable: a managed agent may legitimately run with
-- no model (DEFAULT_MODEL applies) and the pre-edit state of a converted agent
-- may have neither.
alter table agents add column if not exists prompt_version int not null default 1;

create table if not exists agent_prompt_versions (
  agent_id      uuid not null references agents(id) on delete cascade,
  version       int  not null,
  system_prompt text,
  model         text,
  created_at    timestamptz not null default now(),
  primary key (agent_id, version)
);

-- ---- Phase A5 Slice B: canary ----
-- A trial of ONE past/other version on a slice of REAL traffic. The agent row
-- carries the whole config (at most one active canary per agent, so a column
-- trio beats a table): canary_version = which agent_prompt_versions row is on
-- trial, canary_percent = the share of NEWLY OPENED conversations that get it,
-- canary_started_at = when the trial began (the dashboard's "started 2h ago"
-- and slice C's window floor for per-arm counters). All three null/non-null
-- together; canary_version IS NULL is the single authoritative "no active
-- canary" test. Managed agents only — a bridge agent has no prompt to trial.
alter table agents add column if not exists canary_version    int;
alter table agents add column if not exists canary_percent    int;
alter table agents add column if not exists canary_started_at timestamptz;

-- Which arm this conversation was assigned when it OPENED: 'canary' | 'control'
-- | null (opened while no canary was active). Rolled exactly once, on the
-- INSERT branch of the find-or-create upsert (see openConversation), and never
-- written again — stickiness is structural, not a rule someone has to remember:
-- a customer never meets two personalities in one thread. No CHECK constraint,
-- matching this file's own precedent for `conversations.status` above: the
-- TypeScript union in conversations.repo.ts is the enforced surface.
alter table conversations add column if not exists canary_arm text;

-- Slice C's per-arm counters group live conversations by arm. Partial (the vast
-- majority of rows are arm-null, i.e. opened outside any trial) so the index
-- stays proportional to conversations actually under trial, not to table size.
create index if not exists conversations_canary_arm_idx
  on conversations (agent_id, canary_arm)
  where canary_arm is not null;

-- ---- Phase A5 Slice C: the comparison ----
-- What share of REAL replies (both arms, same rate) get sampled for async LLM
-- judging while a trial runs. Null = the default (SAMPLE_PERCENT_DEFAULT in
-- conversations.repo.ts); 0 = counters only, judge nothing. Lives on the agent
-- beside the rest of the trial config because it IS trial config: Start sets
-- it and Stop/Promote clears it, so it stays null/non-null together with the
-- other three and `canary_version is null` remains the one authoritative
-- "no trial running" test everywhere in this file.
alter table agents add column if not exists canary_sample_percent int;

-- One row per (judged reply, dimension). RAW SCORES ONLY — no pass/fail
-- column, deliberately: an eval scenario has an author-declared bar to clear,
-- but a canary has no bar. The question is "is the trial version better or
-- worse than live", and that is answered by comparing AVERAGES between arms,
-- so storing a verdict here would invent a threshold nobody set.
--
-- ATTRIBUTION — `arm` records which config ACTUALLY SERVED the turn, not which
-- arm the conversation was enrolled in. The two disagree after a Stop: a
-- thread enrolled in the trial keeps conversations.canary_arm='canary' but its
-- later turns run the LIVE prompt (see slice B's revert semantics), and
-- counting those as canary evidence would credit the trial version for replies
-- it never wrote. So such a turn is stored arm='control', canary_version null
-- — it is a live-prompt observation, which is exactly what the control arm
-- measures. Nothing is lost: the enrollment fact is still recoverable by
-- joining conversations.canary_arm. `canary_version` is non-null iff
-- arm='canary', and it is what scopes a report to THIS trial rather than to a
-- previous trial of a different version.
create table if not exists agent_turn_judgments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  agent_id        uuid not null references agents(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id      uuid not null references conversation_messages(id) on delete cascade,
  arm             text not null,               -- 'canary' | 'control' (what SERVED it)
  canary_version  int,                         -- non-null iff arm = 'canary'
  dim             text not null,               -- 'groundedness' | 'tone'
  score           int  not null,               -- 1-5
  rationale       text,
  created_at      timestamptz not null default now(),
  -- The idempotency wall. A re-enqueued judge job (BullMQ retry, or a second
  -- roll on a redelivered turn) re-judges the same reply and lands here; the
  -- conflict is swallowed, so one reply can never be counted twice and skew an
  -- average. Also the reason the writer is a single multi-row insert.
  unique (message_id, dim)
);

-- The report's only access path: every judgment for one agent since the
-- trial's started_at, grouped by arm+dim. agent_id leads (a report is always
-- for one agent) and created_at gives the window an index range scan instead
-- of a scan of the agent's whole judging history.
create index if not exists agent_turn_judgments_report_idx
  on agent_turn_judgments (agent_id, created_at);

-- ---- Phase A6 slice A: model routing ----
-- Per-agent cheap-first routing config, or null = off (the overwhelming
-- majority of rows, so a nullable jsonb costs those rows nothing). Shape is
-- owned by `RoutingConfig` in src/core/managed-brain.ts — the brain is what
-- applies it — and is deliberately TWO fields:
--   { "enabled": true, "cheapModel": "glm-4.6-flash" }
-- One cheap model, one switch: the escalation law is binary (did the model
-- reach for a consequential tool), so a binary router is the honest shape.
-- No default cheap model: the id must be one the agent's OWN endpoint serves
-- (routing rides agent.llm_base_url + the agent's key), and a guessed id is a
-- 400 on every turn — i.e. a 100% escalation rate. jsonb rather than two
-- columns so tiers can grow later without another migration.
alter table agents add column if not exists routing jsonb;

-- ---- Phase A7 slice A: the topic gate ----
-- Per-agent topic policy, or null = off (the overwhelming majority of rows —
-- the gate is opt-in, and an agent born without it behaves exactly as it did
-- before A7). Shape is owned by `TopicsConfig` in src/core/managed-brain.ts,
-- beside RoutingConfig, because the turn path is what applies it:
--   { "deny": ["medical advice"], "allow": [], "redirect": "I can only help with orders." }
-- THREE fields, and the gate applies only when the row is coherent: at least
-- one of the two lists non-empty AND a redirect to send. A deny list with no
-- redirect is not a policy, it is a mute button — enforced in code
-- (resolveTopics), never assumed, because jsonb can hold anything.
-- deny BEATS allow: a label named in both is denied, so the safer list wins the
-- one case where an operator contradicts themselves.
-- The redirect is CANNED text, never model freestyle: the whole point of the
-- gate is that an off-topic turn never reaches a model that could answer it.
alter table agents add column if not exists topics jsonb;
