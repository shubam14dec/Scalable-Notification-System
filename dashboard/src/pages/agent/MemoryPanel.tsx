// Memory tab — per-agent, per-customer memory admin: enter a customer id, load
// their profile, inline-edit / delete facts or add new ones. A full profile
// (409) surfaces the current keys so an operator can overwrite instead of
// silently losing a fact. Same query key (['agent-memories', identifier, subId])
// and paths as the former MemoryModal.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Input, Mono, Skeleton } from '../../ui';
import { timeAgo } from '../Activity';
import type { Agent, Memory, MemoryCap } from './types';

/**
 * Source marker — monochrome (color is delivery-status only). 'agent' is a
 * filled dot, 'operator' a hollow ring; the label carries the meaning.
 */
function SourceTag({ source }: { source: 'agent' | 'operator' }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-t3"
      title={
        source === 'agent'
          ? 'saved by the agent with the remember tool'
          : 'set manually by an operator'
      }
    >
      <span
        aria-hidden
        className={`inline-block h-[7px] w-[7px] rounded-full ${
          source === 'agent' ? 'bg-t3' : 'border border-bd-strong'
        }`}
      />
      {source}
    </span>
  );
}

export function MemoryPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [subId, setSubId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [cap, setCap] = useState<MemoryCap | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const path = subId
    ? `/v1/agents/${agent.identifier}/memories/${encodeURIComponent(subId)}`
    : '';

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['agent-memories', agent.identifier, subId],
    queryFn: () => api<{ memories: Memory[] }>(path),
    enabled: Boolean(subId),
    retry: false,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: ['agent-memories', agent.identifier, subId],
    });

  const put = useMutation({
    mutationFn: (body: { key: string; value: string }) =>
      api<{ memory: Memory }>(path, { method: 'PUT', body }),
    onSuccess: () => {
      setCap(null);
      setActionError('');
      setNewKey('');
      setNewValue('');
      setEditKey(null);
      invalidate();
    },
    onError: (err) => {
      // A full profile is a 409, not a bug — show the current keys to overwrite.
      if (err instanceof ApiError && err.status === 409) {
        setCap((err.body as MemoryCap) ?? { error: err.message });
      } else {
        setActionError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    },
  });

  const del = useMutation({
    mutationFn: (key?: string) =>
      api<{ deleted: number }>(key ? `${path}?key=${encodeURIComponent(key)}` : path, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setActionError('');
      setCap(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : 'Delete failed.'),
  });

  const load = () => {
    const v = input.trim();
    if (!v) return;
    setSubId(v);
    setCap(null);
    setActionError('');
    setEditKey(null);
  };

  const memories = data?.memories ?? [];
  // A 404 here means "no such customer" — a teaching state, not an error banner.
  const unknownSubscriber = isError && error instanceof ApiError && error.status === 404;

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Durable facts this agent remembers about one customer across conversations — saved by the
        agent with its <Mono>remember</Mono> tool, or edited here. Enter a customer id to load their
        profile.
      </p>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <div className="flex-1">
          <Field label="Customer id">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="customer-50"
              autoFocus
              className="font-mono"
            />
          </Field>
        </div>
        <Button variant="primary" type="submit" disabled={!input.trim()}>
          Load
        </Button>
      </form>

      {actionError && <p className="mt-3 text-[12px] text-err">{actionError}</p>}

      {!subId ? (
        <div className="mt-4 rounded-md border border-bd bg-elevated px-4 py-6 text-center">
          <p className="text-t2">Enter a customer id to see what this agent remembers.</p>
          <p className="mx-auto mt-1 max-w-xs text-[12px] text-t3">
            Use the id your app assigns each customer — for example <Mono>customer-50</Mono>.
          </p>
        </div>
      ) : isLoading ? (
        <Skeleton className="mt-4 h-24 w-full" />
      ) : unknownSubscriber ? (
        <div className="mt-4 rounded-md border border-bd bg-elevated px-4 py-6 text-center">
          <p className="text-t2">
            No customer with id <Mono className="text-t1">{subId}</Mono>.
          </p>
          <p className="mx-auto mt-1 max-w-xs text-[12px] text-t3">
            A profile appears once that customer has messaged this agent. Check the id and try again.
          </p>
        </div>
      ) : isError ? (
        <p className="mt-4 text-[12px] text-err">
          Couldn't load memory — {error instanceof Error ? error.message : 'try again'}.
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-t3">
              {memories.length > 0 ? `Profile · ${subId}` : `No facts yet · ${subId}`}
            </p>
            {memories.length > 0 && (
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm(`Delete ALL remembered facts for "${subId}"?`))
                    del.mutate(undefined);
                }}
              >
                Delete all
              </Button>
            )}
          </div>

          {memories.length > 0 ? (
            <ul className="mt-3 space-y-3">
              {memories.map((m) => (
                <li key={m.key} className="border-b border-bd pb-3 last:border-0 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Mono className="text-t1">{m.key}</Mono>
                        <SourceTag source={m.source} />
                      </div>
                      {editKey === m.key ? (
                        <div className="mt-1.5 flex items-center gap-2">
                          <Input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value.slice(0, 300))}
                            autoFocus
                            className="flex-1"
                          />
                          <Mono className="shrink-0 text-t3">{editValue.length}/300</Mono>
                        </div>
                      ) : (
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-t2">
                          {m.value}
                        </p>
                      )}
                      <Mono className="mt-1 block text-t3">updated {timeAgo(m.updatedAt)}</Mono>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap justify-end gap-1">
                    {editKey === m.key ? (
                      <>
                        <Button variant="ghost" onClick={() => setEditKey(null)}>
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          onClick={() => put.mutate({ key: m.key, value: editValue })}
                          disabled={put.isPending || !editValue.trim()}
                        >
                          {put.isPending ? 'Saving…' : 'Save'}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditKey(m.key);
                            setEditValue(m.value);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            if (window.confirm(`Delete fact "${m.key}"?`)) del.mutate(m.key);
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 rounded-md border border-bd bg-elevated px-4 py-6 text-center">
              <p className="text-t2">Nothing remembered yet.</p>
              <p className="mx-auto mt-1 max-w-xs text-[12px] text-t3">
                The agent saves facts here with the <Mono>remember</Mono> tool — or add one manually
                below.
              </p>
            </div>
          )}

          {cap && (
            <div className="mt-3 rounded-md border border-bd bg-elevated p-3">
              <p className="text-[12px] text-err">
                This profile is full
                {cap.limits?.maxKeys ? ` (max ${cap.limits.maxKeys} facts)` : ''}. Overwrite one of
                the existing keys, or delete a fact first.
              </p>
              {cap.currentKeys && cap.currentKeys.length > 0 && (
                <p className="mt-1.5 break-words font-mono text-[11px] text-t3">
                  current keys: {cap.currentKeys.join(', ')}
                </p>
              )}
            </div>
          )}

          <form
            className="mt-4 space-y-3 border-t border-bd pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newKey.trim() || !newValue.trim()) return;
              put.mutate({ key: newKey.trim(), value: newValue.trim() });
            }}
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-t3">Add a fact</p>
            <Field label="Key" hint="Short snake_case label — e.g. preferred_channel">
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.slice(0, 64))}
                placeholder="preferred_channel"
                className="font-mono"
              />
            </Field>
            <Field label="Value" hint="Never store secrets or payment data. Up to 300 characters.">
              <Input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value.slice(0, 300))}
                placeholder="email"
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Mono className="text-t3">{newValue.length}/300</Mono>
              <Button
                variant="primary"
                type="submit"
                disabled={put.isPending || !newKey.trim() || !newValue.trim()}
              >
                {put.isPending ? 'Saving…' : 'Add fact'}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
