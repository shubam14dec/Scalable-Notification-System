/**
 * U4 — WHAT THE PLATFORM'S OWN EMAILS LOOK LIKE.
 *
 * Four messages Asyncify sends AS ITSELF (see the essay at the top of
 * `platform-email.ts` for why they never ride a tenant's provider chain):
 * a password reset, an access request landing in an operator's inbox, an
 * approved invite, and the welcome note a brand-new account gets. Each builder
 * returns `{subject, text, html}` — the exact shape `sendPlatformEmail` takes.
 *
 * This is NOT the tenant template system. `src/core/email-template.ts` compiles
 * MJML for what a CUSTOMER sends to THEIR users, with their branding, their
 * blocks and their editor. Nothing here is configurable, because nothing here
 * belongs to a tenant: these four are the product speaking, and they look the
 * way the dashboard looks.
 *
 * THE CONSTRAINTS THAT SHAPED THE MARKUP — email is not the web:
 *
 *  - Tables, not flexbox. Outlook renders through Word's HTML engine; a `div`
 *    layout with `display:flex` collapses into a stack of full-width blocks.
 *  - Every style INLINE. Gmail strips `<style>` blocks in several of its
 *    clients and all of its mobile apps; a class name is a style that exists
 *    only in the preview pane of whoever wrote it.
 *  - ZERO remote requests. No image, no webfont, no tracking pixel, not even a
 *    logo: a platform email must render identically before and after the reader
 *    clicks "display images", and an SVG wordmark would simply be stripped. The
 *    mark is therefore TEXT plus one border-radius span for the dot — a shape
 *    every client can draw with a background colour.
 *  - Colour is explicit on every element, including the ones inheriting an
 *    obvious value. Clients that force a dark theme recolour the BACKGROUND
 *    they see and leave declared text colours alone; an undeclared colour is
 *    what turns into grey-on-grey.
 *
 * ESCAPING IS THE SECURITY LINE. `accessRequestEmail` puts a STRANGER's typed
 * name and use-case into an OPERATOR's inbox — the operator being the one
 * account on the deployment that can let people in. Every interpolated value
 * goes through `esc` on the way into markup, with no exceptions and no
 * "this one is ours so it's fine": the day one of these strings starts coming
 * from somewhere else, the escaping must already be there.
 */

/** The dashboard's identity green. The ONLY colour in these emails. */
const GREEN = '#009159';
const INK = '#171717';
const MUTED = '#666666';
const HAIRLINE = '#eaeaea';
const CANVAS = '#ffffff';

/**
 * System stacks, because a webfont is a remote request and remote requests do
 * not happen here. Every reader gets their own platform's UI face, which is
 * also what makes the mail look native rather than like a rendered document.
 */
const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Technical values are mono here for the same reason they are in the dashboard. */
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * The one escaper. Quotes included — `&<>` alone is enough for text nodes but
 * NOT for an attribute, and one function that is always correct beats two that
 * have to be chosen between correctly at every call site.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PlatformEmailContent {
  subject: string;
  text: string;
  html: string;
}

interface ShellParts {
  /** Browser/tab title and the mail's own <title>. Escaped here. */
  title: string;
  /** The one-line summary clients show beside the subject. Escaped here. */
  preheader: string;
  /** The card's contents below the title — ALREADY-ESCAPED html. */
  body: string;
  /** Completes "You're receiving this because …". Escaped here. */
  reason: string;
}

/**
 * The frame all four messages sit in: wordmark, one hairline card, a footer
 * that says why this landed in your inbox.
 *
 * The preheader span is the first text in the body, hidden six different ways
 * because clients disagree about which of them they honour — it is what fills
 * the grey line beside the subject in an inbox list, and without one that line
 * gets filled with the first thing the client finds, which is the wordmark.
 */
