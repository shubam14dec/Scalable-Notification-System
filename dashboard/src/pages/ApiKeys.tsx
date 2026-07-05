import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, session } from '../lib/api';
import {
  Button,
  Card,
  CopyField,
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

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const envId = session.envId;
  const [createOpen, setCreateOpen] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', envId],
    queryFn: () =>
      api<{ apiKeys: ApiKey[] }>(`/v1/account/environments/${envId}/api-keys`),
    enabled: Boolean(envId),
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ apiKey: string }>(`/v1/account/environments/${envId}/api-keys`, {
        method: 'POST',
        body: { name },
      }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setFreshKey(res.apiKey);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      api(`/v1/account/environments/${envId}/api-keys/${keyId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <>
      <PageHeader
        title="API keys"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create key
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.apiKeys.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Key</th>
                <th className={th}>Created</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.apiKeys.map((k) => (
                <tr key={k.id} className="transition-colors hover:bg-elevated">
                  <td className={td}>{k.name}</td>
                  <td className={td}>
                    <Mono className="text-t2">{k.prefix}</Mono>
                  </td>
                  <td className={td}>
                    <Mono className="text-t3">{new Date(k.createdAt).toLocaleDateString()}</Mono>
                  </td>
                  <td className={td}>
                    {k.revokedAt ? (
                      <span className="text-[12px] text-t3">revoked</span>
                    ) : (
                      <span className="text-[12px] text-t2">active</span>
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    {!k.revokedAt && (
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (window.confirm(`Revoke "${k.name}"? Requests using it will fail immediately.`)) {
                            revoke.mutate(k.id);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No API keys"
          body="Create a key to trigger notifications from your backend. Keys are shown once and stored hashed."
        />
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(String(new FormData(e.currentTarget).get('name')) || 'default');
          }}
          className="space-y-4"
        >
          <Field label="Name" hint="Something that tells you where it's used, e.g. backend-prod">
            <Input name="name" autoFocus placeholder="backend-prod" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(freshKey)} onClose={() => setFreshKey(null)} title="Copy your new key">
        <p className="mb-3 text-t2">
          This is the only time the full key is shown. Store it somewhere safe.
        </p>
        {freshKey && <CopyField value={freshKey} />}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => setFreshKey(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </>
  );
}
