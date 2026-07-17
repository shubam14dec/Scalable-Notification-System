---
"@asyncify-hq/react": minor
---

Add `usePushRegistration()` — a headless hook for web push. It requests notification permission, registers a Firebase FCM device with `/v1/me/devices`, silently re-mints the rotating FCM token on mount, and tears down on disable. `firebase` is an optional peer dependency loaded via dynamic import; the package keeps zero runtime dependencies.
