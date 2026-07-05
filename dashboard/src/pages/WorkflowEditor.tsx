import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, Field, Input, PageHeader, Skeleton } from '../ui';
import { SendTestModal } from '../components/SendTest';

interface Step {
  channel: string;
  subject?: string;
  body: string;
  delaySeconds?: number;
  digest?: { windowSeconds: number; itemTemplate?: string };
}

const CHANNELS = ['email', 'inapp', 'sms', 'push'];
const NEW_STEP: Step = { channel: 'email', subject: '', body: '' };

function StepCard({
  step,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  step: Step;
  index: number;
  count: number;
  onChange: (next: Step) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-t3">step {index + 1}</span>
          <select
            aria-label="Channel"
            className="h-7 rounded-md border border-bd bg-transparent px-1.5 text-[12px] text-t1"
            value={step.channel}
            onChange={(e) => onChange({ ...step, channel: e.target.value })}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c} className="bg-surface">
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            aria-label="Move down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" aria-label="Remove step" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {step.channel !== 'sms' && (
          <Field label="Subject" hint="Supports {{variables}} from the trigger payload">
            <Input
              value={step.subject ?? ''}
              onChange={(e) => onChange({ ...step, subject: e.target.value })}
              placeholder="Welcome, {{name}}!"
            />
          </Field>
        )}
        <Field label="Body">
          <textarea
            rows={3}
            className="w-full rounded-md border border-bd bg-transparent p-2.5 text-[13px] text-t1 placeholder:text-t3 hover:border-bd-strong"
            value={step.body}
            onChange={(e) => onChange({ ...step, body: e.target.value })}
            placeholder="Hi {{name}}, thanks for joining."
          />
        </Field>
        {step.digest && !step.body.includes('digest_items') && (
          <p className="text-[12px]" style={{ color: 'var(--warn)' }}>
            Digest is on, but the body never uses {'{{digest_items}}'} or {'{{digest_count}}'} —
            merged events won't be visible in the message.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Delay (seconds)" hint="0 sends immediately">
            <Input
              type="number"
              min={0}
              value={step.delaySeconds ?? 0}
              onChange={(e) => onChange({ ...step, delaySeconds: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label="Digest window (seconds)" hint="Merge events in this window into one message">
            <Input
              type="number"
              min={0}
              value={step.digest?.windowSeconds ?? 0}
              onChange={(e) => {
                const seconds = Number(e.target.value) || 0;
                onChange({
                  ...step,
                  digest: seconds > 0 ? { ...step.digest, windowSeconds: seconds } : undefined,
                });
              }}
            />
          </Field>
        </div>
        {step.digest && (
          <Field label="Digest item template" hint="Rendered per merged event; use {{digest_items}} in the body">
            <Input
              value={step.digest.itemTemplate ?? ''}
              onChange={(e) =>
                onChange({
                  ...step,
                  digest: { ...step.digest!, itemTemplate: e.target.value || undefined },
                })
              }
              placeholder="- {{actor}} {{action}}"
            />
          </Field>
        )}
      </div>
    </Card>
  );
}

export default function WorkflowEditorPage() {
  const { key: routeKey } = useParams();
  const isNew = !routeKey;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<Step[]>([{ ...NEW_STEP }]);
  const [error, setError] = useState('');
  const [testOpen, setTestOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['workflow', routeKey],
    queryFn: () => api<{ workflow: { key: string; name: string; steps: Step[] } }>(`/v1/workflows/${routeKey}`),
    enabled: !isNew,
  });

  useEffect(() => {
    if (data) {
      setKey(data.workflow.key);
      setName(data.workflow.name);
      setSteps(data.workflow.steps);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const cleaned = steps.map((s) => ({
        channel: s.channel,
        subject: s.subject?.trim() || undefined,
        body: s.body,
        delaySeconds: s.delaySeconds || undefined,
        digest: s.digest?.windowSeconds ? s.digest : undefined,
      }));
      return api('/v1/workflows', { method: 'PUT', body: { key, name, steps: cleaned } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate('/workflows');
    },
    onError: (err) => setError(err.message),
  });

  if (!isNew && isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <>
      <PageHeader
        title={isNew ? 'New workflow' : `Edit ${routeKey}`}
        action={
          <div className="flex gap-2">
            {!isNew && <Button onClick={() => setTestOpen(true)}>Send test</Button>}
            <Button onClick={() => navigate('/workflows')}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!key || !name || steps.length === 0 || steps.some((s) => !s.body) || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save workflow'}
            </Button>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3">
        <Field label="Key" hint="Used in trigger calls; can't change after creation">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))}
            disabled={!isNew}
            placeholder="order-shipped"
            className="font-mono"
          />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Order shipped" />
        </Field>
      </div>

      <div className="space-y-3">
        {steps.map((step, i) => (
          <StepCard
            key={i}
            step={step}
            index={i}
            count={steps.length}
            onChange={(next) => setSteps(steps.map((s, j) => (j === i ? next : s)))}
            onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
            onMove={(dir) => {
              const next = [...steps];
              const [moved] = next.splice(i, 1);
              next.splice(i + dir, 0, moved);
              setSteps(next);
            }}
          />
        ))}
      </div>

      <div className="mt-3">
        <Button onClick={() => setSteps([...steps, { ...NEW_STEP }])}>
          <Plus className="h-3.5 w-3.5" /> Add step
        </Button>
      </div>

      {error && <p className="mt-3 text-[12px] text-err">{error}</p>}
      {testOpen && routeKey && <SendTestModal workflowKey={routeKey} onClose={() => setTestOpen(false)} />}
    </>
  );
}
