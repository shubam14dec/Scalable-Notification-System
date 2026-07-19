# @asyncify-hq/react-native

## 0.1.0

### Minor Changes

- 8cfbdc2: First release: `usePushRegistration` hook that registers a device's FCM token against an Asyncify subscriber for native push on Android and iOS — handling the notification permission, token rotation (idempotent re-register), device removal, and foreground-message delivery via React Native Firebase. Ships with the `react-native` package.json field pointing Metro at the ESM build (the Node-mode CJS build's default-import interop calls the firebase module object as a function and crashes on launch).
