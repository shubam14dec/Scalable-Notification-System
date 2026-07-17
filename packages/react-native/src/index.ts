import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';

/**
 * @asyncify-hq/react-native — native push registration for Asyncify.
 *
 *   const push = usePushRegistration({
 *     token,                                   // subscriber token (nst_...) from your backend
 *     apiUrl: 'https://api.your-deployment.com',
 *   });
 *   <Button title="Enable push" onPress={push.enable} disabled={push.busy} />
 *
 * The subscriber token is scoped to one end user and short-lived — no API key
 * ever reaches the device. The hook drives the whole FCM lifecycle: it asks
 * for the OS notification permission, reads the device's FCM token, and
 * registers it against the caller's subscriber via POST /v1/me/devices. It
 * also re-registers silently when the OS rotates the token (server upsert is
 * idempotent) and, if you pass `onForegroundMessage`, surfaces messages that
 * land while the app is in the foreground.
 *
 * There is no service worker here — unlike the web, the OS itself is the push
 * receiver. Notification-type messages are shown by the system automatically
 * while the app is backgrounded or killed; the app only gets a callback for
 * foreground messages (see `onForegroundMessage`).
 *
 * IMPORTANT — `apiUrl` is required and must be reachable FROM THE PHONE. On a
 * device, `localhost` / `127.0.0.1` means the phone itself, not your laptop.
 * Point it at a LAN IP or a public tunnel (e.g. an `asyncify dev` cloudflare
 * URL), never `localhost`.
 */

export type PushPermission = 'granted' | 'denied' | 'prompt';

/** A push message delivered to the app while it is in the foreground. */
export interface PushMessage {
  title?: string;
  body?: string;
  data?: Record<string, string>;
}

export interface UsePushRegistrationOptions {
  /** Subscriber token (`nst_...`) minted by your backend for this end user. */
  token: string;
  /**
   * Asyncify REST base, e.g. "https://api.example.com". REQUIRED — on a phone
   * `localhost` is the phone, so this must be a LAN IP or a public tunnel URL.
   */
  apiUrl: string;
  /**
   * Called for each message that arrives while the app is in the foreground.
   * Background/quit-state notifications are displayed by the OS automatically
   * and do NOT invoke this callback.
   */
  onForegroundMessage?: (msg: PushMessage) => void;
}

export interface UsePushRegistration {
  /** True on Android/iOS; false on any other platform (e.g. web, where you'd use @asyncify-hq/react). */
  supported: boolean;
  /** Best-known OS notification permission state. `prompt` = not yet asked. */
  permission: PushPermission;
  /** True once this device's FCM token is registered against the subscriber. */
  enabled: boolean;
  /** True while an enable()/disable() round-trip is in flight. */
  busy: boolean;
  /** Last error surfaced by an explicit enable()/disable(), else null. */
  error: string | null;
  /** Ask for permission (if needed), read the FCM token, and register the device. */
  enable: () => Promise<void>;
  /** Unregister the device and drop its FCM token. */
  disable: () => Promise<void>;
}

const SUPPORTED = Platform.OS === 'android' || Platform.OS === 'ios';

/**
 * Sticky opt-out marker. disable() must last across app launches: without it,
 * the mount effect would see the OS permission still granted and silently
 * re-register a fresh token on every relaunch, undoing the user's opt-out.
 * We persist the OPT-OUT (not opt-in) so that users who never call disable()
 * keep the zero-config auto-register behavior even with no storage library.
 */
const OPT_OUT_KEY = 'asyncify:push:opted-out';

type StorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/**
 * @react-native-async-storage/async-storage is an OPTIONAL peer. Loaded lazily
 * and guarded so the package works without it — if it is absent, the opt-out
 * simply cannot be persisted (disable() then lasts only until the next launch).
 */
async function loadStorage(): Promise<StorageLike | null> {
  try {
    const mod = await import('@react-native-async-storage/async-storage');
    return ((mod as { default?: StorageLike }).default ?? (mod as unknown as StorageLike)) ?? null;
  } catch {
    return null;
  }
}

async function readOptedOut(): Promise<boolean> {
  const storage = await loadStorage();
  if (!storage) return false;
  try {
    return (await storage.getItem(OPT_OUT_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeOptedOut(value: boolean): Promise<void> {
  const storage = await loadStorage();
  if (!storage) return; // no storage lib → opt-out can't be persisted; degrade gracefully.
  try {
    if (value) await storage.setItem(OPT_OUT_KEY, '1');
    else await storage.removeItem(OPT_OUT_KEY);
  } catch {
    /* best-effort */
  }
}

/** Body `platform` value for the devices API — only reached on a supported OS. */
function currentPlatform(): 'android' | 'ios' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/**
 * Whether the app currently HAS the notification permission, without prompting.
 * Android < 33 has no runtime notification permission, so it is granted by
 * default; Android 13+ gates on POST_NOTIFICATIONS; iOS reads the auth status.
 */
async function hasNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
      return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    return true;
  }
  const status = await messaging().hasPermission();
  return (
    status === messaging.AuthorizationStatus.AUTHORIZED ||
    status === messaging.AuthorizationStatus.PROVISIONAL
  );
}

/** Prompt for the notification permission and report whether it was granted. */
async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }
  const status = await messaging().requestPermission();
  return (
    status === messaging.AuthorizationStatus.AUTHORIZED ||
    status === messaging.AuthorizationStatus.PROVISIONAL
  );
}

