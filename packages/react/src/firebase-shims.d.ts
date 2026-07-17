/**
 * Ambient shims for the OPTIONAL `firebase` peer dependency. This package ships
 * zero runtime dependencies; usePushRegistration reaches firebase only through
 * runtime dynamic import() when the host app has installed it. These minimal
 * declarations let our OWN build type-check without firebase present. They are
 * never imported into the entry's type graph, so they are not emitted into the
 * published .d.ts and cannot clash with a consumer's real firebase types — the
 * consumer's installed firebase supplies the authoritative declarations there.
 */
declare module 'firebase/app' {
  export type FirebaseApp = unknown;
  export function initializeApp(config: Record<string, unknown>): FirebaseApp;
  export function getApps(): FirebaseApp[];
}

declare module 'firebase/messaging' {
  import type { FirebaseApp } from 'firebase/app';
  export type Messaging = unknown;
  export function getMessaging(app?: FirebaseApp): Messaging;
  export function getToken(
    messaging: Messaging,
    options: { vapidKey?: string; serviceWorkerRegistration?: ServiceWorkerRegistration },
  ): Promise<string>;
  export function deleteToken(messaging: Messaging): Promise<boolean>;
}
