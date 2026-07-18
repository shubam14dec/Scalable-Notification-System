# Asyncify Push & SMS — Customer Guide

*How to reach your users on their phones — a banner on the lock screen, a text
in their messages app — safely, cheaply, and with no surprises about what
"delivered" really means. Told through **Acme**, an e-commerce company.*

---

## The cast

- **Acme** — your company. Sells things online, has a website and a mobile app,
  ships orders.
- **Priya** — Acme's frontend engineer. Owns the website and the mobile app;
  wires up the browser and device push toggles.
- **Sam** — Acme's backend engineer. Owns the server: creates subscribers,
  fires workflows, registers devices from the backend.
- **Maya** — Acme's customer. Wants to know the moment her order ships, on
  whatever device is in her hand.

Everything below is the story of these three people getting a shipping
notification onto Maya's phone.

---

## 1. Two channels, one honest promise

Push and SMS both land on a phone, but they behave differently — and the most
important difference is what you can *know* after you hit send:

```
                 ┌──────────────────────────────────────────────┐
   Acme fires    │                  ASYNCIFY                     │
   a workflow ──►│                                              │
                 │   SMS  ──► Twilio ──► carrier ──► Maya's SMS  │──► receipt:
                 │            (delivery receipts flow back)      │    sent → delivered/failed
                 │                                              │
                 │   PUSH ──► FCM ──► Apple/Google ──► Maya's OS │──► receipt:
                 │            ("sent" = FCM accepted it)         │    sent  (no display proof)
                 └──────────────────────────────────────────────┘
```

- **SMS** gives you a real delivery receipt: Acme's Activity feed advances a
  message from `sent` to `delivered` (or `failed`) once the carrier reports
  back. It costs money per message, so it has guardrails (segment limits, STOP
  handling).
- **PUSH** is free and instant, but honest: `sent` means Google's Firebase
  Cloud Messaging (FCM) *accepted* the message. Whether a banner actually
  appears is the operating system's call — Do Not Disturb, a force-quit app, or
  a revoked permission can all swallow it silently, and no receipt comes back.

Keep that distinction in mind; section 8 is entirely about it.

---

## 2. Setup — connect Twilio and FCM

All delivery vendors are managed on the dashboard's **Integrations** page (or
the `/v1/integrations` API). Credentials are validated against the provider's
schema, sealed with AES-256-GCM, and **never returned by any endpoint** — the
list only ever shows the provider, channel, and status.

### Twilio (for SMS)

Add an integration with channel **sms**, provider **twilio**, and three
credentials from your Twilio console:

```bash
curl -X POST https://api.your-deployment.com/v1/integrations \
  -H "x-api-key: <your ak_ key>" \
  -H "content-type: application/json" \
  -d '{
    "channel": "sms",
    "provider": "twilio",
    "credentials": {
      "accountSid": "AC……",
      "authToken":  "……",
      "from":       "+15551234567"
    }
  }'
```

`accountSid` must start with `AC`; `from` is the Twilio number your texts are
sent from. Hit **Send test** on the integration to fire one real SMS before you
wire a workflow.

### FCM (for push) — one server secret, and public client config

Push has two halves that people often confuse. Getting the split right is the
whole setup, so here it is plainly:

| | What it is | Where it lives | Secret? |
|---|---|---|---|
| **Service-account JSON** | A Firebase service account (has `project_id` + `private_key`) | Acme's Asyncify integration, server-side only | **Yes — never ship it to a browser** |
| **`firebaseConfig`** | `apiKey`, `projectId`, `messagingSenderId`, `appId` | Priya's frontend code + the service worker | No — public by design |
| **VAPID key** | The Web Push certificate public key | Priya's frontend code | No — public by design |

One analogy: the service-account JSON is the **key to the post office's back
door** — only Acme's server holds it, and it's what lets the server drop mail
into the FCM system. The `firebaseConfig` and VAPID key are the **printed
address label** a browser sticks on itself so FCM knows which mailbox to fill;
they're meant to be handed out, and Firebase's own web setup prints them into
client code.

