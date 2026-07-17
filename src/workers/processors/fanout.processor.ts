import { UnrecoverableError, type Job } from 'bullmq';
import { redis } from '../../shared/redis';
import { deliveryQueueName, getQueue } from '../../shared/queues';
import {
  getEvent,
  getWorkflow,
  insertMessage,
  insertMessagesBulk,
  suppressedSet,
  upsertSubscriber,
  type EventRow,
  type MessageRow,
  type NewMessage,
  type RecipientInput,
  type Subscriber,
  type Workflow,
  type WorkflowStep,
} from '../../db/repositories';
import {
  listDeviceTokensForSubscribers,
  type DeviceToken,
} from '../../db/device-tokens.repo';
import { render } from '../../core/render';
import { evaluateConditions } from '../../core/conditions';
import { renderSubject } from '../../core/email-template';
import { getTemplate, type TemplateRow } from '../../db/templates.repo';
import { logExec } from '../../core/execution-log';
import { traceCarrier, withSpan, type TraceCarrier } from '../../shared/tracing';

function addressFor(step: WorkflowStep, sub: Subscriber): Record<string, string> | null {
  switch (step.channel) {
    case 'email':
      return sub.email ? { email: sub.email } : null;
    case 'sms':
      return sub.phone ? { phone: sub.phone } : null;
    case 'push':
      // Push is multi-device: addresses come from the device_tokens table
      // (one message per device), resolved in the fan-out loop below, never
      // from the single legacy subscribers.push_token column.
      return null;
    case 'inapp':
      // Every subscriber has an inbox — no external address needed.
      return { inAppSubscriberId: sub.external_id };
  }
}

/**
 * Renders a push step's rich extras against the trigger vars at fan-out.
 * Every field is optional and dropped when empty or (for URLs) invalid after
 * rendering — FCM rejects empty/invalid fields, so we never snapshot them.
 */
