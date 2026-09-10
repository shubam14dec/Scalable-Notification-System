/**
 * Workflow flow editor — shell. Wraps the surface in WorkflowProvider (the
 * draft store) and lays out: a compact header (key/name + Save/Send test), the
 * flow canvas, and an <Outlet> that the step routes render into — the timing
 * drawer (steps/:index) as a right panel, the full step page
 * (steps/:index/editor) as a full cover. Each Outlet child owns its own
 * positioning, so one Outlet serves both.
 */
import { useEffect, useRef } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Button, Input, Mono, Skeleton } from '../../ui';
import { SendTestModal } from '../../components/SendTest';
import { useState } from 'react';
import { WorkflowProvider, useWorkflow } from './WorkflowProvider';
import { WorkflowCanvas } from './WorkflowCanvas';

function EditorShell() {
  const {
    isNew,
    routeKey,
    wfKey,
    setKey,
    name,
    setName,
    dirty,
    loading,
    saving,
    saveError,
    canSave,
    save,
  } = useWorkflow();
  const navigate = useNavigate();
  const [testOpen, setTestOpen] = useState(false);
  // For the pencil: ui.tsx's Input doesn't forward refs, so focus goes
  // through the wrapper.
  const nameBoxRef = useRef<HTMLDivElement>(null);

  // Warn on browser close/reload with unsaved edits. (In-app nav uses the
  // Cancel confirm below; useBlocker needs a data router we don't run.)
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    navigate('/workflows');
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-var(--shell-pad,7rem))] flex-col">
      {/* header */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={leave}
          aria-label="Back to workflows"
          className="grid h-8 w-8 place-items-center rounded-md text-t3 transition-colors hover:bg-elevated hover:text-t1"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          {/* The name is an input dressed as a heading, and nothing said so —
              the border only appeared on hover, so editability was
              undiscoverable (his catch). Two changes: the input now hugs its
              text (an invisible mirror span sets the width) so the pencil can
              sit right beside the words, and the pencil is the always-visible
              "this is editable" cue — clicking it focuses the field. */}
          <div className="flex min-w-0 items-center gap-1">
            <div ref={nameBoxRef} className="relative min-w-[8rem] max-w-full shrink">
              <span
                aria-hidden
                className="invisible block h-9 whitespace-pre px-1 text-[18px] font-semibold"
              >
                {name || 'Workflow name'}
              </span>
              <Input
                aria-label="Workflow name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Workflow name"
                className="absolute inset-0 !h-9 !border-transparent !px-1 !text-[18px] font-semibold hover:!border-bd focus:!border-bd-strong"
              />
            </div>
            <button
              type="button"
              aria-label="Edit workflow name"
              onClick={() => nameBoxRef.current?.querySelector('input')?.focus()}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-t3 transition-colors hover:bg-elevated hover:text-t1"
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </button>
          </div>
          <div className="flex items-center gap-2 px-1">
            {isNew ? (
              <input
                aria-label="Workflow key"
                value={wfKey}
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))}
                placeholder="workflow-key"
                className="bg-transparent font-mono text-[12px] text-t3 placeholder:text-t3 focus:text-t1 focus:outline-none"
              />
            ) : (
              <Mono className="text-t3">{wfKey}</Mono>
            )}
            {dirty && (
              <span className="inline-flex items-center gap-1 text-[11px] text-t3">
                <span
                  className="h-[6px] w-[6px] rounded-full"
                  style={{ background: 'var(--warn)' }}
                  aria-hidden
                />
                unsaved
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isNew && routeKey && <Button onClick={() => setTestOpen(true)}>Send test</Button>}
          <Button onClick={leave}>Cancel</Button>
          <Button variant="primary" disabled={!canSave || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {saveError && <p className="mb-2 text-[12px] text-err">{saveError}</p>}

      {/* canvas + step outlet (drawer / full page position themselves) */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-bd bg-app">
        <WorkflowCanvas />
        <Outlet />
      </div>

      {testOpen && routeKey && (
        <SendTestModal workflowKey={routeKey} onClose={() => setTestOpen(false)} />
      )}
    </div>
  );
}

export default function WorkflowEditorPage() {
  const { key } = useParams();
  return (
    <WorkflowProvider routeKey={key}>
      <EditorShell />
    </WorkflowProvider>
  );
}
