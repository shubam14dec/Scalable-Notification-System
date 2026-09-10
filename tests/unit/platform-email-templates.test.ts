/**
 * U4 — the platform's own email templates.
 *
 * Four things are checked for every builder, because these four are what
 * silently break: the subject (it is what the reader decides on), the link in
 * BOTH parts (a text-only reader must still be able to act), the preheader
 * (its absence is invisible to whoever wrote the email and glaring in an inbox
 * list), and the absence of anything remote (one `<img>` and the mail renders
 * differently before and after the reader trusts the sender).
 *
 * And then the one that is not cosmetic: `accessRequestEmail` carries a
 * STRANGER's typed name and use case into an OPERATOR's inbox. Its escaping is
 * a security boundary, so the hostile-input case below is written the way an
 * attacker would write it.
 */
import { describe, expect, test } from 'vitest';
import {
  accessRequestEmail,
  inviteEmail,
  passwordResetEmail,
  type PlatformEmailContent,
} from '../../src/core/platform-email-templates';

const LINK = 'http://localhost:5173/reset-password?token=abc123';
const INVITE_LINK = 'http://localhost:5173/login?invite=deadbeef';
const REQUESTS_URL = 'http://localhost:5173/requests';
const DASHBOARD = 'http://localhost:5173';

/** The preheader span — hidden text, first in the body, one per email. */
const PREHEADER = /<span style="display:none!important;[^"]*">([^<]+)<\/span>/;

/**
 * Every absolute URL the html mentions. The assertion built on it is "the only
 * URLs in here are the ones we put there": a webfont, a CDN stylesheet or a
 * tracking pixel all show up as an extra entry.
 */