function renderPushExtras(
  push: NonNullable<WorkflowStep['push']>,
  vars: Record<string, unknown>,
): { clickUrl?: string; imageUrl?: string; data?: Record<string, string> } | undefined {
  const out: { clickUrl?: string; imageUrl?: string; data?: Record<string, string> } = {};

  const clickUrl = push.clickUrl && renderUrl(push.clickUrl, vars);
  if (clickUrl) out.clickUrl = clickUrl;
  const imageUrl = push.imageUrl && renderUrl(push.imageUrl, vars);
  if (imageUrl) out.imageUrl = imageUrl;

  if (push.data) {
    const data: Record<string, string> = {};
    for (const [key, template] of Object.entries(push.data)) {
      const value = render(template, vars);
      if (value !== '') data[key] = value; // empty after render → omit
    }
    if (Object.keys(data).length > 0) out.data = data;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Render a URL field's vars; drop it if it's empty or no longer a valid URL. */
function renderUrl(template: string, vars: Record<string, unknown>): string | undefined {
  const value = render(template, vars).trim();
  if (!value) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    return undefined;
  }
}

/** The vendor-facing address a suppression can apply to (none for in-app). */
function suppressibleAddress(to: Record<string, string>): string | undefined {
  return to.email ?? to.phone ?? to.pushToken;
}

/**
 * Stage 2: for each subscriber in the batch — upsert the subscriber, apply
 * preferences + suppressions, render content, persist message rows, enqueue
 * delivery jobs.
 *
 * Built for broadcast scale:
 *  - ONE suppression query per batch (not per recipient x step)
 *  - ONE multi-row message insert per batch (not per message)
 *  - delivery jobs enqueued via addBulk, grouped per queue
 *
 * Idempotent end to end: message rows are deduped by a unique key and
 * delivery jobs by jobId = messageId, so a retried batch never double-sends.
 * Digest steps stay per-recipient — they are stateful (Redis windows).
 */
export async function processFanout(
  job: Job<{ eventId: string; recipients: RecipientInput[]; _trace?: TraceCarrier }>,
): Promise<void> {
  const event = await getEvent(job.data.eventId);
  if (!event) {
    throw new UnrecoverableError(`event ${job.data.eventId} not found`);
  }
  const workflow = await getWorkflow(event.tenant_id, event.workflow_key);
  if (!workflow) {
    throw new UnrecoverableError(`workflow ${event.workflow_key} not found`);
  }

  await withSpan(
    'fanout.process',
    {
      'notif.transaction_id': event.transaction_id,
      'notif.batch_size': job.data.recipients.length,
    },
    () => fanOutBatch(event, workflow, job.data.recipients),
    job.data._trace,
  );
}

interface PlannedMessage extends NewMessage {
  subscriberExternalId: string;
  delayMs?: number;
}

async function fanOutBatch(
  event: EventRow,
  workflow: Workflow,
  recipients: RecipientInput[],
): Promise<void> {
  const subscribers: Subscriber[] = [];
  for (const recipient of recipients) {
    subscribers.push(await upsertSubscriber(event.tenant_id, recipient));
  }

  // Push addresses live in device_tokens (multi-device). One batched read for
  // the whole batch if any step is push — never a per-subscriber query, this
  // runs at broadcast scale.
  const hasPushStep = workflow.steps.some((s) => s.channel === 'push');
  const devicesBySubscriber = hasPushStep
    ? await listDeviceTokensForSubscribers(event.tenant_id, subscribers.map((s) => s.id))
    : new Map<string, DeviceToken[]>();

  // One suppression lookup for the whole batch.
  const pairs: Array<{ channel: string; address: string }> = [];
  for (const sub of subscribers) {
    for (const step of workflow.steps) {
      if (step.channel === 'push') {
        // Each device token can be independently suppressed.
        for (const device of devicesBySubscriber.get(sub.id) ?? []) {
          pairs.push({ channel: 'push', address: device.token });
        }
        continue;
      }
      const to = addressFor(step, sub);
      const address = to && suppressibleAddress(to);
      if (address) pairs.push({ channel: step.channel, address });
    }
  }
  const suppressed = await suppressedSet(event.tenant_id, pairs);

  // Resolve referenced templates once per batch; the current version is
  // pinned into each message so later edits can't change in-flight sends.
  const templates = new Map<string, TemplateRow | null>();
  for (const step of workflow.steps) {
    if (step.templateKey && !templates.has(step.templateKey)) {
      templates.set(step.templateKey, await getTemplate(event.tenant_id, step.templateKey));
    }
  }

  const planned: PlannedMessage[] = [];

  for (const sub of subscribers) {
    const vars = {
      ...event.payload,
      subscriberId: sub.external_id,
      email: sub.email,
      phone: sub.phone,
    };

    for (const [stepIndex, step] of workflow.steps.entries()) {
      const base: NewMessage = {
        tenantId: event.tenant_id,
        eventId: event.id,
        subscriberId: sub.id,
        transactionId: event.transaction_id,
        channel: step.channel,
        stepIndex,
        priority: event.priority,
        content: { body: '', to: {} },
        status: 'queued',
        error: null,
      };

      if (sub.preferences.channels?.[step.channel] === false) {
        planned.push({
          ...base,
          subscriberExternalId: sub.external_id,
          status: 'skipped',
          error: 'channel disabled by subscriber preference',
        });
        continue;
      }

      // Step conditions: evaluated over payload + subscriber attributes.
      if (
        step.conditions &&
        step.conditions.length > 0 &&
        !evaluateConditions(step.conditions, {
          ...event.payload,
          subscriber: { id: sub.external_id, email: sub.email, phone: sub.phone },
        })
      ) {
        planned.push({
          ...base,
          subscriberExternalId: sub.external_id,
          status: 'skipped',
          error: 'step conditions not met',
        });
        continue;
      }

      // Push fans out to every registered device: one message per device,
      // discriminated by device_key. Preference/condition skips above already
      // emit a single row (device_key '') per subscriber, matching non-push.
      if (step.channel === 'push') {
        const devices = devicesBySubscriber.get(sub.id) ?? [];
        if (devices.length === 0) {
          planned.push({
            ...base,
            subscriberExternalId: sub.external_id,
            status: 'skipped',
            error: 'subscriber has no push address',
          });
          continue;
        }

        const pushExtras = step.push ? renderPushExtras(step.push, vars) : undefined;

        if (step.digest) {
          // v1 limitation: digest windows are keyed per-subscriber, so a
          // digested push reaches only the NEWEST device. Per-device digest
          // windows (multi-device digest fan-out) are future work.
          const device = devices[0];
          await handleDigestStep(
            event,
            sub,
            step,
            stepIndex,
            { pushToken: device.token, deviceId: device.id },
            vars,
          );
          continue;
        }

        for (const device of devices) {
          const to = { pushToken: device.token, deviceId: device.id };
          if (suppressed.has(`push\n${device.token}`)) {
            planned.push({
              ...base,
              subscriberExternalId: sub.external_id,
              deviceKey: device.id,
              content: { body: '', to },
              status: 'skipped',
              error: 'address suppressed (prior bounce/complaint)',
            });
            logExec({
              tenantId: event.tenant_id,
              transactionId: event.transaction_id,
              level: 'warn',
              detail: `skipped suppressed push token for ${sub.external_id}`,
            });
            continue;
          }
          planned.push({
            ...base,
            subscriberExternalId: sub.external_id,
            deviceKey: device.id,
            content: {
              subject: step.subject ? render(step.subject, vars) : undefined,
              body: render(step.body, vars),
              to,
              skipIfStep: step.skipIfStep,
              push: pushExtras,
            },
            delayMs: step.delaySeconds ? step.delaySeconds * 1000 : undefined,
          });
        }
        continue;
      }

      const to = addressFor(step, sub);
      if (!to) {
        planned.push({
          ...base,
          subscriberExternalId: sub.external_id,
          status: 'skipped',
          error: `subscriber has no ${step.channel} address`,
        });
        continue;
      }

      const address = suppressibleAddress(to);
      if (address && suppressed.has(`${step.channel}\n${address}`)) {
        planned.push({
          ...base,
          subscriberExternalId: sub.external_id,
          content: { body: '', to },
          status: 'skipped',
          error: 'address suppressed (prior bounce/complaint)',
        });
        logExec({
          tenantId: event.tenant_id,
          transactionId: event.transaction_id,
          level: 'warn',
          detail: `skipped suppressed ${step.channel} address for ${sub.external_id}`,
        });
        continue;
      }

      if (step.digest) {
        await handleDigestStep(event, sub, step, stepIndex, to, vars);
        continue;
      }

      // Template-based email step: pin key+version+vars; HTML renders at
      // delivery (keeps message rows small — MJML output is big).
      if (step.templateKey && step.channel === 'email') {
        const template = templates.get(step.templateKey);
        if (!template) {
          planned.push({
            ...base,
            subscriberExternalId: sub.external_id,
            status: 'skipped',
            error: `unknown template "${step.templateKey}"`,
          });
          continue;
        }
        planned.push({
          ...base,
          subscriberExternalId: sub.external_id,
          content: {
            subject: renderSubject(step.subject || template.subject, vars),
            body: '',
            to,
            skipIfStep: step.skipIfStep,
            template: { key: template.key, version: template.current_version, vars },
          },
          delayMs: step.delaySeconds ? step.delaySeconds * 1000 : undefined,
        });
        continue;
      }

      planned.push({
        ...base,
        subscriberExternalId: sub.external_id,
        content: {
          subject: step.subject ? render(step.subject, vars) : undefined,
          body: render(step.body, vars),
          to,
          skipIfStep: step.skipIfStep,
        },
        delayMs: step.delaySeconds ? step.delaySeconds * 1000 : undefined,
      });
    }
  }

  if (planned.length === 0) return;

  // One bulk insert; returned rows matched back by their unique key.
  const rows = await insertMessagesBulk(planned);
  const byKey = new Map<string, MessageRow>();
  for (const row of rows) {
    // device_key disambiguates the per-device rows a push step produces.
    byKey.set(`${row.subscriber_id}|${row.channel}|${row.step_index}|${row.device_key}`, row);
  }

  // Group delivery jobs per queue and enqueue with addBulk.
  const byQueue = new Map<
    string,
    Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }>
  >();

  for (const plan of planned) {
    if (plan.status !== 'queued') continue;
    const row = byKey.get(
      `${plan.subscriberId}|${plan.channel}|${plan.stepIndex}|${plan.deviceKey ?? ''}`,
    );
    if (!row || row.status !== 'queued') continue; // pre-existing row already past this stage

    const queueName = deliveryQueueName(plan.channel, event.priority);
    let jobs = byQueue.get(queueName);
    if (!jobs) {
      jobs = [];
      byQueue.set(queueName, jobs);
    }
    jobs.push({
      name: row.id,
      data: { messageId: row.id, _trace: traceCarrier() },
      opts: { jobId: row.id, delay: plan.delayMs },
    });
    logExec({
      tenantId: event.tenant_id,
      transactionId: event.transaction_id,
      messageId: row.id,
      level: 'info',
      detail: `queued ${plan.channel} message for ${plan.subscriberExternalId} (${event.priority})`,
    });
  }

  for (const [queueName, jobs] of byQueue) {
    await getQueue(queueName).addBulk(jobs);
  }
}

