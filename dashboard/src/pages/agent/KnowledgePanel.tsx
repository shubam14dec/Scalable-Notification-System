// Knowledge tab — per-agent RAG sources (managed agents): list with status
// dots, add pasted text or a URL, re-index, delete. Polls every 30s while any
// source is still pending/indexing (live via knowledge.changed hints otherwise).
// Same query key (['agent-knowledge', identifier]) and paths as the former modal.
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Field, Input, Mono, Skeleton } from '../../ui';
import { timeAgo } from '../Activity';
import { KNOWLEDGE_STATUS, MAX_KNOWLEDGE_FILE_BYTES, type Agent, type KnowledgeSource } from './types';

function KnowledgeStatus({ status }: { status: KnowledgeSource['status'] }) {
  const s = KNOWLEDGE_STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-t2">
      <span
        aria-hidden
        className={`inline-block h-[7px] w-[7px] rounded-full ${s.pulse ? 'animate-pulse' : ''}`}
        style={{ background: s.color }}
      />
      {s.label}
    </span>
  );
}

export function KnowledgePanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'text' | 'url'>('text');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileNote, setFileNote] = useState('');
  const [configError, setConfigError] = useState('');
  const [actionError, setActionError] = useState('');

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-knowledge', agent.identifier] });

  const { data, isLoading } = useQuery({
    queryKey: ['agent-knowledge', agent.identifier],
    queryFn: () => api<{ sources: KnowledgeSource[] }>(`/v1/agents/${agent.identifier}/knowledge`),
    // Phase 25 D8: live via knowledge.changed hints; 30s conditional fallback
    // while a source is still pending/indexing (was 3s).
    refetchInterval: (query) => {
      const sources = query.state.data?.sources ?? [];
      return sources.some((s) => s.status === 'pending' || s.status === 'indexing') ? 30_000 : false;
    },
  });

  const resetForm = () => {
    setName('');
    setKind('text');
    setText('');
    setUrl('');
    setFileNote('');
    setAdding(false);
  };

  const add = useMutation({
    mutationFn: (body: { name: string; kind: 'text' | 'url'; text?: string; url?: string }) =>
      api(`/v1/agents/${agent.identifier}/knowledge`, { method: 'POST', body }),
    onSuccess: () => {
      setConfigError('');
      setActionError('');
      resetForm();
      invalidate();
    },
    onError: (err) => {
      // A 400 names the missing config ("embeddings" / "vector store") — surface
      // it verbatim with a pointer to Integrations; other errors show inline.
      if (err instanceof ApiError && err.status === 400) setConfigError(err.message);
      else setActionError(err.message);
    },
  });

  const reindex = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/agents/${agent.identifier}/knowledge/${id}/reindex`, { method: 'POST' }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: boolean }>(`/v1/agents/${agent.identifier}/knowledge/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      setFileNote(`${file.name} is larger than 1 MB — paste the most relevant sections instead.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ''));
      if (!name.trim()) setName(file.name.replace(/\.(txt|md)$/i, ''));
      setFileNote(`Loaded ${file.name}.`);
    };
    reader.onerror = () => setFileNote(`Could not read ${file.name}.`);
    reader.readAsText(file);
  };

  const canSubmit = name.trim() !== '' && (kind === 'text' ? text.trim() !== '' : url.trim() !== '');
  const sources = data?.sources ?? [];

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Sources this agent can search and cite mid-conversation. Paste your policies or docs, or
        point at a public URL; the agent answers from them with [source: …] citations.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : sources.length > 0 ? (
        <ul className="space-y-3">
          {sources.map((s) => (
            <li key={s.id} className="border-b border-bd pb-3 last:border-0 last:pb-0">
              <div className="min-w-0">
                <Mono className="text-t1">{s.name}</Mono>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <span className="text-[12px] text-t3">{s.kind}</span>
                  <KnowledgeStatus status={s.status} />
                  <Mono className="text-t3">{s.chunkCount} chunks</Mono>
                  <Mono className="text-t3">{timeAgo(s.updatedAt)}</Mono>
                </div>
                {s.status === 'error' && s.error && (
                  <span
                    className="mt-1 block max-w-[280px] truncate font-mono text-[12px] text-t3"
                    title={s.error}
                  >
                    {s.error}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                <Button
                  variant="ghost"
                  onClick={() => reindex.mutate(s.id)}
                  disabled={s.status === 'pending' || s.status === 'indexing'}
                >
                  Re-index
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Delete source "${s.name}"?`)) remove.mutate(s.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !adding && (
          <div className="rounded-md border border-bd bg-elevated px-4 py-6 text-center">
            <p className="text-t2">No knowledge yet.</p>
            <p className="mx-auto mt-1 max-w-xs text-[12px] text-t3">
              Paste your policies or docs and the agent will answer from them — with citations.
            </p>
          </div>
        )
      )}

      {configError && (
        <div className="mt-3 rounded-md border border-bd bg-elevated p-3">
          <p className="text-[12px] text-err">{configError}</p>
          <button
            className="mt-1.5 text-[12px] text-t2 underline-offset-2 hover:text-t1 hover:underline"
            onClick={() => navigate('/integrations')}
          >
            Configure Embeddings and Pinecone on the Integrations page first.
          </button>
        </div>
      )}

      {adding ? (
        <form
          className="mt-4 space-y-4 border-t border-bd pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(
              kind === 'text'
                ? { name: name.trim(), kind, text }
                : { name: name.trim(), kind, url: url.trim() },
            );
          }}
        >
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="returns-policy"
              autoFocus
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-t2">Kind</span>
            <div className="inline-flex rounded-md border border-bd p-0.5">
              {(['text', 'url'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`h-7 rounded px-3 text-[12px] transition-colors ${
                    kind === k ? 'bg-invert text-invert-t' : 'text-t2 hover:text-t1'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {kind === 'text' ? (
            <Field label="Text">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                className="w-full rounded-md border border-bd bg-transparent p-2.5 font-mono text-[12px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
                placeholder="Paste your policy or doc text…"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={(e) => {
                    onFile(e.target.files?.[0]);
                    e.currentTarget.value = '';
                  }}
                />
                <Button type="button" onClick={() => fileInputRef.current?.click()}>
                  Load from file
                </Button>
                {fileNote && <span className="text-[11px] text-t3">{fileNote}</span>}
              </div>
            </Field>
          ) : (
            <Field label="URL" hint="Must be publicly reachable; we fetch and index the page text.">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                placeholder="https://acme.com/returns"
              />
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" onClick={resetForm}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!canSubmit || add.isPending}>
              {add.isPending ? 'Adding…' : 'Add source'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex justify-end border-t border-bd pt-4">
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add source
          </Button>
        </div>
      )}
    </div>
  );
}