function urlsIn(html: string): string[] {
  return html.match(/https?:\/\/[^"'\s<>)]+/g) ?? [];
}

/** What every one of these emails must satisfy, whatever it says. */
function expectsWellFormed(mail: PlatformEmailContent, ownUrl: string) {
  // A subject that reads as a subject, not a placeholder or a truncation.
  expect(mail.subject.length).toBeGreaterThan(5);
  expect(mail.subject.length).toBeLessThan(80);
  expect(mail.subject).not.toContain('undefined');

  // Both parts carry the link. The text part is not a courtesy: it is what a
  // text-only client, a screen reader and "show original" all render.
  expect(mail.text).toContain(ownUrl);
  expect(mail.html).toContain(`href="${ownUrl}"`);
  // …and printed in full underneath, for when a gateway mangles the button.
  expect(mail.html).toContain(`Or paste this into your browser`);

  // The preheader exists and says something.
  const preheader = PREHEADER.exec(mail.html)?.[1] ?? '';
  expect(preheader.length).toBeGreaterThan(10);

  // ZERO remote requests: no images, no stylesheets, no fonts, no scripts.
  expect(mail.html).not.toMatch(/<img\b/i);
  expect(mail.html).not.toMatch(/\bsrc\s*=/i);
  expect(mail.html).not.toMatch(/<link\b/i);
  expect(mail.html).not.toMatch(/<script\b/i);
  expect(mail.html).not.toMatch(/@import/i);
  expect(mail.html).not.toMatch(/url\(/i);
  // The only absolute URLs are our own link, and every one of them is it.
  for (const url of urlsIn(mail.html)) {
    expect(url.startsWith(ownUrl)).toBe(true);
  }

  // Colour is declared everywhere a forced-dark client could otherwise invent
  // one, and the identity green appears exactly once — the wordmark dot.
  expect(mail.html.match(/#009159/g) ?? []).toHaveLength(1);
  expect(mail.html).toContain('<html lang="en">');
}

describe('passwordResetEmail', () => {
  const mail = passwordResetEmail({ link: LINK });

  test('is well formed and carries the reset link in both parts', () => {
    expect(mail.subject).toBe('Reset your asyncify password');
    expectsWellFormed(mail, LINK);
  });

  test('keeps the rules the S1.7a wording promised', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('30 minutes');
      expect(part).toContain('once');
    }
    expect(mail.text).toContain('did not request');
    expect(mail.html).toContain('did not request');
    expect(mail.html).toContain('Reset password');
    expect(mail.html).toContain(
      'someone asked to reset the password for this address',
    );
  });
});

describe('inviteEmail', () => {
  const mail = inviteEmail({ link: INVITE_LINK });

  test('is well formed and carries the invite link in both parts', () => {
    expect(mail.subject).toBe("You're in — Asyncify access approved");
    expectsWellFormed(mail, INVITE_LINK);
  });

  test('keeps the 7-day single-use rule and names the reason', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('7 days');
      expect(part).toContain('once');
    }
    expect(mail.html).toContain('Create your account');
    expect(mail.html).toContain('your access request was approved');
  });
});

describe('accessRequestEmail', () => {
  const mail = accessRequestEmail({
    name: 'Grace Hopper',
    email: 'grace@example.com',
    useCase: 'agent replies on telegram',
    requestsUrl: REQUESTS_URL,
  });

  test('is well formed and points the operator at the Requests page', () => {
    expect(mail.subject).toBe('Access request from Grace Hopper');
    expectsWellFormed(mail, REQUESTS_URL);
  });

  test('shows the applicant as a fact block, in both parts', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('grace@example.com');
      expect(part).toContain('agent replies on telegram');
    }
    expect(mail.html).toContain('Review in Requests');
    expect(mail.html).toContain('you are an operator of this Asyncify deployment');
  });

  /**
   * THE SHARP EDGE. Everything below was typed by an unauthenticated stranger
   * into a public form, and it is being rendered inside the inbox of the one
   * account that can grant access to the deployment.
   */
  describe('hostile applicant input', () => {
    const HOSTILE_NAME = '<script>alert(1)</script>';
    const HOSTILE_USE_CASE =
      `We "need" it & <img src=x onerror=alert(1)> ` +
      `<a href="https://evil.example/steal">click</a> it's urgent`;

    const attacked = accessRequestEmail({
      name: HOSTILE_NAME,
      email: '"><b>spoof</b>@evil.example',
      useCase: HOSTILE_USE_CASE,
      requestsUrl: REQUESTS_URL,
    });

    test('arrives fully escaped in the html — no tag of theirs survives', () => {
      expect(attacked.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(attacked.html).not.toContain('<script>');
      expect(attacked.html).not.toMatch(/<img\b/i);
      expect(attacked.html).not.toMatch(/<a href="https:\/\/evil\.example/);
      // The payload is still THERE — the operator sees exactly what was typed
      // — but every angle bracket that would have made it markup is gone, so
      // `onerror=` is a word in a sentence and not an attribute.
      expect(attacked.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // Quotes are escaped too, so nothing can close the attribute it sits in
      // and start a new one: the `">` prefix on that email address is the
      // attack that plain `&<>` escaping would have let through.
      expect(attacked.html).toContain('&quot;&gt;&lt;b&gt;spoof&lt;/b&gt;@evil.example');
      expect(attacked.html).toContain('&amp;');
      expect(attacked.html).toContain('it&#39;s urgent');
    });

    test('the operator still sees what they actually wrote, in plain text', () => {
      expect(attacked.text).toContain(HOSTILE_NAME);
      expect(attacked.text).toContain(HOSTILE_USE_CASE);
      // Headers are not markup — nodemailer encodes the subject, and escaping
      // it here would put a literal &amp; in the operator's inbox.
      expect(attacked.subject).toBe(`Access request from ${HOSTILE_NAME}`);
    });

    test('their URL never becomes a link, and ours is still the only one', () => {
      // Every href in the document, ours included — there must be exactly one.
      const hrefs = [...attacked.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual([REQUESTS_URL]);
      // Their URL is still SHOWN — the operator should see what was written —
      // but only as escaped text inside the fact block.
      expect(attacked.html).toContain('https://evil.example/steal');
    });
  });
});
