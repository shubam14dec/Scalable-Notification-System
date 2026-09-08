import { describe, expect, test } from 'vitest';
import { render } from '../../src/core/render';
import { htmlToText, renderMjmlTemplate, renderSubject } from '../../src/core/email-template';
import { toHtmlBody } from '../../src/providers/email';

describe('simple {{var}} render', () => {
  test('replaces known variables', () => {
    expect(render('Hi {{name}}, order {{id}}!', { name: 'Ada', id: 7 })).toBe('Hi Ada, order 7!');
  });

  test('unknown variables stay visible instead of going blank', () => {
    expect(render('Hi {{missing}}', {})).toBe('Hi {{missing}}');
  });

  test('null values stay visible too', () => {
    expect(render('{{x}}', { x: null })).toBe('{{x}}');
  });
});

describe('handlebars subject rendering', () => {
  test('renders variables', () => {
    expect(renderSubject('{{count}} updates for {{name}}', { count: 3, name: 'Ada' })).toBe(
      '3 updates for Ada',
    );
  });

  // A subject is a plain-text header, not markup. Escaping it does not defend
  // anything (nobody parses a subject as HTML) and actively corrupts ordinary
  // punctuation, so real customer names must survive verbatim.
  test('apostrophes and ampersands render literally, not as HTML entities', () => {
    expect(renderSubject('Welcome, {{company}}', { company: "O'Brien & Co" })).toBe(
      "Welcome, O'Brien & Co",
    );
  });

  test('a literal subject with punctuation is untouched', () => {
    expect(renderSubject('Your "receipt" <#{{id}}> — 50% off', { id: 9 })).toBe(
      'Your "receipt" <#9> — 50% off',
    );
  });

  // Header-injection hygiene: providers take the subject as a JSON field today,
  // but a raw-MIME path must not let a payload value append its own headers.
  test('CR and LF in a rendered value are stripped', () => {
    const out = renderSubject('Order {{ref}}', { ref: 'A1\r\nBcc: evil@example.com' });
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
    expect(out).toBe('Order A1Bcc: evil@example.com');
  });

  test('CR and LF in the subject template itself are stripped too', () => {
    expect(renderSubject('Hi\r\nthere', {})).toBe('Hithere');
  });
});

describe('MJML template rendering', () => {
  const mjml =
    '<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{name}}</mj-text></mj-column></mj-section></mj-body></mjml>';

  test('compiles to responsive HTML with variables hydrated', async () => {
    const out = await renderMjmlTemplate(mjml, { name: 'Ravi' });
    expect(out.html).toContain('Hello Ravi');
    expect(out.html).toContain('<!doctype html>');
    expect(out.text).toContain('Hello Ravi');
  });

  test('payload values are escaped inside the email', async () => {
    const out = await renderMjmlTemplate(mjml, { name: '<img src=x onerror=alert(1)>' });
    expect(out.html).not.toContain('<img src=x');
  });

  // The subject stopped escaping; the BODY must not have followed it. This is
  // the same input the subject test asserts renders literally — here it has to
  // come out as entities, because this one really is HTML.
  test('body escaping survived the subject fix', async () => {
    const out = await renderMjmlTemplate(mjml, { name: "O'Brien & Co" });
    // Same input the subject test asserts renders literally; here it must come
    // out as entities, because this one really is HTML.
    expect(out.html).toContain('&amp;');
    expect(out.html).toContain('&#x27;');
    expect(out.html).not.toContain("O'Brien & Co");
    // The plain-text alternative decodes the named entities htmlToText knows.
    // NOTE: it does not decode NUMERIC ones, so the apostrophe survives as
    // `&#x27;` in the text/plain part — a real (pre-existing) defect in
    // htmlToText, out of scope here and reported rather than silently fixed.
    expect(out.text).toContain('&');
    expect(out.text).toContain('&#x27;Brien');
  });
});

describe('htmlToText', () => {
  test('strips tags and styles, keeps content and line structure', () => {
    const text = htmlToText(
      '<html><head><title>x</title></head><style>.a{}</style><body><p>Line one</p><p>Line&nbsp;two &amp; more</p></body></html>',
    );
    expect(text).toContain('Line one');
    expect(text).toContain('Line two & more');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('.a{}');
  });
});

describe('email HTML assembly + tracking pixel', () => {
  const base = { messageId: 'm1', tenantId: 't1', to: { email: 'a@b.co' }, body: 'plain text' };

  test('no pixel and no htmlBody -> plain-text email (no html part)', () => {
    expect(toHtmlBody({ ...base })).toBeUndefined();
  });

  test('pixel without template wraps text and embeds the image', () => {
    const html = toHtmlBody({ ...base, pixelUrl: 'http://x/o/m1.gif' })!;
    expect(html).toContain('plain text');
    expect(html).toContain('http://x/o/m1.gif');
  });

  test('pixel injects INSIDE template html before </body>', () => {
    const html = toHtmlBody({
      ...base,
      htmlBody: '<html><body><h1>T</h1></body></html>',
      pixelUrl: 'http://x/o/m1.gif',
    })!;
    expect(html.indexOf('http://x/o/m1.gif')).toBeLessThan(html.indexOf('</body>'));
  });

  test('body text is escaped in the fallback wrapper', () => {
    const html = toHtmlBody({
      ...base,
      body: '<b>bold?</b>',
      pixelUrl: 'http://x/o/m1.gif',
    })!;
    expect(html).toContain('&lt;b&gt;bold?&lt;/b&gt;');
  });
});
