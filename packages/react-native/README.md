# @asyncify-hq/react-native

Native push registration for [Asyncify](https://asyncify.org): one hook that
wires a device's FCM token into your Asyncify subscriber, asks for the OS
notification permission, follows token rotation, and surfaces foreground
messages. Built on [React Native Firebase](https://rnfirebase.io) — the OS is
the push receiver, so there is no service worker to run.

## Install

```bash
npm install @asyncify-hq/react-native
```

This package has required peers — install and configure them too:

```bash
npm install @react-native-firebase/app @react-native-firebase/messaging
```

Follow the React Native Firebase
[getting-started guide](https://rnfirebase.io/#installation) to add your
`google-services.json` (Android) / APNs key (iOS) and the `@react-native-firebase/app`
config plugin. `react` and `react-native` are peers you already have.

## Usage

Your backend mints a short-lived, single-subscriber token with
[`@asyncify-hq/node`](https://www.npmjs.com/package/@asyncify-hq/node)
(API keys never reach the device):

```ts
// backend
const { token } = await asyncify.subscriberToken(user.id);
```

```tsx
// app
import { usePushRegistration } from '@asyncify-hq/react-native';

function PushToggle({ token }: { token: string }) {
  const push = usePushRegistration({
    token,
    apiUrl: 'https://api.your-deployment.com',
    onForegroundMessage: (msg) => console.log('foreground push', msg),
  });

  if (!push.supported) return null;

  return (
    <Button
      title={push.enabled ? 'Disable push' : 'Enable push'}
      disabled={push.busy}
      onPress={push.enabled ? push.disable : push.enable}
    />
  );
}
```

`enable()` prompts for the notification permission, reads the FCM token, and
registers the device. The hook also re-registers silently after a token
rotation (the server upsert is idempotent), so you call `enable()` once.

### The `localhost` warning

`apiUrl` is **required** and must be reachable **from the phone**. On a device,
`localhost` / `127.0.0.1` is the phone itself — not your laptop. Point `apiUrl`
at a LAN IP or a public tunnel (e.g. the cloudflare URL that `asyncify dev`
prints), never `localhost`.

## Hook API

```ts
const {
  supported,   // boolean — true on Android/iOS
  permission,  // 'granted' | 'denied' | 'prompt'
  enabled,     // boolean — true once the device is registered
  busy,        // boolean — an enable()/disable() is in flight
  error,       // string | null — last explicit-action error
  enable,      // () => Promise<void>
  disable,     // () => Promise<void>
} = usePushRegistration({ token, apiUrl, onForegroundMessage });
```

Background and quit-state notifications are displayed by the OS automatically;
`onForegroundMessage` fires **only** while the app is open.

## Sticky opt-out

`disable()` must survive an app relaunch — otherwise, since the OS notification
permission is still granted, the hook would silently re-register a fresh token
on the next launch and undo the user's opt-out. To make it stick, the hook
persists an opt-out marker (`asyncify:push:opted-out`) via
[`@react-native-async-storage/async-storage`](https://react-native-async-storage.github.io/async-storage/),
which is an **optional peer**: `disable()` sets it, `enable()` clears it, and a
launch that sees it skips the silent re-register. Install async-storage to get
this behavior:

```bash
npm install @react-native-async-storage/async-storage
```

Without async-storage the hook still works, but a `disable()` only lasts until
the next app launch (the marker can't be persisted). The marker stores an
opt-**out**, so users who never call `disable()` keep the zero-config
auto-register behavior with no storage library at all.

## iOS note

The code is platform-neutral — the same hook drives Android and iOS. iOS
additionally requires an APNs key uploaded in the Firebase console and a Mac
build (Xcode / an Apple Developer account). This package has been **verified
live on Android only**; iOS is wired but unverified.

MIT © Shubam Patil
