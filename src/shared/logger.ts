import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

/**
 * Render a credential as a short identifying prefix, never in full.
 *
 * Logs outlive the process and travel further than the box that wrote them, so
 * anything that authenticates somebody — API keys, device push tokens, webhook
 * secrets — is logged through this. Twelve characters is enough to match a
 * value against the one in the dashboard or the DB while being useless on its
 * own. Short or empty values collapse to `***` rather than leaking a value that
 * is mostly prefix.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value || value.length <= 12) return '***';
  return `${value.slice(0, 12)}…`;
}
