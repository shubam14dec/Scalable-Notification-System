# Asyncify push test app

A minimal Expo app that proves [`@asyncify-hq/react-native`](../../packages/react-native)
on a real Android phone using **EAS cloud builds** — no local Android toolchain
required (works from Windows). You get an APK, install it, paste an API URL + a
subscriber token, tap **Enable Push**, and a workflow-triggered notification
lands on the phone with the app closed.

> This app is a test harness — it is `private` and never published to npm.

---

## Prerequisites

- A free [Expo](https://expo.dev) account.
- Node 20+ and the EAS CLI: `npm i -g eas-cli`.
- Access to the Firebase project **asyncify-dev** (for `google-services.json`).
- The Asyncify stack running locally with `asyncify dev` giving you a public
  tunnel URL (see step 5).

---

## 1. Firebase → download `google-services.json`

1. Open the [Firebase console](https://console.firebase.google.com/) → project
   **asyncify-dev**.
2. **Add app → Android**. Android package name: `io.asyncify.pushtest`
   (must match `app.json`). You can skip the SHA-1 for FCM.
3. Download the generated **`google-services.json`** and drop it into this
   directory (`examples/push-test-app/google-services.json`).

This file is git-ignored — every developer downloads their own.

## 2. Log in to EAS

```bash
npm i -g eas-cli
eas login
```

## 3. Install dependencies

From this directory:

```bash
cd examples/push-test-app
npm install
```

The app depends on the local package via `file:../../packages/react-native`.

> **Fallback if EAS upload chokes on the `file:` dependency.** EAS uploads a
> tarball of this project; a `file:` link outside the project root sometimes
> fails to resolve on their builders. If a build errors resolving
> `@asyncify-hq/react-native`, pack the package and install the tarball
> instead:
>
> ```bash
> npm pack ../../packages/react-native          # writes asyncify-hq-react-native-0.0.0.tgz here
> npm install ./asyncify-hq-react-native-0.0.0.tgz
> ```
>
> The `.tgz` is a throwaway build input and is already git-ignored.

## 4. Build the APK in the cloud

```bash
eas build -p android --profile preview
```

EAS runs the Gradle build on their Linux machines and prints a QR code / link
when done. Open it **on the phone**, download the APK, and install it (allow
"install from unknown sources" if prompted). This is a standalone build — the
native Firebase messaging module is compiled in, which is why a plain Expo Go
client cannot be used.

## 5. Point the app at your backend

On the laptop, start the stack and the tunnel:

```bash
# from the repo root (notification-system/)
docker compose up -d --wait
npm run api & npm run worker & npm run ws &

# in your own terminal, with YOUR tenant api key:
$env:ASYNCIFY_API_KEY = "<your ak_ key>"
npx asyncify dev
```

`asyncify dev` prints a public `https://<random>.trycloudflare.com` URL.

Mint a subscriber token for a test user (replace the key and URL):

```bash
curl -X POST https://<random>.trycloudflare.com/v1/subscriber-tokens \
  -H "x-api-key: <your ak_ key>" \
  -H "content-type: application/json" \
  -d '{"subscriberId":"push-tester","ttlSeconds":86400}'
# → {"token":"nst_...","expiresAt":...}
```

In the app on the phone:

- **API URL** → the `https://<random>.trycloudflare.com` tunnel URL
  (NOT `localhost` — on the phone that is the phone itself).
- **Subscriber token** → the `nst_...` value you just minted.
- Tap **Enable Push**, accept the notification permission. The status block
  should show `permission: granted` and `enabled: true`.

## 6. Trigger a notification

Fire a workflow that targets subscriber `push-tester` over the push channel
(via the dashboard's Send-test, `scripts/send-test.ps1`, or a trigger API
call). **Close the app**, then trigger — the notification is displayed by
Android itself (no app code runs). Reopen the app and trigger again to see it
land in the in-app **Foreground messages** log.

---

## Notes

- iOS is wired in `app.json` but requires an APNs key in Firebase and a Mac
  build; this harness is verified on Android.
- `android/` and `ios/` are git-ignored — EAS/`expo prebuild` regenerate them
  from `app.json`.
