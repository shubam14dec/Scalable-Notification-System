import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, EmptyState, Field, Input, Mono, PageHeader, Skeleton, td, th } from '../ui';
import { timeAgo } from './Activity';

interface TemplateSummary {
  key: string;
  name: string;
  subject: string;
  current_version: number;
  updated_at: string;
}

const STARTER_MJML = `<mjml>
  <mj-body background-color="#f4f4f5">
    <mj-section background-color="#ffffff" border-radius="8px" padding="32px">
      <mj-column>
        <mj-text font-size="20px" font-weight="600" color="#18181b">
          Hello {{name}}!
        </mj-text>
        <mj-text font-size="14px" color="#52525b" line-height="1.6">
          Your order {{orderId}} is on its way and should arrive by {{eta}}.
        </mj-text>
        <mj-button background-color="#18181b" border-radius="6px" href="https://example.com">
          Track your order
        </mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

export default function TemplatesPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<{ templates: TemplateSummary[] }>('/v1/templates'),
  });

  return (
    <>
      <PageHeader
        title="Templates"
        action={
          <Button variant="primary" onClick={() => navigate('/templates/new')}>
            New template
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.templates.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Key</th>
                <th className={th}>Name</th>
                <th className={th}>Subject</th>
                <th className={`${th} text-right`}>Version</th>
                <th className={`${th} text-right`}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((t) => (
                <tr
                  key={t.key}
                  className="cursor-pointer transition-colors hover:bg-elevated"
                  onClick={() => navigate(`/templates/${t.key}`)}
                >
                  <td className={td}>
                    <Mono>{t.key}</Mono>
                  </td>
                  <td className={td}>{t.name}</td>
                  <td className={td}>
                    <span className="text-t2">{t.subject}</span>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">v{t.current_version}</Mono>
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(t.updated_at)}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No templates yet"
          body="Templates are responsive MJML emails with {{variables}}. Design once, reference from any workflow's email step."
        />
      )}
    </>
  );
}

export function TemplateEditorPage() {
  const { key: routeKey } = useParams();
  const isNew = routeKey === undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('Your order {{orderId}} update');
  const [mjml, setMjml] = useState(STARTER_MJML);
  const [vars, setVars] = useState('{\n  "name": "Ada",\n  "orderId": "ORD-1",\n  "eta": "Tuesday"\n}');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const debounce = useRef<number>();

  const { data } = useQuery({
    queryKey: ['template', routeKey],
    queryFn: () =>
      api<{ template: { key: string; name: string; subject: string; mjml: string; version: number } }>(
        `/v1/templates/${routeKey}`,
      ),
    enabled: !isNew,
  });

  useEffect(() => {
    if (data) {
      setKey(data.template.key);
      setName(data.template.name);
      setSubject(data.template.subject);
      setMjml(data.template.mjml);
      setVersion(data.template.version);
    }
  }, [data]);

  // Debounced live preview of the current buffer.
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      let parsedVars: Record<string, unknown> = {};
      try {
        parsedVars = vars.trim() ? JSON.parse(vars) : {};
      } catch {
        setPreviewError('Sample variables must be valid JSON');
        return;
      }
      api<{ html: string }>('/v1/templates/preview', {
        method: 'POST',
        body: { subject, mjml, vars: parsedVars },
      })
        .then((res) => {
          setPreviewHtml(res.html);
          setPreviewError('');
        })
        .catch((err) => setPreviewError(err.message));
    }, 500);
    return () => window.clearTimeout(debounce.current);
  }, [mjml, subject, vars]);

  const save = useMutation({
    mutationFn: () => api<{ version: number }>('/v1/templates', { method: 'PUT', body: { key, name, subject, mjml } }),
    onSuccess: (res) => {
      setVersion(res.version);
      setSaveError('');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
      if (isNew) navigate(`/templates/${key}`, { replace: true });
    },
    onError: (err) => setSaveError(err.message),
  });

  return (
    <>
      <Link to="/templates" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-t3 hover:text-t1">
        <ArrowLeft className="h-3.5 w-3.5" /> Templates
      </Link>
      <PageHeader
        title={isNew ? 'New template' : `${routeKey}${version ? `  ·  v${version}` : ''}`}
        action={
          <Button
            variant="primary"
            disabled={!key || !name || !subject || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : version ? `Save as v${version + 1}` : 'Save template'}
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Field label="Key">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-'))}
            disabled={!isNew}
            placeholder="order-update"
            className="font-mono"
          />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Order update" />
        </Field>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="MJML">
            <textarea
              rows={22}
              spellCheck={false}
              className="w-full rounded-md border border-bd bg-transparent p-3 font-mono text-[12px] leading-relaxed text-t1 hover:border-bd-strong"
              value={mjml}
              onChange={(e) => setMjml(e.target.value)}
            />
          </Field>
          <Field label="Sample variables (for preview only)">
            <textarea
              rows={4}
              spellCheck={false}
              className="w-full rounded-md border border-bd bg-transparent p-2.5 font-mono text-[12px] text-t1 hover:border-bd-strong"
              value={vars}
              onChange={(e) => setVars(e.target.value)}
            />
          </Field>
          {saveError && <p className="text-[12px] text-err">{saveError}</p>}
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-t2">
            Live preview{previewError && <span className="ml-2 text-err">{previewError}</span>}
          </p>
          <Card className="overflow-hidden">
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={previewHtml}
              className="h-[560px] w-full bg-white"
            />
          </Card>
        </div>
      </div>
    </>
  );
}