So on the Integrations page you add channel **push**, provider **fcm**, with a
single credential — the service-account JSON as a string:

```bash
curl -X POST https://api.your-deployment.com/v1/integrations \
  -H "x-api-key: <your ak_ key>" \
  -H "content-type: application/json" \
  -d '{
    "channel": "push",
    "provider": "fcm",
    "credentials": { "serviceAccountJson": "{\"project_id\":\"…\",\"private_key\":\"…\", …}" }
  }'
```

The `firebaseConfig` and `vapidKey` don't go here — they belong in Priya's app
(sections 3 and 4). The server never needs them; the browser never needs the
service account.

---

## 3. Subscribers need a valid phone

Before Sam can text Maya, her subscriber record needs a phone number — and
Asyncify is strict about the format on purpose. Phones must be **E.164**: a
leading `+` followed by 8–15 digits, e.g. `+919901489187`.

Sam sets it with the node SDK (or a `PUT /v1/subscribers`):

```ts
import { AsyncifyClient } from '@asyncify-hq/node';
const asyncify = new AsyncifyClient({ apiKey: process.env.ASYNCIFY_API_KEY! });

await asyncify.subscribers.upsert({
  subscriberId: 'user-42',
  email: 'maya@example.com',
  phone: '+91 99014 89187',   // spaces, dashes, dots, parens, and a leading 00 are fine
});
```

Separators are normalized away, so `+91 99014 89187`, `+91-99014-89187`, and
`0091 99014 89187` all store as `+919901489187`. But Asyncify **never guesses a
country** — a bare `9901489187` is a different number in every country, so it's
rejected rather than mangled. An invalid number comes back as a clear `400`:

```json
{ "error": "invalid body",
  "details": [{ "message": "phone must be E.164, e.g. +919901489187" }] }
```

The same rule applies to inline recipient phones passed straight into a trigger
— they're normalized (or rejected) exactly the same way.

---

## 4. Web push — Priya wires the browser (`@asyncify-hq/react`)

For Acme's website, Priya uses the `usePushRegistration` hook. It's
**headless** — it owns the whole FCM lifecycle (ask permission, mint a device
token, register it), and Priya owns the toggle UI.

`firebase` is an **optional peer dependency**: the package pulls in nothing at
runtime and only loads firebase when push is actually used. Install it in the
host app:

```bash
npm install firebase
```

```tsx
import { usePushRegistration } from '@asyncify-hq/react';

function PushToggle({ token }: { token: string }) {
  const { supported, permission, enabled, busy, error, enable, disable } =
    usePushRegistration({
      token,                       // the same subscriber token the inbox widget uses
      apiUrl: 'https://api.your-deployment.com',
      firebaseConfig: {            // public — from your Firebase web app settings
        apiKey: '…',
        projectId: '…',
        messagingSenderId: '…',
        appId: '…',
      },
      vapidKey: '…',               // public — Cloud Messaging → Web Push certificates
      // serviceWorkerPath?: '/firebase-messaging-sw.js'  (default; see below)
    });

  if (!supported) return <p>This browser can't receive push.</p>;

  return (
    <button disabled={busy || permission === 'denied'}
            onClick={() => (enabled ? disable() : enable())}>
      {enabled ? 'Disable push' : 'Enable push'}{error ? ` — ${error}` : ''}
    </button>
  );
}
```

The hook hands back exactly this state: `supported`, `permission`
(`granted` / `denied` / `prompt`), `enabled`, `busy`, `error`, plus the
`enable()` and `disable()` actions. If `firebase` isn't installed, `error`
reads `push requires the firebase package — npm install firebase`.

A few behaviors worth knowing:

- **`enable()`** prompts for notification permission, mints an FCM token, and
  registers this browser as a device.
