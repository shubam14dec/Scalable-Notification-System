// Shared React atoms/hooks for the per-agent detail panels. Extracted verbatim
// from the former Agents.tsx — same react-query keys, same API paths.
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, CopyField, Modal, Mono } from '../../ui';
import type { EvalRun } from './types';

/** Monochrome switch — same idiom as the workflow step drawer. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 ${
        checked ? 'border-transparent bg-invert' : 'border-bd bg-elevated hover:border-bd-strong'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-150 ${
          checked ? 'translate-x-[18px] bg-invert-t' : 'translate-x-[3px] bg-t3'
        }`}
      />
    </button>
  );
}

/**
 * Runs list for an agent, newest first. Polls every 2s while the latest run is
 * still running, then goes quiet — shared by the panel and the save-gate.
 */
export function useEvalRuns(identifier: string, enabled: boolean) {
  return useQuery({
    queryKey: ['agent-eval-runs', identifier],
    queryFn: () => api<{ runs: EvalRun[] }>(`/v1/agents/${identifier}/evals/runs`),
    enabled,
    // Phase 25 D8: live via eval.finished hints; 30s conditional fallback while
    // the latest run is still running (was 2s).
    refetchInterval: (query) => {
      const latest = query.state.data?.runs?.[0];
      return latest && latest.status === 'running' ? 30_000 : false;
    },
  });
}

/** Shown once after create/rotate — the same doctrine as API keys. */
export function SecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Signing secret">
      <p className="mb-3 text-[12px] text-t2">
        Give this to your agent's handler (<Mono>createHandler</Mono> from{' '}
        <Mono>@asyncify-hq/agent</Mono>). It is shown only once — rotate it if lost.
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