function shell({ title, preheader, body, reason }: ShellParts): string {
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<title>${esc(title)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:${CANVAS};color:${INK};">` +
    `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;` +
    `height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:collapse;background-color:${CANVAS};">` +
    `<tr><td align="center" style="padding:32px 16px;background-color:${CANVAS};">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:560px;border-collapse:collapse;">` +
    // wordmark
    `<tr><td style="padding:0 2px 18px 2px;font-family:${SANS};font-size:15px;font-weight:600;` +
    `line-height:1.2;color:${INK};">Asyncify` +
    `<span style="display:inline-block;width:6px;height:6px;border-radius:6px;` +
    `background-color:${GREEN};margin-left:5px;"></span>` +
    `</td></tr>` +
    // the card
    `<tr><td style="background-color:${CANVAS};border:1px solid ${HAIRLINE};border-radius:12px;` +
    `padding:32px;">` +
    `<h1 style="margin:0 0 14px 0;font-family:${SANS};font-size:20px;font-weight:600;` +
    `line-height:1.3;color:${INK};">${esc(title)}</h1>` +
    body +
    `</td></tr>` +
    // footer
    `<tr><td style="padding:18px 2px 0 2px;font-family:${SANS};font-size:12px;line-height:1.6;` +
    `color:${MUTED};">` +
    `You&#39;re receiving this because ${esc(reason)}.<br>asyncify.org` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/** A body paragraph. `html` is already-escaped markup, not raw input. */
function paragraph(html: string): string {
  return (
    `<p style="margin:0 0 16px 0;font-family:${SANS};font-size:15px;line-height:1.6;` +
    `color:${INK};">${html}</p>`
  );
}

/** The quieter lines under a call to action — rules, expiries, next steps. */
function note(lines: string[]): string {
  return (
    `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${MUTED};">` +
    lines.join('<br>') +
    `</p>`
  );
}

/**
 * The one call to action, plus the raw URL beneath it.
 *
 * Both are needed. The button is a table cell with the background AND an inner
 * anchor carrying padding, so that a client which drops the cell background
 * still shows a padded link and one which drops the anchor's box still shows a
 * dark button. When BOTH are mangled — corporate gateways rewrite anchors,
 * some clients refuse to linkify at all — the mono URL below is the whole
 * message's escape hatch, which is why it is printed in full rather than
 * truncated, and why it wraps instead of overflowing.
 */
function action(url: string, label: string): string {
  const href = esc(url);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;margin:22px 0 14px 0;">` +
    `<tr><td style="background-color:${INK};border-radius:8px;">` +
    `<a href="${href}" style="display:inline-block;padding:11px 20px;font-family:${SANS};` +
    `font-size:14px;font-weight:500;line-height:1.2;color:${CANVAS};text-decoration:none;` +
    `border-radius:8px;">${esc(label)}</a>` +
    `</td></tr></table>` +
    `<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">` +
    `Or paste this into your browser:<br>` +
    `<span style="font-family:${MONO};font-size:12px;color:${MUTED};word-break:break-all;">` +
    `${esc(url)}</span></p>`
  );
}

/**
 * The name / email / use-case block. A table rather than a `<dl>`: Outlook's
 * engine ignores most of what makes a definition list look like one, and the
 * two-column table is the shape it does understand.
 *
 * `pre-wrap` on the value keeps the applicant's own line breaks — a use case is
 * a paragraph someone wrote, and flattening it loses their meaning — while the
 * escaping above keeps their markup inert.
 */
function facts(rows: Array<{ label: string; value: string; mono?: boolean }>): string {
  const cells = rows
    .map(
      ({ label, value, mono }) =>
        `<tr>` +
        `<td valign="top" style="padding:0 14px 10px 0;font-family:${SANS};font-size:12px;` +
        `line-height:1.6;color:${MUTED};white-space:nowrap;">${esc(label)}</td>` +
        `<td valign="top" style="padding:0 0 10px 0;font-family:${mono ? MONO : SANS};` +
        `font-size:13px;line-height:1.6;color:${INK};white-space:pre-wrap;word-break:break-word;">` +
        `${esc(value)}</td>` +
        `</tr>`,
    )
    .join('');
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:collapse;margin:0 0 4px 0;">${cells}</table>`
  );
}

// ---------------------------------------------------------------- builders --

