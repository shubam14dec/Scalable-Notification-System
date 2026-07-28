// Tools tab — per-agent tools: list, add/edit, rotate secret, delete. Managed
// agents only. ToolFormModal + ToolSecretReveal kept as modals opened from the
// panel. All query keys and API paths identical to the former ToolsModal.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, CopyField, Field, Input, Modal, Mono, Skeleton, StatusBadge } from '../../ui';
import { Toggle } from './shared';
import {
  buildGuard,
  parseParams,
  TEXTAREA_CLS,
  type Agent,
  type Tool,
  type ToolCreateBody,
  type ToolPatchBody,
} from './types';

/** Tool signing secret — shown once after create or rotate. */
function ToolSecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Tool signing secret">
      <p className="mb-3 text-[12px] text-t2">
        Copy it now — used to verify our signed calls to your endpoint; you won't see it again.
      </p>
      <CopyField value={secret} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          I saved it
        </Button>
      </div>
    </Modal>
  );
}

/** Create or edit a single tool. Name is immutable after create. */
function ToolFormModal({
  agent,
  tool,
  onClose,
  onCreated,
  onUpdated,
}: {
  agent: Agent;
  tool: Tool | null;
  onClose: () => void;
  onCreated: (secret: string) => void;
  onUpdated: () => void;
}) {
  const editing = Boolean(tool);
  const [name, setName] = useState(tool?.name ?? '');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [params, setParams] = useState(
    tool
      ? JSON.stringify(tool.parameters, null, 2)
      : '{\n  "type": "object",\n  "properties": {}\n}',
  );
  const [endpointUrl, setEndpointUrl] = useState(tool?.endpointUrl ?? '');
  const [approvalRequired, setApprovalRequired] = useState(tool?.approval === 'required');
  const [timeoutMs, setTimeoutMs] = useState(String(tool?.timeoutMs ?? 10000));
  const [enabled, setEnabled] = useState(tool ? tool.status === 'active' : true);
  const [guardMaxAuto, setGuardMaxAuto] = useState(
    tool?.guard?.maxAutoCalls != null ? String(tool.guard.maxAutoCalls) : '',
  );
  const [guardWindowDays, setGuardWindowDays] = useState(
    tool?.guard?.windowDays != null ? String(tool.guard.windowDays) : '',
  );
  const [guardPerHour, setGuardPerHour] = useState(
    tool?.guard?.maxCallsPerHour != null ? String(tool.guard.maxCallsPerHour) : '',
  );
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: (body: ToolCreateBody) =>
      api<{ tool: Tool; secret: string }>(`/v1/agents/${agent.identifier}/tools`, {
        method: 'POST',
        body,
      }),
    onSuccess: (res) => onCreated(res.secret),
    onError: (err) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: (body: ToolPatchBody) =>
      api<{ tool: Tool }>(`/v1/agents/${agent.identifier}/tools/${tool!.id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => onUpdated(),
    onError: (err) => setError(err.message),
  });

  const pending = create.isPending || update.isPending;

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${tool!.name}` : 'New tool'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!editing && !/^[a-z][a-z0-9_]*$/.test(name.trim())) {
            setError('Name must match ^[a-z][a-z0-9_]*$.');
            return;
          }
          const parsed = parseParams(params);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          const t = Number.parseInt(timeoutMs, 10);
          if (!Number.isFinite(t) || t < 1000 || t > 30000) {
            setError('Timeout must be between 1000 and 30000 ms.');
            return;
          }
          const guardResult = buildGuard(guardMaxAuto, guardWindowDays, guardPerHour);
          if (!guardResult.ok) {
            setError(guardResult.error);
            return;
          }
          if (editing) {
            update.mutate({
              description: description.trim(),
              parameters: parsed.value,
              endpointUrl: endpointUrl.trim(),
              approval: approvalRequired ? 'required' : 'auto',
              timeoutMs: t,
              status: enabled ? 'active' : 'disabled',
              // PATCH is a full replace — send null to clear a removed guard.
              guard: guardResult.guard ?? null,
            });
          } else {
            create.mutate({
              name: name.trim(),
              description: description.trim(),
              parameters: parsed.value,
              endpointUrl: endpointUrl.trim(),
              approval: approvalRequired ? 'required' : 'auto',
              timeoutMs: t,
              // Omitted entirely when all guard fields are blank.
              guard: guardResult.guard,
            });
          }
        }}
      >
        {editing ? (
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-t2">Name</span>
            <Mono className="text-t2">{tool!.name}</Mono>
            <span className="mt-1 block text-[11px] text-t3">The name is fixed after creation.</span>
          </div>
        ) : (
          <Field label="Name" hint="Immutable after create — ^[a-z][a-z0-9_]*$">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="lookup_order"
              pattern="[a-z][a-z0-9_]*"
              className="font-mono"
            />
          </Field>
        )}

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 1024))}
            rows={3}
            required
            placeholder="Look up the status of a customer order by its id."
            className={TEXTAREA_CLS}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[11px] text-t3">
              The model reads this to decide WHEN to call the tool.
            </span>
            <Mono className="text-t3">{description.length}/1024</Mono>
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Parameters</span>
          <textarea
            value={params}
            onChange={(e) => setParams(e.target.value)}
            rows={6}
            spellCheck={false}
            className={`${TEXTAREA_CLS} font-mono`}
          />
          <span className="mt-1 block text-[11px] text-t3">
            JSON Schema object describing the arguments the model must supply.
          </span>
        </div>

        <Field label="Endpoint URL" hint="We POST the tool call here, signed with the secret below">
          <Input
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            required
            type="url"
            placeholder="https://app.example.com/tools/lookup-order"
            className="font-mono"
          />
        </Field>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12px] font-medium text-t2">Require human approval</span>
            <span className="mt-1 block text-[11px] text-t3">
              When on, this tool pauses on the Approvals page before it runs.
            </span>
          </div>
          <Toggle
            checked={approvalRequired}
            onChange={setApprovalRequired}
            label="Require human approval before this tool runs"
          />
        </div>

        <Field label="Timeout (ms)" hint="How long we wait for your endpoint — 1000–30000">
          <Input
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            type="number"
            min={1000}
            max={30000}
            className="font-mono"
          />
        </Field>

        {/* Phase 22 guardrails — deterministic limits the executor enforces. */}
        <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
          <div>
            <span className="block text-[12px] font-medium text-t2">Guardrails</span>
            <span className="mt-0.5 block text-[11px] text-t3">
              Optional per-customer limits. Leave blank to turn a limit off.
            </span>
          </div>
          <Field
            label="Max auto-executes"
            hint="After this many automatic runs per customer in the window, further runs need human approval."
          >
            <Input
              value={guardMaxAuto}
              onChange={(e) => setGuardMaxAuto(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
          <Field
            label="Window (days)"
            hint="The rolling window the auto-execute count is measured over."
          >
            <Input
              value={guardWindowDays}
              onChange={(e) => setGuardWindowDays(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
          <Field
            label="Max calls per hour per customer"
            hint="Hard cap per customer each hour — extra calls return a rate-limit error the agent explains, no approval."
          >
            <Input
              value={guardPerHour}
              onChange={(e) => setGuardPerHour(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
        </div>

        {editing && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[12px] font-medium text-t2">Enabled</span>
              <span className="mt-1 block text-[11px] text-t3">
                Disabled tools stay defined but the model can't call them.
              </span>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label="Tool enabled" />
          </div>
        )}

        {error && <p className="text-[12px] text-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create tool'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Per-agent tools: list, add/edit, rotate secret, delete. Managed agents only. */
export function ToolsPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<Tool | 'new' | null>(null);
  const [secret, setSecret] = useState('');
  const [actionError, setActionError] = useState('');

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-tools', agent.identifier] });

  const { data, isLoading } = useQuery({
    queryKey: ['agent-tools', agent.identifier],
    queryFn: () => api<{ tools: Tool[] }>(`/v1/agents/${agent.identifier}/tools`),
  });

  const rotate = useMutation({
    mutationFn: (toolId: string) =>
      api<{ secret: string }>(`/v1/agents/${agent.identifier}/tools/${toolId}/rotate-secret`, {
        method: 'POST',
      }),
    onSuccess: (res) => setSecret(res.secret),
    onError: (err) => setActionError(err.message),
  });

  const remove = useMutation({
    mutationFn: (toolId: string) =>
      api<{ deleted: true }>(`/v1/agents/${agent.identifier}/tools/${toolId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Tools let this managed agent call your endpoints mid-conversation. The model decides when,
        using each tool's description; tools marked "needs approval" pause on the Approvals page.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : data && data.tools.length > 0 ? (
        <ul className="space-y-3">
          {data.tools.map((t) => (
            <li key={t.id} className="border-b border-bd pb-3 last:border-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Mono className="text-t1">{t.name}</Mono>
                  <div className="mt-1 flex items-center gap-3">
                    {t.approval === 'required' ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-t2">
                        <span
                          aria-hidden
                          className="inline-block h-[7px] w-[7px] rounded-full"
                          style={{ background: 'var(--warn)' }}
                        />
                        needs approval
                      </span>
                    ) : (
                      <span className="text-[12px] text-t3">auto</span>
                    )}
                    <StatusBadge status={t.status} />
                  </div>
                  <Mono className="mt-1 block max-w-[260px] truncate text-t3">{t.endpointUrl}</Mono>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                <Button variant="ghost" onClick={() => setFormFor(t)}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => rotate.mutate(t.id)}>
                  Rotate secret
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Delete tool "${t.name}"?`)) remove.mutate(t.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No tools yet. Add one to let this agent call your code.</p>
      )}

      <div className="mt-4 flex justify-end border-t border-bd pt-4">
        <Button variant="primary" onClick={() => setFormFor('new')}>
          Add tool
        </Button>
      </div>

      {formFor && (
        <ToolFormModal
          agent={agent}
          tool={formFor === 'new' ? null : formFor}
          onClose={() => setFormFor(null)}
          onCreated={(s) => {
            setFormFor(null);
            setSecret(s);
            invalidate();
          }}
          onUpdated={() => {
            setFormFor(null);
            invalidate();
          }}
        />
      )}
      {secret && <ToolSecretReveal secret={secret} onClose={() => setSecret('')} />}
    </div>
  );
}
