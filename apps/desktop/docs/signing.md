# macOS code signing & notarization

How the RDK desktop app gets a signed, notarized macOS build that opens cleanly on
other people's Macs (no "unidentified developer" / "damaged" Gatekeeper block).

**None of this touches the production droplet or `central-api`.** Signing and
notarization happen only on the `macos-latest` GitHub Actions runner, driven by repo
**secrets**. Your DigitalOcean droplet needs no Apple credentials.

---

## The two halves (you need both)

Apple deliberately separates "who may sign" from "who may notarize":

| Half | What it is | Runs during | Credential |
|---|---|---|---|
| **Signing** | Stamps the `.app`/`.dmg` with your identity via `codesign` | build | **Developer ID Application** certificate → exported `.p12` |
| **Notarization** | Uploads the signed app to Apple, who scan + bless it | after signing | **App Store Connect API key** → the `.p8` file |

A `.p8` **cannot sign** — it's an API key, not a certificate. And you can't notarize
an app that wasn't signed first. If you only have the `.p8`, you still need to create
the Developer ID Application certificate below.

Team: **B6B5DGK88V**.

---

## 1. Get the signing certificate (needs a Mac, ~5 min)

Do this once. It requires macOS because the private key lives in your Keychain.

1. **Check if you already have one:** Keychain Access → **login** → **My
   Certificates** → look for **"Developer ID Application: … (B6B5DGK88V)"** with a
   private key nested under it. If it's there, skip to step 6.
2. Otherwise, create a CSR: **Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority** → your email, **Saved to disk** →
   produces a `.certSigningRequest`.
3. https://developer.apple.com/account/resources/certificates/list → **+** →
   **Developer ID Application** → Continue.
4. Upload the CSR → **Download** the resulting `.cer`.
5. Double-click the `.cer` to install it into your login Keychain.
6. In **My Certificates**, right-click the Developer ID Application entry →
   **Export…** → save as `DeveloperID.p12` → set a password. **Remember it** — it
   becomes `CSC_KEY_PASSWORD`.

Then base64-encode the `.p12` (GitHub secrets are text):

```bash
base64 -i DeveloperID.p12 | pbcopy    # now on your clipboard → CSC_LINK
# or: base64 -i DeveloperID.p12 -o csc-link.txt
```

---

## 2. You already have the notary key (the `.p8`)

From App Store Connect → Users and Access → **Integrations / Keys**. Keep three things:

- the **`AuthKey_XXXXXXXXXX.p8`** file (its full text)
- the **Key ID** (the `XXXXXXXXXX` in the filename)
- the **Issuer ID** (a UUID at the top of the Keys page)

Don't convert or re-encode the `.p8` — paste its contents verbatim.

---

## 3. Add five repo secrets

**GitHub → repo → Settings → Secrets and variables → Actions → New repository
secret.** Add exactly these names — the workflow reads them by name:

| Secret | Value |
|---|---|
| `CSC_LINK` | base64 of `DeveloperID.p12` (from step 1) |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_P8` | the **entire contents** of `AuthKey_XXXX.p8` (paste the whole file, `-----BEGIN…END-----`) |
| `APPLE_API_KEY_ID` | the Key ID |
| `APPLE_API_ISSUER` | the Issuer UUID |

> Why `APPLE_API_KEY_P8` and not `APPLE_API_KEY`? electron-builder's `APPLE_API_KEY`
> must be a **file path**, but a GitHub secret is a **string**. The workflow writes
> `APPLE_API_KEY_P8` to a temp file at build time and points `APPLE_API_KEY` at it.

That's the whole setup. Nothing else changes.

---

## 4. Build a signed, notarized release

Signing/notarization is **automatic once the five secrets exist** — no code change,
no flag. Trigger the workflow the usual way:

- **Ad-hoc:** Actions → **Desktop Release** → **Run workflow** (on `main`), or
- **A release:** push a tag — `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`
  — which also attaches the `.dmg`/`.zip` to a GitHub Release.

The mac runner's **"Prepare macOS signing"** step checks for the secrets:

- **present** → writes the `.p8`, sets `APPLE_API_KEY` to its path, and turns on
  notarization (`RDK_MAC_NOTARIZE=true` → `-c.mac.notarize=true`).
- **absent** → sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and builds **unsigned**,
  exactly as before. So partial setup never breaks CI — it just stays unsigned until
  all of `CSC_LINK`, `APPLE_API_KEY_P8`, and `APPLE_API_KEY_ID` are present.

Notarization adds a few minutes (Apple's scan). electron-builder staples the ticket
to the `.dmg` automatically on success.

---

## 5. Verify a downloaded build

On a Mac that never saw your dev cert:

```bash
spctl -a -vvv --type execute /Applications/RDK.app   # → "accepted, source=Notarized Developer ID"
xcrun stapler validate RDK.app                        # → "The validate action worked!"
codesign --verify --deep --strict --verbose=2 RDK.app # → no errors
```

Or just double-click the `.dmg` — it should open with no Gatekeeper warning.

---

## Where the wiring lives

- [.github/workflows/desktop-release.yml](../../../.github/workflows/desktop-release.yml)
  — secret→env mapping + the "Prepare macOS signing" step.
- [apps/desktop/scripts/package.sh](../scripts/package.sh) — the `RDK_MAC_NOTARIZE`
  gate that adds `-c.mac.notarize=true`.
- [apps/desktop/electron-builder.yml](../electron-builder.yml) — `mac.hardenedRuntime`,
  entitlements, and `notarize: false` (the default the workflow overrides).

---

## Troubleshooting

**Build is unsigned even though I added secrets** → the step needs all of `CSC_LINK`,
`APPLE_API_KEY_P8`, **and** `APPLE_API_KEY_ID`. Check the "Prepare macOS signing" log
line — it prints which path it took.

**`Command codesign failed` / "no identity found"** → the `.p12` is wrong (an "Apple
Development" or "Developer ID *Installer*" cert instead of "Developer ID
*Application*"), the base64 got truncated, or `CSC_KEY_PASSWORD` is wrong.

**Notarization rejected** → almost always missing hardened runtime or entitlements —
both are already set in `electron-builder.yml`. Read the notarization log electron-builder
prints; it names the offending binary. Unsigned nested binaries are the usual cause.

**"App is damaged and can't be opened"** on a downloaded build → it was signed but not
notarized (or the ticket wasn't stapled). Confirm `RDK_MAC_NOTARIZE=true` took effect
and that notarization actually succeeded in the log.

**`.p8` expired?** It doesn't. Certificates expire (Developer ID: ~5 years); the App
Store Connect API key does not. If you rotate the cert, re-export the `.p12` and update
`CSC_LINK` / `CSC_KEY_PASSWORD`.
</content>