- **Token rotation is silent.** FCM tokens rotate; on mount, a browser that
  already granted permission quietly re-mints its token and re-registers — no
  prompt, no fuss: the server upsert is idempotent.
- **`disable()` is sticky.** Because a browser's notification permission stays
  `granted` after you disable push, Asyncify writes a `localStorage` opt-out
  marker under the key **`asyncify:push:opted-out`** (value `"1"`). That marker
  is what stops the mount effect from silently re-registering on the next page
  load; `enable()` clears it. If you build your own "reset notifications"
  control, clear this key to restore the on-mount rotation-sync.

### The service worker (required)

FCM delivers background messages to a **service worker**, not your page — a
receiver that outlives the tab. The browser only loads a worker that controls
the whole origin, so the file **must be served from your site's root**
(e.g. `https://your-site.com/firebase-messaging-sw.js`). Serve this file
verbatim at that root — it's the default the hook registers (override with
`serviceWorkerPath` only if you truly must). Keep it in sync with the copy in
the [`@asyncify-hq/react` README](../packages/react/README.md):

```js
// firebase-messaging-sw.js  — served at your site's ORIGIN ROOT
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// New versions of this file take over on the next page load, not "eventually".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

firebase.initializeApp({
  apiKey: '…',
  projectId: '…',
  messagingSenderId: '…',
  appId: '…',
});

// Firebase auto-displays every notification-carrying push (title/body/image),
// but its built-in click handler only opens SAME-ORIGIN links (hard host check
// in the SDK source). This listener — registered BEFORE firebase.messaging()
// so it runs first — opens the click-through link for ANY origin, then stops
// the event so the SDK's handler doesn't double-handle it.
self.addEventListener('notificationclick', (event) => {
  const msg = event.notification && event.notification.data && event.notification.data.FCM_MSG;
  const link =
    msg &&
    ((msg.notification && msg.notification.click_action) ||
      (msg.fcmOptions && msg.fcmOptions.link));
  if (!link) return;
  event.stopImmediatePropagation();
  event.notification.close();
  event.waitUntil(self.clients.openWindow(link));
});

// Do NOT add an onBackgroundMessage handler that calls showNotification: the
// SDK still auto-displays alongside it, so Maya would get every push TWICE.
firebase.messaging();
```

---

## 5. Native push — the same shape, on the phone (`@asyncify-hq/react-native`)

Priya's mobile teammate uses `usePushRegistration` from
`@asyncify-hq/react-native`. It reads almost identically to the web hook — same
returned state (`supported`, `permission`, `enabled`, `busy`, `error`,
`enable`, `disable`) — with two differences that matter:

```tsx
import { usePushRegistration, type PushMessage } from '@asyncify-hq/react-native';

const push = usePushRegistration({
  token,                                    // subscriber token (nst_…) from your backend
  apiUrl: 'https://api.your-deployment.com', // REQUIRED — must be reachable FROM THE PHONE
  onForegroundMessage: (msg: PushMessage) => {
    // Fires ONLY while the app is open. Background/killed display is the OS's job.
    console.log(msg.title, msg.body, msg.data);
  },
});
```

- **`apiUrl` is required, and never `localhost`.** On a device, `localhost` /
  `127.0.0.1` means *the phone itself*, not your laptop. Point it at a LAN IP or
  a public tunnel (e.g. an `asyncify dev` cloudflare URL).
- **No service worker.** Unlike the web, the OS is the receiver.
  Notification-type messages are displayed by the system automatically while the
  app is backgrounded or killed — no app code runs. The app only gets a callback
  (`onForegroundMessage`) for messages that arrive while it's open.

Sticky opt-out works the same way, under the same marker
`asyncify:push:opted-out`, if you install the **optional peer**
`@react-native-async-storage/async-storage`. Without it, everything still works
— a `disable()` just lasts only until the next app launch, since there's nowhere
to persist the opt-out.