/** S1.7a's reset link, now with a face. Wording unchanged. */
export function passwordResetEmail({ link }: { link: string }): PlatformEmailContent {
  return {
    subject: 'Reset your asyncify password',
    text: [
      'Someone asked to reset the password on your asyncify account.',
      '',
      'Open this link to choose a new one:',
      link,
      '',
      'The link works for 30 minutes and can only be used once.',
      '',
      'If you did not request this, you can ignore this email — nothing has',
      'changed, and your current password still works.',
    ].join('\n'),
    html: shell({
      title: 'Reset your password',
      preheader: 'Choose a new password — the link works for 30 minutes.',
      reason: 'someone asked to reset the password for this address',
      body:
        paragraph('Someone asked to reset the password on your Asyncify account.') +
        action(link, 'Reset password') +
        note([
          'The link works for 30 minutes and can only be used once.',
          'If you did not request this, ignore this email — nothing has changed and your current password still works.',
        ]),
    }),
  };
}

/**
 * B1's operator notification. THE HOSTILE ONE: every value below was typed by
 * a stranger into an unauthenticated public form.
 */
export function accessRequestEmail({
  name,
  email,
  useCase,
  requestsUrl,
}: {
  name: string;
  email: string;
  useCase: string;
  requestsUrl: string;
}): PlatformEmailContent {
  return {
    // Subject lines are headers, not markup — nodemailer encodes them. Escaping
    // here would put a literal `&amp;` in somebody's inbox.
    subject: `Access request from ${name}`,
    text: [
      `${name} asked for access to asyncify.`,
      '',
      `Email:    ${email}`,
      `Use case: ${useCase}`,
      '',
      `Approve or decline it on the Requests page: ${requestsUrl}`,
    ].join('\n'),
    html: shell({
      title: 'New access request',
      preheader: `${name} asked for access to Asyncify.`,
      reason: 'you are an operator of this Asyncify deployment',
      body:
        paragraph('Someone asked to be let into the beta.') +
        facts([
          { label: 'Name', value: name },
          { label: 'Email', value: email, mono: true },
          { label: 'Use case', value: useCase },
        ]) +
        action(requestsUrl, 'Review in Requests'),
    }),
  };
}

/** B1's approved invite — congratulatory at his call. */
export function inviteEmail({ link }: { link: string }): PlatformEmailContent {
  return {
    subject: "You're in — Asyncify access approved",
    text: [
      "Congratulations — you're in.",
      '',
      'Your access request was approved. Create your account below and put',
      'the platform to work.',
      '',
      link,
      '',
      'The link works for 7 days and can only be used once. Sign up with THIS',
      'email address; the invite is issued to it and will not accept another.',
      '',
      'If the link has expired by the time you get to it, just ask again and',
      "we'll send a fresh one.",
    ].join('\n'),
    html: shell({
      title: "Congratulations — you're in.",
      preheader: 'Your access request was approved — create your account.',
      reason: 'your access request was approved',
      body:
        paragraph('Your access request was approved. Create your account below and put the platform to work.') +
        action(link, 'Create your account') +
        note([
          'The link works for 7 days and can only be used once. Sign up with THIS email address — the invite is issued to it and will not accept another.',
          "If it has expired by the time you get to it, ask again and we'll send a fresh one.",
        ]),
    }),
  };
}

/**
 * U4's new one: the first thing a brand-new account hears from us.
 *
 * Deliberately short and deliberately not a tour. The person who just signed up
 * is looking at the dashboard right now — this email's job is to exist in their
 * inbox afterwards as the way back in, not to teach them the product from a
 * mail client.
 */
export function welcomeEmail({ dashboardUrl }: { dashboardUrl: string }): PlatformEmailContent {
  return {
    subject: 'Welcome to Asyncify',
    text: [
      'Congratulations — your account is live.',
      '',
      'Your org, environments and API keys are ready — your product has',
      'something to say.',
      '',
      'Open the dashboard:',
      dashboardUrl,
      '',
      'From here:',
      '  · create a workflow',
      '  · connect a channel',
    ].join('\n'),
    html: shell({
      title: 'Congratulations — your account is live.',
      preheader: 'Your org, environments and API keys are ready.',
      reason: 'you created an Asyncify account',
      body:
        paragraph(
          'Your org, environments and API keys are ready — your product has ' +
            'something to say.',
        ) +
        action(dashboardUrl, 'Open the dashboard') +
        note([
          'Create a workflow',
          'Connect a channel',
        ]),
    }),
  };
}
