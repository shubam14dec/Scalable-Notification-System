import { pool } from './pool';

export interface TemplateRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  subject: string;
  mjml: string;
  current_version: number;
  updated_at: string;
}

/** Every save bumps the version and snapshots it — templates are append-only. */
export async function upsertTemplate(
  tenantId: string,
  key: string,
  name: string,
  subject: string,
  mjml: string,
): Promise<TemplateRow> {
  const { rows } = await pool.query(
    `insert into templates (tenant_id, key, name, subject, mjml)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, key) do update set
       name = excluded.name,
       subject = excluded.subject,
       mjml = excluded.mjml,
       current_version = templates.current_version + 1,
       updated_at = now()
     returning *`,
    [tenantId, key, name, subject, mjml],
  );
  const template: TemplateRow = rows[0];
  await pool.query(
    `insert into template_versions (template_id, version, subject, mjml)
     values ($1, $2, $3, $4)
     on conflict (template_id, version) do nothing`,
    [template.id, template.current_version, subject, mjml],
  );
  return template;
}

export async function getTemplate(tenantId: string, key: string): Promise<TemplateRow | null> {
  const { rows } = await pool.query(
    'select * from templates where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rows[0] ?? null;
}

/** Pinned-version lookup — what delivery uses so in-flight sends are immutable. */
export async function getTemplateVersion(
  tenantId: string,
  key: string,
  version: number,
): Promise<{ subject: string; mjml: string } | null> {
  const { rows } = await pool.query(
    `select v.subject, v.mjml
     from templates t
     join template_versions v on v.template_id = t.id and v.version = $3
     where t.tenant_id = $1 and t.key = $2`,
    [tenantId, key, version],
  );
  return rows[0] ?? null;
}

export async function listTemplates(tenantId: string) {
  const { rows } = await pool.query(
    `select key, name, subject, current_version, updated_at
     from templates where tenant_id = $1 order by key`,
    [tenantId],
  );
  return rows;
}

export async function deleteTemplate(tenantId: string, key: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from templates where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rowCount ?? 0;
}