**A working reference:** [`examples/push-test-app`](../examples/push-test-app) is
a minimal Expo app that builds an APK via EAS cloud builds (no local Android
toolchain), so you can put a real notification on a real Android phone with the
app closed.

> **iOS honesty note.** The code is platform-neutral and iOS is wired in
> `app.json`, but iOS additionally needs an **APNs key uploaded to the Firebase
> console** and a **Mac build**. This harness is verified live on Android; iOS
> is coded but not yet verified end-to-end here.

---

## 6. Many devices, one person

Maya has a laptop, a phone, and a tablet. Push handles that natively:

- A subscriber holds **up to 10 devices**. Registering an 11th evicts the
  least-recently-seen one.
- A push step sends **one message per device**, each with its own delivery
  status in Activity — so you can see exactly which device took it.
- **Dead tokens self-heal.** When FCM reports a token as no longer registered,
  Asyncify removes that device automatically; the app re-registers a fresh token
  on next launch (rotation, section 4/5).
- **The legacy single `pushToken` field still works.** If Sam sets `pushToken`
  on a subscriber (via `subscribers.upsert`), it's mirrored forward into the
  same multi-device table and delivered like any other device. You can adopt the
  device APIs incrementally.

Devices can be registered three ways, all feeding the same table: the browser
hook (section 4), the native hook (section 5), or Sam's backend (section 9).

---

## 7. Rich push — click-throughs, images, and data

A push step can carry extras beyond title and body. In the dashboard's workflow
editor, open a **push** step and fill in the **Rich push** panel (these fields
exist only on push steps):

| Field | What it does |
|---|---|
| **`clickUrl`** | Web: the notification is a click-through to this URL. Native: the OS always opens the app on tap (there is no browser-opens-directly path); the hook then forwards `clickUrl` to the browser automatically — pass `openClickUrlOnTap: false` to receive taps yourself instead (the URL also rides in the message `data`). |
| **`imageUrl`** | A big picture in the banner — rendered on web, Android, and iOS. |
| **`data`** | Up to 10 custom key/value string pairs, delivered to the app (native reads these in `onForegroundMessage` / the background handler). |

The same thing as a push step in the workflow definition (`PUT /v1/workflows`):

```json
{
  "channel": "push",
  "subject": "Your order shipped 📦",
  "body": "Order {{orderId}} is on its way, {{name}}.",
  "push": {
    "clickUrl": "https://acme.com/orders/{{orderId}}",
    "imageUrl": "https://acme.com/img/shipped.png",
    "data": { "orderId": "{{orderId}}", "kind": "shipment" }
  }
}
```

**Handlebars variables render in all three** (`subject`, `body`, and the `push`
URLs/data) against the trigger payload. Two practical notes:

