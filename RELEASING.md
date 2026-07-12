# Releasing

Publishing is automated — no npm token exists anywhere. The pipeline is
Changesets + GitHub Actions + npm **OIDC trusted publishing** (each package
on npmjs.com trusts `release.yml` in this repo; npm mints a per-publish
credential and stamps a provenance badge on every release).

## The habit (the only manual part)

When a change touches a **published package** (`packages/sdk-node`,
`packages/agent`, `packages/react`, `packages/cli`):

```bash
npx changeset
```

Three prompts: which package(s), patch/minor/major, one-line summary
(this becomes the CHANGELOG entry). Commit the generated
`.changeset/*.md` file together with your code.

Platform-only changes (src/, dashboard/, tests/) need no changeset.

## Releasing

1. Changesets accumulate on `main`; the Release workflow maintains a
   single **"Version Packages"** PR that previews every pending bump +
   changelog.
2. **Merging that PR is the release.** The workflow publishes exactly the
   changed packages to npm and updates each package's `CHANGELOG.md`.

## One-time setup (already done)

- npm: each package → Settings → **Trusted Publisher** → GitHub repo
  `shubam14dec/Scalable-Notification-System`, workflow `release.yml`.
- GitHub: repo Settings → Actions → General → *Allow GitHub Actions to
  create and approve pull requests*.

**Adding a brand-new package.** npm cannot OIDC-publish a package's FIRST
version, and the Trusted Publisher settings page only exists once the
package does (npm/cli#8544; verified 2026-07-13). The one-time bootstrap:
1. `npm login` locally (browser flow — no token stored anywhere), then
   `npm publish --access public` from the package dir at its pre-release
   version (e.g. 0.0.0) to make the package exist.
2. npmjs.com → the new package → Settings → Trusted Publisher → GitHub
   Actions: `shubam14dec` / `Scalable-Notification-System` /
   `release.yml` / environment blank.
3. Merge the Version Packages PR — the real first release (e.g. 0.1.0)
   publishes via OIDC with provenance.
4. Optionally `npm deprecate <pkg>@0.0.0 "placeholder — use >=0.1.0"`
   and `npm logout`.

## If a publish fails with an auth error

The Trusted Publisher binding is the credential. Check npmjs.com →
package → Settings → Publishing access; the workflow filename must be
exactly `release.yml`. (Emergency fallback: an `NPM_TOKEN` secret +
`env: NODE_AUTH_TOKEN` on the publish step — remove it again after.)
