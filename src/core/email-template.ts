import Handlebars from 'handlebars';
import mjml2html from 'mjml';

/**
 * MJML + Handlebars email rendering.
 *
 * Handlebars runs FIRST (so {{variables}}, {{#if}}, {{#each}} all work),
 * then MJML compiles the result into bulletproof responsive email HTML.
 * Values are HTML-escaped by Handlebars — payload data can't inject markup.
 */

const compiled = new Map<string, Handlebars.TemplateDelegate>();

function compile(source: string): Handlebars.TemplateDelegate {
  let fn = compiled.get(source);
  if (!fn) {
    fn = Handlebars.compile(source, { noEscape: false });
    if (compiled.size > 500) compiled.clear(); // crude bound; sources are cache keys
    compiled.set(source, fn);
  }
  return fn;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export async function renderMjmlTemplate(
  mjmlSource: string,
  vars: Record<string, unknown>,
): Promise<RenderedEmail> {
  const hydrated = compile(mjmlSource)(vars);
  const result = await mjml2html(hydrated, { validationLevel: 'soft' });
  if (result.errors.length > 0 && !result.html) {
    throw new Error(`mjml compile failed: ${result.errors[0]?.message ?? 'unknown error'}`);
  }
  return { html: result.html, text: htmlToText(result.html) };
}

/** Plain-text fallback derived from the HTML (multipart/alternative). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Subjects use Handlebars too (plain string, no MJML). */
export function renderSubject(subjectSource: string, vars: Record<string, unknown>): string {
  return compile(subjectSource)(vars);
}