/** Digest steps are stateful (Redis windows) and stay per-recipient. */
async function handleDigestStep(
  event: EventRow,
  sub: Subscriber,
  step: WorkflowStep,
  stepIndex: number,
  to: Record<string, string>,
  vars: Record<string, unknown>,
): Promise<void> {
  const base = {
    tenantId: event.tenant_id,
    eventId: event.id,
    subscriberId: sub.id,
    transactionId: event.transaction_id,
    channel: step.channel,
    stepIndex,
    priority: event.priority,
  };

  const digestKey =
    `digest:${event.tenant_id}:${event.workflow_key}:${stepIndex}:${sub.external_id}`;
  const item = JSON.stringify({ ...event.payload, transactionId: event.transaction_id });
  // RPUSH is atomic: exactly one event sees length 1 and becomes the window
  // opener; everyone else merges. TTL is a safety net for lost jobs.
  const windowSize = await redis.rpush(digestKey, item);
  await redis.expire(digestKey, step.digest!.windowSeconds + 3600);

  if (windowSize > 1) {
    // Terminal 'merged' row: completes the audit trail and lets the
    // reconciler settle this event.
    await insertMessage({ ...base, content: { body: '', to }, status: 'merged' });
    logExec({
      tenantId: event.tenant_id,
      transactionId: event.transaction_id,
      level: 'info',
      detail: `merged into open digest window for ${sub.external_id} (size ${windowSize})`,
    });
    return;
  }

  const message = await insertMessage({
    ...base,
    content: {
      body: '',
      to,
      digest: {
        subjectTemplate: step.subject,
        bodyTemplate: step.body,
        itemTemplate: step.digest!.itemTemplate,
        vars,
      },
    },
  });
  if (message.status !== 'queued') return;

  await getQueue(deliveryQueueName(step.channel, event.priority)).add(
    message.id,
    { messageId: message.id, digestKey, _trace: traceCarrier() },
    { jobId: message.id, delay: step.digest!.windowSeconds * 1000 },
  );
  logExec({
    tenantId: event.tenant_id,
    transactionId: event.transaction_id,
    messageId: message.id,
    level: 'info',
    detail:
      `digest window opened for ${sub.external_id}, closes in ${step.digest!.windowSeconds}s`,
  });
}
