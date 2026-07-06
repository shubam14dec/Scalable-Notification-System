---
name: email-delivery
description: Email domain knowledge for Asyncify — deliverability (SPF/DKIM/DMARC, warming, reputation), bounce/complaint thresholds, compliance (CAN-SPAM/GDPR/CASL, unsubscribe rules), and provider error classification. Use when building email features, writing customer-facing docs, adding providers, designing templates, or debugging spam/bounce issues.
---

# Email Delivery — Domain Rules for Asyncify

Distilled from production email practice. Each section says what the rule
is AND how it maps to Asyncify's machinery (built / customer's job / gap).

## 1. Authentication is non-negotiable (customer's job, our docs' job)

Gmail/Yahoo/Microsoft reject or spam-filter unauthenticated mail. Every
customer connecting a real provider needs three DNS records on their
sending domain:

- **SPF** — TXT: `v=spf1 include:<provider> ~all`
- **DKIM** — TXT record supplied by the provider (SendGrid/Resend/SES)
- **DMARC** — TXT at `_dmarc.`: `v=DMARC1; p=none; rua=mailto:dmarc@domain`
  Rollout: `p=none` (monitor) → `p=quarantine; pct=25` → `p=reject`.

Verify with `dig TXT domain +short`, `dig TXT <selector>._domainkey.domain
+short`, `dig TXT _dmarc.domain +short` — no output means missing.
**Asyncify implication:** the integrations UI/docs should surface this
checklist when a customer installs an email provider; "my emails go to
spam" tickets start here, not in our code.

## 2. Reputation: warm up, split domains, watch two numbers

- **New domain/IP warming:** week 1: 50–100/day → week 2: 200–500 →
  week 3: 1–2k → week 4: 5–10k. Engaged users first, consistent volume.
  Our per-channel rate limiter (`EMAIL_SENDS_PER_SEC`) is the enforcement
  knob for a warming schedule.
- **Subdomain separation:** transactional on `t.domain`, marketing on
  `m.domain` — a marketing complaint storm must not burn OTP reputation.
  This is the DNS-level twin of our P0/P1 vs P2 queue isolation; recommend
  customers configure two integrations with different From domains.
- **The two health numbers:** bounce rate <4% (critical above), complaint
  rate <0.1% (critical above 0.05%). Our Analytics page has the raw data;
  these thresholds are what "bad" means.

## 3. Bounces and complaints (built — with one nuance)

- **Hard bounce** (permanent: bad mailbox) → suppress immediately.
  ✅ Built: `bounced`/`complaint` webhooks → suppressions table → fan-out
  skips forever. FCM dead tokens reuse the same path.
- **Soft bounce** (transient: full mailbox, greylisting) → retry with
  backoff, give up after 3–5 attempts, do NOT suppress. ✅ Matches our
  TransientError retry path — providers must classify mailbox-full-style
  SMTP responses as transient, not permanent.
- Complaints (spam reports) are worse than bounces — suppress instantly
  and never re-add without fresh consent.

## 4. Provider error classification (the contract for every new provider)

When adding a provider to `src/providers/`, classify per this table — it
is exactly our TransientError/PermanentError taxonomy:

| Provider response | Class | Behavior |
|---|---|---|
| 5xx, timeout, DNS failure | Transient | retry w/ backoff → failover chain |
| 429 rate limit | Transient | retry; never counts against the address |
| 4xx bad request / auth | Permanent (config) | fail fast, surface vendor message |
| invalid address / unsubscribed recipient | Permanent (address) | fail, no failover (no provider can fix a bad address) |

Idempotency guidance for customers (docs/SDK): use **deterministic,
event-based transactionIds** (`order-confirm-${orderId}`), never
`Date.now()` — our dedupe window is 24h, same as industry practice.

## 5. Compliance — the rules and OUR GAPS

Not legal advice; the operating minimums:

- **CAN-SPAM (US):** opt-out link in every marketing email, honored ≤10
  business days, physical mailing address in the footer, truthful
  subject/From. ~$53k penalty per email.
- **GDPR (EU):** explicit opt-in for marketing, unsubscribe processed
  immediately and as easy as subscribing, consent records (who/when/
  how/what), right to deletion.
- **CASL (Canada):** express consent, unsubscribe functional 60 days
  after send.
- **Transactional emails are exempt from opt-in** everywhere (receipts,
  OTPs, resets) — but only if genuinely non-promotional. This is why the
  transactional/marketing split (P0-P1 vs P2) must stay clean.

**Known product gaps (roadmap when marketing use-cases arrive):**
1. `List-Unsubscribe` + `List-Unsubscribe-Post` headers (RFC 8058
   one-click) on P2/marketing email — Gmail/Yahoo now require them for
   bulk senders.
2. An unsubscribe link/landing endpoint that writes to a per-subscriber
   marketing opt-out (our `preferences.channels` is close, but there is
   no public unsubscribe URL).
3. Consent capture fields on subscribers (consented_at, source, scope).
4. Physical-address footer block in marketing templates.
Until these exist, position Asyncify for transactional + product
notifications; don't market it for cold/bulk marketing email.

## 6. Debugging "emails go to spam" — fixed order

1. **Authentication** (SPF/DKIM/DMARC — the cause in most cases)
2. **Reputation** (blacklists, complaint rate, Google Postmaster Tools)
3. **Content** (spammy subjects, image-only bodies, link shorteners)
4. **Sending pattern** (sudden volume spikes — warming violated)
Never start at 3; content is rarely the culprit.
