/**
 * S1.5 — the SMTP connect-time SSRF layer.
 *
 * A tenant SMTP host passes an SSRF check when the integration is WRITTEN
 * (src/api/routes/integrations.ts), but nothing re-checked it at send time, so
 * a host that was public in March and points at 169.254.169.254 in April kept
 * being dialed. `SmtpEmailProvider.send` now re-vets the tenant's host on every
 * send (see the investigation comment in src/providers/email.ts — nodemailer
 * accepts no custom DNS lookup, so there is no dispatcher-style hook).
 *
 * Every case here is deterministic and offline: literal IPs and `localhost` are
 * decided syntactically, and the one hostname case is allowlisted. The
 * DNS-resolution branch of the same predicate is covered by safe-url.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SmtpEmailProvider } from '../../src/providers/email';
import { PermanentError } from '../../src/shared/errors';
import type { RenderedMessage } from '../../src/providers/types';

// tests/setup.ts allowlists localhost/127.0.0.1 for the integration suites;
// this file is about the guard itself, so each test states its own list.
const savedAllow = process.env.OUTBOUND_URL_ALLOW;
beforeEach(() => {
  process.env.OUTBOUND_URL_ALLOW = '';
});
afterEach(() => {
  process.env.OUTBOUND_URL_ALLOW = savedAllow;
});

const message: RenderedMessage = {
  messageId: 'm-smtp',
  tenantId: 't1',
  to: { email: 'someone@example.com' },
  subject: 'hi',
  body: 'body',
};

/**
 * Replace the pooled transport with a recorder. Nothing dials: we are proving
 * where the gate fires relative to the socket, so `sent` staying 0 IS the
 * assertion in the rejection cases.
 */
function stubTransport(provider: SmtpEmailProvider) {
  const calls: Array<Record<string, unknown>> = [];
  (provider as unknown as { transport: unknown }).transport = {
    sendMail: async (mail: Record<string, unknown>) => {
      calls.push(mail);
      return { messageId: 'stub-message-id' };
    },
  };
  return calls;
}

describe('tenant SMTP host is re-vetted at send time', () => {
  test('localhost is refused with the PermanentError shape, before any dial', async () => {
    const provider = new SmtpEmailProvider(
      { host: 'localhost', port: 1025, from: 'a@example.com' },
      'smtp:tenant',
    );
    const calls = stubTransport(provider);

    await expect(provider.send(message)).rejects.toBeInstanceOf(PermanentError);
    await expect(provider.send(message)).rejects.toThrow(/smtp host blocked/);
    // Permanent, not transient: retrying cannot make this host legal, so the
    // delivery processor must not burn its retry budget on it.
    expect(calls).toHaveLength(0);
  });

  test('a literal cloud-metadata address is refused', async () => {
    const provider = new SmtpEmailProvider(
      { host: '169.254.169.254', port: 25, from: 'a@example.com' },
      'smtp:tenant',
    );
    const calls = stubTransport(provider);

    await expect(provider.send(message)).rejects.toThrow(/private or reserved/);
    expect(calls).toHaveLength(0);
  });

  test('a loopback address outside the dev allowlist is refused', async () => {
    const provider = new SmtpEmailProvider(
      { host: '127.0.0.53', port: 25, from: 'a@example.com' },
      'smtp:tenant',
    );
    const calls = stubTransport(provider);

    await expect(provider.send(message)).rejects.toThrow(/smtp host blocked/);
    expect(calls).toHaveLength(0);
  });

  test('a public host constructs a real pooled transport and sends', async () => {
    const provider = new SmtpEmailProvider(
      { host: '93.184.216.34', port: 587, from: 'a@example.com', secure: false },
      'smtp:tenant',
    );
    // The transport nodemailer built, before we swap it out: proof the
    // constructor produced a real one carrying the tenant's host/port.
    const built = (provider as unknown as { transport: { options: Record<string, unknown> } })
      .transport;
    expect(built.options.host).toBe('93.184.216.34');
    expect(built.options.port).toBe(587);
    expect(built.options.pool).toBe(true);

    const calls = stubTransport(provider);
    const res = await provider.send(message);
    expect(res.providerMessageId).toBe('stub-message-id');
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('someone@example.com');
  });

  test('a hostname on the dev allowlist passes the gate', async () => {
    process.env.OUTBOUND_URL_ALLOW = 'smtp.vendor.example';
    const provider = new SmtpEmailProvider(
      { host: 'smtp.vendor.example', port: 587, from: 'a@example.com' },
      'smtp:tenant',
    );
    const calls = stubTransport(provider);

    await provider.send(message);
    expect(calls).toHaveLength(1);
  });

  test('the env-configured DEFAULT provider is never gated', async () => {
    // No config argument = operator infrastructure (mailpit on the compose
    // network, an internal relay). SMTP_HOST defaults to `localhost`, which the
    // guard would reject — gating it would break the operator's own config.
    const provider = new SmtpEmailProvider();
    const calls = stubTransport(provider);

    await provider.send(message);
    expect(calls).toHaveLength(1);
  });
});
