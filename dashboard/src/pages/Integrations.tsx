import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Skeleton,
  td,
  th,
} from '../ui';

interface Integration {
  id: string;
  channel: string;
  provider: string;
  isPrimary: boolean;
  fallbackOrder: number;
  active: boolean;
}

/** Credential form fields per provider (mirrors the API's validation schemas). */
const PROVIDER_FIELDS: Record<
  string,
  { channel: string; fields: Array<{ key: string; label: string; type?: string; textarea?: boolean }> }
> = {
  smtp: {
    channel: 'email',
    fields: [
      { key: 'host', label: 'Host' },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'from', label: 'From address' },
      { key: 'user', label: 'Username (optional)' },
      { key: 'pass', label: 'Password (optional)', type: 'password' },
    ],
  },
  sendgrid: {
    channel: 'email',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password' },
      { key: 'from', label: 'From address' },
    ],
  },
  resend: {
    channel: 'email',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password' },
      { key: 'from', label: 'From address' },
    ],
  },
  twilio: {
    channel: 'sms',
    fields: [
      { key: 'accountSid', label: 'Account SID' },
      { key: 'authToken', label: 'Auth token', type: 'password' },
      { key: 'from', label: 'From number' },
    ],
  },
  fcm: {
    channel: 'push',
    fields: [{ key: 'serviceAccountJson', label: 'Service account JSON', textarea: true }],
  },
};

export default function IntegrationsPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [provider, setProvider] = useState('smtp');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<{ integrations: Integration[] }>('/v1/integrations'),
  });

  const install = useMutation({
    mutationFn: (body: { channel: string; provider: string; credentials: Record<string, unknown> }) =>
      api('/v1/integrations', { method: 'POST', body }),
    onSuccess: () => {
      setAddOpen(false);
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (err) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/integrations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['integrations'] }),
  });

  const spec = PROVIDER_FIELDS[provider];

  return (
    <>
      <PageHeader
        title="Integrations"
        action={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            Add integration
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.integrations.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Provider</th>
                <th className={th}>Channel</th>
                <th className={th}>Role</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.integrations.map((i) => (
                <tr key={i.id} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <Mono>{i.provider}</Mono>
                  </td>
                  <td className={td}>
                    <span className="text-t2">{i.channel}</span>
                  </td>
                  <td className={td}>
                    <span className="text-[12px] text-t2">
                      {i.isPrimary ? 'primary' : `fallback #${i.fallbackOrder}`}
                    </span>
                  </td>
                  <td className={td}>
                    <span className="text-[12px] text-t2">{i.active ? 'active' : 'disabled'}</span>
                  </td>
                  <td className={`${td} text-right`}>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Remove ${i.provider}? Sends will use the next provider in the chain.`)) {
                          remove.mutate(i.id);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No integrations installed"
          body="Connect your own provider accounts (SendGrid, Twilio, FCM…). Until then, sends use the built-in defaults."
        />
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add integration">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const credentials: Record<string, unknown> = {};
            for (const f of spec.fields) {
              const raw = String(form.get(f.key) ?? '').trim();
              if (raw === '') continue;
              credentials[f.key] = f.type === 'number' ? Number(raw) : raw;
            }
            install.mutate({ channel: spec.channel, provider, credentials });
          }}
        >
          <Field label="Provider">
            <select
              className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {Object.entries(PROVIDER_FIELDS).map(([slug, s]) => (
                <option key={slug} value={slug} className="bg-surface">
                  {slug} ({s.channel})
                </option>
              ))}
            </select>
          </Field>
          {spec.fields.map((f) =>
            f.textarea ? (
              <Field key={f.key} label={f.label}>
                <textarea
                  name={f.key}
                  rows={5}
                  className="w-full rounded-md border border-bd bg-transparent p-2.5 font-mono text-[12px] text-t1 placeholder:text-t3 hover:border-bd-strong"
                  placeholder="{ ... }"
                />
              </Field>
            ) : (
              <Field key={f.key} label={f.label}>
                <Input name={f.key} type={f.type ?? 'text'} />
              </Field>
            ),
          )}
          {error && <p className="text-[12px] text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={install.isPending}>
              {install.isPending ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
