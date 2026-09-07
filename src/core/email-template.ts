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
const compiledPlain = new Map<string, Handlebars.TemplateDelegate>();

function compileWith(
  cache: Map<string, Handlebars.TemplateDelegate>,
  source: string,
  noEscape: boolean,
): Handlebars.TemplateDelegate {
  let fn = cache.get(source);
  if (!fn) {
    fn = Handlebars.compile(source, { noEscape });
    if (cache.size > 500) cache.clear(); // crude bound; sources are cache keys
    cache.set(source, fn);
  }
  return fn;
}

/** For anything rendered INTO HTML — values are escaped so payloads can't inject markup. */
function compile(source: string): Handlebars.TemplateDelegate {
  return compileWith(compiled, source, false);
}

/** For plain-text output, where HTML entities would be shown to the reader literally. */
function compilePlain(source: string): Handlebars.TemplateDelegate {
  return compileWith(compiledPlain, source, true);
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

/**
 * Subjects use Handlebars too (plain string, no MJML).
 *
 * Rendered WITHOUT escaping, unlike the body: a subject is a plain-text header,
 * not markup, so escaping does not defend anything here — it only corrupts.
 * `O'Brien & Co` reached inboxes as `O&#x27;Brien &amp; Co` while this shared
 * the body's escaping compile. The body keeps escaping, which is where an
 * injected tag would actually render.
 *
 * CR and LF are then stripped. Today every provider takes the subject as a JSON
 * field, so this changes nothing; the day one of them writes a raw MIME header,
 * a newline in a payload value would otherwise let a customer append headers of
 * their own (Bcc:, Content-Type:) to the message.
 */
export function renderSubject(subjectSource: string, vars: Record<string, unknown>): string {
  return compilePlain(subjectSource)(vars).replace(/[\r\n]/g, '');
}