- `data` values must be strings (that's an FCM rule) — the editor and API accept
  string values only.
- A literal `clickUrl` / `imageUrl` is safety-checked when you save the workflow
  (it can't point at an internal address). A URL that carries `{{…}}` variables
  is resolved per-recipient at send time instead.

---

## 8. SMS — segments, the live meter, and the cost guard

SMS is billed **per segment**, and the segment size depends on the characters
in the body:

| Encoding | When | 1 segment | Each further segment |
|---|---|---|---|
| **GSM-7** | Plain text (basic Latin + common punctuation) | 160 chars | 153 chars |
| **UCS-2 (Unicode)** | The moment any non-GSM character appears | 70 chars | 67 chars |

The catch: **one emoji (or an accented/non-Latin character) flips the whole
message to Unicode and roughly halves its capacity.** A 150-character message
that fits in one GSM-7 segment becomes three segments — and three times the
cost — the instant you add a 🎉.

Because of that, the workflow editor shows a **live counter** under the SMS
body — character count, segment count, and encoding — so authors see the cost
as they type. (When the body contains `{{…}}` variables, it notes the count is
"before variables," since the real send may differ once merged.)

And there's a hard backstop. A rendered SMS body over **10 segments** is treated
as an authoring mistake, not a transient fault: the send **fails visibly** in
Activity with a clear message, before any provider call or real SMS cost:

```
SMS body is 12 segments; the maximum is 10. Shorten the message
(an emoji or non-GSM character roughly halves the per-segment limit).
```

No silent 12-segment blast, no surprise bill.

---

## 9. Delivery receipts, honestly

This is the section to read twice, because push and SMS make very different
promises.

### SMS: real receipts, and automatic STOP handling

When Twilio accepts a text, Asyncify asks it to **post delivery receipts back**,
so Activity advances the message from `sent` to `delivered` or `failed` as the
carrier reports. Two honest caveats:

- **Receipts need a public URL.** The callback rides your runtime public URL —
  present in production, or provided locally by `asyncify dev`'s tunnel. Without
  a public URL the send still succeeds; you just don't get the `delivered`
  transition.
- **STOP texters are auto-suppressed.** If Maya replies STOP, that number is
  suppressed so future SMS fan-outs skip it — caught **both** ways: at send time
  (Twilio rejects with error `21610`) and asynchronously via the status callback
  (`ErrorCode 21610`). A genuinely bad number (Twilio `21211`) fails the message
  but is *not* suppressed — it's a data-entry error, not an opt-out.

### Push: "sent" is the whole story

Push has **no display receipt anywhere.** For a push message, `sent` means FCM
**accepted** it for delivery — nothing more. Whether a banner actually appears
on Maya's screen is entirely the operating system's decision:

- Do Not Disturb / Focus can swallow the banner.
- A force-quit app (on some platforms), a revoked permission, or a dead token
  can drop it.
- No "delivered" or "read" signal comes back, ever.

The one self-healing signal you *do* get is the reverse: when FCM tells Asyncify
a token is dead, that device is removed automatically (section 6). Design your
important flows so push is a *nudge*, not the only channel — pair it with email
or in-app for anything that must be seen.

---

## 10. Wire it end to end

A shipping notification onto Maya's phone, from both engineers' side:

**Sam (backend, `@asyncify-hq/node`):**

1. **Upsert the subscriber** with a valid phone (and/or email):
   ```ts
   await asyncify.subscribers.upsert({ subscriberId: 'user-42', phone: '+919901489187' });
   ```
2. **Register devices from the server**, if you collect tokens server-side —
   the API twins of the frontend hooks:
   ```ts
   await asyncify.subscribers.registerDevice({
     subscriberId: 'user-42', token: '<fcm-token>', platform: 'android',
   });
   await asyncify.subscribers.listDevices('user-42');            // { devices: [...] }
   await asyncify.subscribers.removeDevice({ subscriberId: 'user-42', token: '<fcm-token>' });
   ```
3. **Mint a subscriber token** for the frontend (never ship the api key):
   ```ts
   const { token } = await asyncify.subscriberToken('user-42');
   ```
4. **Fire the workflow** — push and SMS steps run per the workflow definition:
   ```ts
   await asyncify.trigger('order-shipped', {
     to: [{ subscriberId: 'user-42' }],
     payload: { orderId: 'ORD-1', name: 'Maya' },
   });
   ```

**Priya (frontend):**

5. Pass Sam's `token` into `usePushRegistration` — `@asyncify-hq/react` on the
   website (section 4), `@asyncify-hq/react-native` in the app (section 5) — and
   render an enable/disable toggle. Once Maya enables push, her device is
   registered and step 4's push reaches it.

That's the whole loop: Sam's server owns identity and triggers; Priya's clients
own the device registration and the toggle; Asyncify owns the fan-out, the
segment guard, the STOP handling, and the honest receipts in between.

---

*Deep dives: the [`@asyncify-hq/react` README](../packages/react/README.md)
(web push + the canonical service worker),
[`examples/push-test-app`](../examples/push-test-app) (a working native harness),
and package READMEs on npm. For the conversational side — agents on Telegram,
Slack, and the in-app widget — see
[docs/ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).*
