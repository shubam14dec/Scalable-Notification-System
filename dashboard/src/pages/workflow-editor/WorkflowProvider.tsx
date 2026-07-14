/**
 * Holds the workflow DRAFT for the whole editor surface — the canvas, the
 * timing drawer, and the full step page all read and mutate it through
 * useWorkflow(). Lives at the layout route so the draft survives navigation
 * between the canvas and a step's /editor page (the layout doesn't unmount).
 *
 * Save model: explicit. Edits mutate the in-memory draft and set `dirty`; the
 * header Save button PUTs the whole workflow (our backend takes the full doc).
 * We deliberately do NOT refetch after save — the local draft is the source of
 * truth for the session, so a server echo can't clobber unsaved edits.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { NEW_STEP, toApiSteps, type Step } from './types';

interface WorkflowContextValue {
  isNew: boolean;
  routeKey?: string;
  wfKey: string;
  setKey: (k: string) => void;
  name: string;
  setName: (n: string) => void;
  steps: Step[];
  templates: string[];
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  saveError: string;
  /** Guard: can the workflow be saved (has key, name, every step has content). */
  canSave: boolean;
  updateStep: (index: number, next: Step) => void;
  addStep: (atIndex: number, channel?: string) => void;
  removeStep: (index: number) => void;
  moveStep: (index: number, dir: -1 | 1) => void;
  save: () => void;
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export function useWorkflow(): WorkflowContextValue {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error('useWorkflow must be used inside <WorkflowProvider>');
  return ctx;
}

export function WorkflowProvider({
  routeKey,
  children,
}: {
  routeKey?: string;
  children: ReactNode;
}) {
  const isNew = !routeKey;
  const queryClient = useQueryClient();

  const [wfKey, setKey] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<Step[]>(isNew ? [{ ...NEW_STEP }] : []);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['workflow', routeKey],
    queryFn: () =>
      api<{ workflow: { key: string; name: string; steps: Step[] } }>(`/v1/workflows/${routeKey}`),
    enabled: !isNew,
  });

  const { data: templatesData } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<{ templates: Array<{ key: string }> }>('/v1/templates'),
  });
  const templates = useMemo(
    () => templatesData?.templates.map((t) => t.key) ?? [],
    [templatesData],
  );

  useEffect(() => {
    if (data) {
      setKey(data.workflow.key);
      setName(data.workflow.name);
      setSteps(data.workflow.steps.length ? data.workflow.steps : [{ ...NEW_STEP }]);
      setDirty(false);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api('/v1/workflows', { method: 'PUT', body: { key: wfKey, name, steps: toApiSteps(steps) } }),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  const value: WorkflowContextValue = {
    isNew,
    routeKey,
    wfKey,
    setKey: (k) => {
      setKey(k);
      setDirty(true);
    },
    name,
    setName: (n) => {
      setName(n);
      setDirty(true);
    },
    steps,
    templates,
    dirty,
    loading: !isNew && isLoading,
    saving: save.isPending,
    saveError,
    canSave:
      Boolean(wfKey) &&
      Boolean(name) &&
      steps.length > 0 &&
      steps.every((s) => s.body.trim() || s.templateKey),
    updateStep: (index, next) => {
      setSteps((prev) => prev.map((s, j) => (j === index ? next : s)));
      setDirty(true);
    },
    addStep: (atIndex, channel = 'email') => {
      setSteps((prev) => {
        const next = [...prev];
        next.splice(atIndex, 0, { ...NEW_STEP, channel });
        return next;
      });
      setDirty(true);
    },
    removeStep: (index) => {
      setSteps((prev) => prev.filter((_, j) => j !== index));
      setDirty(true);
    },
    moveStep: (index, dir) => {
      setSteps((prev) => {
        const next = [...prev];
        const target = index + dir;
        if (target < 0 || target >= next.length) return prev;
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        return next;
      });
      setDirty(true);
    },
    save: () => {
      setSaveError('');
      save.mutate();
    },
  };

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