export function usePushRegistration({
  token,
  apiUrl,
  onForegroundMessage,
}: UsePushRegistrationOptions): UsePushRegistration {
  const [permission, setPermission] = useState<PushPermission>('prompt');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The last FCM token we registered, so disable() and refresh can address it.
  const fcmTokenRef = useRef<string | null>(null);
  // Mirror `enabled` into a ref so the long-lived onTokenRefresh callback can
  // read the live value without being re-subscribed on every state change.
  const enabledRef = useRef(false);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const registerDevice = useCallback(
    async (fcmToken: string) => {
      const res = await fetch(`${apiUrl}/v1/me/devices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-subscriber-token': token },
        body: JSON.stringify({ token: fcmToken, platform: currentPlatform() }),
      });
      if (!res.ok) throw new Error(`device registration failed (${res.status})`);
    },
    [apiUrl, token],
  );

  const unregisterDevice = useCallback(
    async (fcmToken: string) => {
      await fetch(`${apiUrl}/v1/me/devices`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-subscriber-token': token },
        body: JSON.stringify({ token: fcmToken }),
      });
    },
    [apiUrl, token],
  );

  const enable = useCallback(async () => {
    if (!SUPPORTED) return;
    setBusy(true);
    setError(null);
    try {
      const granted = await requestNotificationPermission();
      if (!granted) {
        setPermission('denied');
        setEnabled(false);
        return; // error stays cleared — a denial is a choice, not a failure.
      }
      setPermission('granted');
      await writeOptedOut(false); // an explicit enable clears any sticky opt-out.
      const fcmToken = await messaging().getToken();
      await registerDevice(fcmToken);
      fcmTokenRef.current = fcmToken;
      setEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [registerDevice]);

  const disable = useCallback(async () => {
    if (!SUPPORTED) return;
    setBusy(true);
    setError(null);
    try {
      // Remove the token we hold (or the current one) from the server first,
      // then drop it locally — deleteToken() invalidates it for future sends.
      const fcmToken = fcmTokenRef.current ?? (await messaging().getToken().catch(() => null));
      if (fcmToken) await unregisterDevice(fcmToken);
      await messaging().deleteToken().catch(() => undefined); // best-effort
      // Persist the opt-out so a relaunch doesn't silently re-register.
      await writeOptedOut(true);
      fcmTokenRef.current = null;
      setEnabled(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [unregisterDevice]);

  // Mount: subscribe to token rotation, and if permission is already granted,
  // silently re-register the current token (idempotent upsert) to catch a
  // token that rotated while the app was closed.
  useEffect(() => {
    if (!SUPPORTED) return;
    let alive = true;

    const unsubscribeRefresh = messaging().onTokenRefresh((rotated) => {
      fcmTokenRef.current = rotated;
      if (enabledRef.current) {
        registerDevice(rotated).catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
      }
    });

    void (async () => {
      try {
        const granted = await hasNotificationPermission();
        if (!alive) return;
        setPermission(granted ? 'granted' : 'prompt');
        if (!granted) return;
        // Respect a sticky opt-out: a prior disable() must survive relaunch,
        // even though the OS permission is still granted. onTokenRefresh stays
        // subscribed above but is gated on enabledRef, which remains false here.
        if (await readOptedOut()) return;
        if (!alive) return;
        const fcmToken = await messaging().getToken();
        if (!alive) return;
        fcmTokenRef.current = fcmToken;
        await registerDevice(fcmToken);
        if (alive) setEnabled(true);
      } catch {
        // Silent on mount — errors are only surfaced for explicit user actions
        // (enable/disable). A background sync failure must not paint an error.
      }
    })();

    return () => {
      alive = false;
      unsubscribeRefresh();
    };
  }, [registerDevice]);

  // Foreground messages. Background/quit-state notification display is handled
  // by the OS automatically — this callback fires ONLY while the app is open.
  useEffect(() => {
    if (!SUPPORTED || !onForegroundMessage) return;
    const unsubscribe = messaging().onMessage((remoteMessage) => {
      onForegroundMessage({
        title: remoteMessage.notification?.title,
        body: remoteMessage.notification?.body,
        data: remoteMessage.data as Record<string, string> | undefined,
      });
    });
    return unsubscribe;
  }, [onForegroundMessage]);

  return { supported: SUPPORTED, permission, enabled, busy, error, enable, disable };
}
