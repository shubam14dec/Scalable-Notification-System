# @asyncify-hq/react

Drop-in notification inbox for [Asyncify](https://asyncify.org): a bell with
an unread badge, a dropdown inbox, live WebSocket updates and mark-all-read —
themable, self-contained, zero styling dependencies.

## Install

```bash
npm install @asyncify-hq/react
```

## Quickstart

Your backend mints a short-lived, single-subscriber token with
[`@asyncify-hq/node`](https://www.npmjs.com/package/@asyncify-hq/node)
(API keys never reach the browser):

```ts
// backend
const { token } = await asyncify.subscriberToken(user.id);
```

```tsx
// frontend
import { NotificationInbox } from '@asyncify-hq/react';

<NotificationInbox
  token={token}
  subscriberId={user.id}
  apiUrl="https://api.your-deployment.com"
  wsUrl="wss://ws.your-deployment.com"
  theme="dark"          // or "light"
  align="right"         // "left" when the bell sits near a left edge
/>;
```

Notifications arrive live over WebSocket while the tab is open; the durable
inbox loads over REST on mount, so nothing is missed while offline.

## Headless option

Bring your own UI with the hook:

```tsx
import { useNotifications } from '@asyncify-hq/react';

const { items, unread, connected, markAllRead } = useNotifications({
  token,
  subscriberId: user.id,
  apiUrl,
  wsUrl,
});
```

## Web push

`usePushRegistration()` registers the current browser as a push device so your
Asyncify **push** workflow steps reach it via Firebase Cloud Messaging (FCM).
It's headless — you own the toggle UI.

`firebase` is an **optional peer dependency**: this package pulls in nothing at
runtime, and only loads firebase (via dynamic `import`) when push is actually
used. Install it in the host app:

```bash
npm install firebase
```

```tsx
import { usePushRegistration } from '@asyncify-hq/react';

function PushToggle({ token }: { token: string }) {
  const { supported, permission, enabled, busy, error, enable, disable } =
    usePushRegistration({
      token,                       // the same subscriber token the inbox uses
      apiUrl: 'https://api.your-deployment.com',
      firebaseConfig: {            // from your Firebase web app settings
        apiKey: '…',
        projectId: '…',
        messagingSenderId: '…',
        appId: '…',
      },
      vapidKey: '…',               // Cloud Messaging → Web Push certificates
    });

  if (!supported) return <p>This browser can't receive push.</p>;

  return (
    <button
      disabled={busy || permission === 'denied'}
      onClick={() => (enabled ? disable() : enable())}
    >
      {enabled ? 'Disable push' : 'Enable push'}
      {error ? ` — ${error}` : ''}
    </button>
  );
}
```

`enable()` prompts for notification permission, mints an FCM token, and
registers it. On mount, a browser that already granted permission silently
re-mints its token (FCM tokens rotate) and re-registers — no prompt. If
`firebase` isn't installed, `error` reads
`push requires the firebase package — npm install firebase`.

`disable()` persists a `localStorage` opt-out under the key
**`asyncify:push:opted-out`** (value `"1"`). Because the browser's notification
permission stays `granted` after you disable push, this marker is what stops the
mount effect from silently re-registering the device on the next page load;
`enable()` clears it. If you offer your own "reset notification settings"
control, clear this key to restore the on-mount rotation-sync behaviour.

### The service worker (required)

FCM delivers background messages to a **service worker**, not your page — a
receiver that outlives the tab so notifications arrive even when your site
isn't open. The browser will only load a service worker that controls the
whole origin, which means the file **must be served from your site's root**
(e.g. `https://your-site.com/firebase-messaging-sw.js`) — a worker under a
subpath can't control the origin, and one from a CDN is a different origin
entirely. Serve this file verbatim at that root (it's the default the hook
registers; override with `serviceWorkerPath` only if you truly must):

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
// SDK still auto-displays alongside it, so users would get every push TWICE.
firebase.messaging();
```

MIT © Shubam Patil
