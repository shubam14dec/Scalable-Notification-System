/**
 * Inbound email normalization (v1 provider: Postmark Inbound — a ready
 * inbound address with no DNS required; a custom MX domain later hits the
 * same webhook with the same payload shape).
 */

/** The slice of Postmark's inbound JSON the platform uses. */
export interface PostmarkInbound {
  FromFull?: { Email?: string; Name?: string };
  Subject?: string;
  TextBody?: string;
  /** Postmark's own pre-stripped reply text, when it can detect quoting. */
  StrippedTextReply?: string;
  /** Postmark's unique id for this inbound message. */
  MessageID?: string;
  Headers?: Array<{ Name: string; Value: string }>;
}

export interface InboundEmail {
  fromEmail: string;
  subject: string;
  /** The sender's new words only — quoted history removed. */
  text: string;
  /** Provider's unique inbound id — the dedupe key. */
  providerMessageId: string;
  /** RFC 5322 Message-ID header, for In-Reply-To threading on our reply. */
  rfcMessageId: string | null;
}

/**
 * Cut the quoted tail off a reply so the agent sees only the new words.
 * Naive by design (v1): everything from the first quote marker onward is
 * dropped — "On ... wrote:", "-----Original Message", or a run of
 * ">"-prefixed lines.
 */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^On .{0,200}wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{0,}/im,
    /^_{5,}\s*$/m,
    /^From:\s.+$/m,
    /^>{1}.*$/m,
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut).trim();
}

/** Normalize a Postmark inbound payload; null when it isn't a usable turn. */
export function parsePostmarkInbound(payload: PostmarkInbound): InboundEmail | null {
  const fromEmail = payload.FromFull?.Email?.trim().toLowerCase();
  const providerMessageId = payload.MessageID;
  if (!fromEmail || !providerMessageId) return null;

  const stripped = payload.StrippedTextReply?.trim();
  const text = stripped && stripped.length > 0
    ? stripped
    : stripQuotedReply(payload.TextBody ?? '');
  if (text.length === 0) return null;

  const rfcMessageId =
    payload.Headers?.find((h) => h.Name.toLowerCase() === 'message-id')?.Value ?? null;

  return {
    fromEmail,
    subject: payload.Subject?.trim() || '(no subject)',
    text,
    providerMessageId,
    rfcMessageId,
  };
}
