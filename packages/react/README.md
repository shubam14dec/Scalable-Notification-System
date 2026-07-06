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

MIT © Shubam Patil
