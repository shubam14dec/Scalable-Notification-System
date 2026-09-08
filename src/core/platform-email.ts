import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../shared/logger';

/**
 * S1.7a — THE PLATFORM'S OWN MAILBOX.
 *
 * Everything else in this codebase that sends an email does so on a TENANT's
 * behalf, through the provider chain (`src/providers/registry.ts`): the
 * tenant's Resend key, their verified domain, their circuit breaker, their
 * delivery rows in `messages`, their analytics. That pipeline is the right
 * shape for "Acme tells its customer an order shipped".
 *
 * A password-reset link is not that. It is ASYNCIFY talking to an
 * asyncify OPERATOR about their asyncify account, and it must not:
 *
 *   - depend on any tenant's integration being configured or healthy (the
 *     person locked out may be the only admin who could fix it),
 *   - be attributed to a tenant's sending domain and reputation,
 *   - create `events`/`messages` rows a customer can see in their Activity
 *     feed, or bill against their analytics,
 *   - ride the delivery queue, whose retries and dedupe are designed around
 *     notifications, not one-shot single-use security links.
 *
 * So it takes the OPERATOR transport — the SMTP_* environment settings, which
 * are the box's own mail path (Mailpit in dev, an authenticated relay such as
 * Resend's SMTP mode in production). One transport, created lazily and pooled,
 * exactly like `SmtpEmailProvider`.
 *
 * NOT SSRF-gated, for the same reason the env-default provider isn't: this
 * host comes from the operator's own environment file, not from tenant input,
 * and gating it would block precisely the private targets (mailpit on the
 * compose network, an internal relay) an operator deliberately configures.
 */

export interface PlatformEmail {
  to: string;
  subject: string;
  /** Plain text only. Nothing the platform says to an operator needs HTML. */
  text: string;
}

/** `false` means "not delivered" — never a throw: no caller may fail on this. */
export type PlatformEmailSender = (message: PlatformEmail) => Promise<boolean>;

let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      // 587 (submission) starts plaintext and upgrades with STARTTLS, which
      // nodemailer does on its own; `secure: true` is for implicit TLS on 465.
      secure: env.smtpPort === 465,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
      pool: true,
      maxConnections: 2,
    });
  }
  return transport;
}

const smtpSender: PlatformEmailSender = async (message) => {
  // env.smtpHost is '' only when SMTP_HOST is explicitly empty (the `??`
  // fallback catches unset, not blank) — which is exactly how the production
  // .env said "no operator mail path" before this slice existed.
  if (!env.smtpHost) {
    logger.warn(
      { to: message.to, subject: message.subject },
      'platform email not configured — reset links cannot be delivered',
    );
    return false;
  }
  try {
    await getTransport().sendMail({
      from: env.smtpFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return true;
  } catch (err) {
    // Swallowed on purpose. The one caller is /auth/forgot, which must answer
    // 200 whether or not the address exists — surfacing a send failure there
    // would turn "this mailbox bounced" into an account-enumeration oracle.
    logger.warn({ err: (err as Error).message, to: message.to }, 'platform email send failed');
    return false;
  }
};

/**
 * The live sender. A module-level indirection rather than a direct call, so an
 * integration test can swap the real SMTP hop out and assert what WOULD have
 * been sent — same seam idiom the provider stubs use, but reachable without
 * `vi.mock` (the routes import `sendPlatformEmail` by name).
 */
let sender: PlatformEmailSender = smtpSender;

export function sendPlatformEmail(message: PlatformEmail): Promise<boolean> {
  return sender(message);
}

/** Test seam: install a sender, and get back the call that restores the real one. */
export function setPlatformEmailSender(next: PlatformEmailSender): () => void {
  const previous = sender;
  sender = next;
  return () => {
    sender = previous;
  };
}
