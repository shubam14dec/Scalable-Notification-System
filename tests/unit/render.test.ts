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

  test('HTML-escapes values (payload cannot inject markup)', () => {
    expect(renderSubject('{{evil}}', { evil: '<script>' })).not.toContain('<script>');
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
