# @asyncify-hq/react

## 0.7.0

### Minor Changes

- 8cfbdc2: Add `usePushRegistration()` — a headless hook for web push. It requests notification permission, registers a Firebase FCM device with `/v1/me/devices`, silently re-mints the rotating FCM token on mount, and tears down on disable. `firebase` is an optional peer dependency loaded via dynamic import; the package keeps zero runtime dependencies.

## 0.6.0

### Minor Changes

- 0c5a812: Add a QrCode component, an inline "scan with your phone" Telegram QR in ConnectChannels, and an AgentChat welcome message with tappable suggested-prompt chips.

## 0.5.0

### Minor Changes

- e7b1d10: New ConnectChannels component + useConnectChannels hook: end users link their own Telegram/Slack identities (and see email auto-links) from any app embedding the widget, with self-service unlink.

## 0.4.0

### Minor Changes

- 11f6d36: AgentChat renders select and text-input cards natively and streams plan-card progress via live message updates.

## 0.3.0

### Minor Changes

- 0b8a1f4: AgentChat: message edit/delete (own messages, optimistic with revert), live tombstones and (edited) markers from operator actions, and a typing indicator driven by conversation.typing events.
