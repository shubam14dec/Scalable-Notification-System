import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Button, Card, EmptyState, Mono, PageHeader, Skeleton, td, th } from '../ui';
import { timeAgo } from './Activity';

interface WorkflowRow {
  id: string;
  key: string;
  name: string;
  stepCount: number;
  channels: string[];
  updatedAt: string;
}

const WORKFLOW_SNIPPET = `curl -X PUT https://your-api/v1/workflows \\
  -H "x-api-key: <your key>" -H "content-type: application/json" \\
  -d '{"key":"welcome","name":"Welcome flow","steps":[{"channel":"email","subject":"Hi {{name}}","body":"Welcome aboard."}]}'`;

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api<{ workflows: WorkflowRow[] }>('/v1/workflows'),
  });

  return (
    <>
      <PageHeader
        title="Workflows"
        action={
          <Button variant="primary" onClick={() => navigate('/workflows/new')}>
            New workflow
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.workflows.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Key</th>
                <th className={th}>Name</th>
                <th className={th}>Channels</th>
                <th className={th}>Steps</th>
                <th className={`${th} text-right`}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.workflows.map((w) => (
                <tr
                  key={w.id}
                  className="cursor-pointer transition-colors hover:bg-elevated"
                  onClick={() => navigate(`/workflows/${w.key}`)}
                >
                  <td className={td}>
                    <Mono>{w.key}</Mono>
                  </td>
                  <td className={td}>{w.name}</td>
                  <td className={td}>
                    <span className="flex gap-1.5">
                      {w.channels.map((c) => (
                        <span
                          key={c}
                          className="rounded border border-bd px-1.5 py-0.5 text-[11px] text-t2"
                        >
                          {c}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={td}>
                    <Mono className="text-t3">{w.stepCount}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(w.updatedAt)}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No workflows yet"
          body="A workflow defines which channels a notification goes out on and what each message says."
          snippet={WORKFLOW_SNIPPET}
        />
      )}
    </>
  );
}
