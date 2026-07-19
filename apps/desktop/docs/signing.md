# Desktop code signing (macOS + Windows)

How the RDK desktop app gets signed builds that open cleanly on other people's
machines — no "damaged"/"unidentified developer" on macOS, no "Unknown Publisher" on
Windows. **macOS is below; Windows (Azure Trusted Signing) is the [last section](#windows-azure-trusted-signing).**

**None of this touches the production droplet or `central-api`.** All signing happens
on the GitHub Actions runners, driven by repo **secrets**.

> **Just need a testable build now?** You don't need any signing to test. Windows:
> SmartScreen → *More info → Run anyway*. macOS: right-click → *Open → Open*. And for a
> **fast signed (un-notarized) macOS build** to hand to testers without waiting on
> Apple's notary queue, run the workflow via **Run workflow** and set **`mac_notarize`
> = false**.

---

# macOS code signing & notarization

How the RDK desktop app gets a signed, notarized macOS build that opens cleanly on
other people's Macs (no "unidentified developer" / "damaged" Gatekeeper block).

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
| `APPLE_API_KEY_P8` | the **entire contents** of `AuthKey_XXXX.p8` (paste the whole file, `-----BEGIN…END-----`). Base64-encoding it is also accepted — the workflow normalizes either form. Do **not** base64 it and then also wrap it in anything else. |
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

---

# Windows (Azure Trusted Signing)

Eliminates the SmartScreen **"Unknown Publisher"** prompt. We use **Azure Trusted
Signing** — Microsoft's managed service (~$10/mo). It's cheaper than an OV/EV cert and
grants **immediate SmartScreen trust** (no reputation ramp-up). Since mid-2023 code
keys must live on certified hardware, so there's no exportable `.pfx` — a cloud service
like this is the CI-friendly path. electron-builder installs the `TrustedSigning`
module itself; there's no dlib to manage.

**Eligibility:** Trusted Signing needs a verifiable legal business identity (Microsoft
vets it; orgs <3 years old face extra validation). Confirm you qualify before buying.

## 1. Create the Azure resources (once)

In the Azure Portal:

1. **Create a Trusted Signing account** (search "Trusted Signing"). Pick a region —
   note its endpoint, e.g. `https://eus.codesigning.azure.net/` (East US).
2. Complete **identity validation** for your organization (this is the vetting step).
3. Create a **Certificate Profile** (type: *Public Trust*). Note its **name**.
4. Grant your identity the **Trusted Signing Certificate Profile Signer** role on the
   account.

## 2. Create a service principal for CI

CI authenticates as an Entra **service principal** (not your login):

```bash
az ad sp create-for-rbac --name "rdk-desktop-signing"
# → returns appId (client id), password (client secret), tenant
```

Then assign that SP the **Trusted Signing Certificate Profile Signer** role on the
Trusted Signing account (Portal → the account → Access control (IAM) → Add role
assignment).

## 3. Add six repo secrets

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | the SP's tenant id |
| `AZURE_CLIENT_ID` | the SP's appId |
| `AZURE_CLIENT_SECRET` | the SP's password |
| `AZURE_CODE_SIGNING_ENDPOINT` | region URI, e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE` | certificate profile name |

The first three authenticate; the last three tell electron-builder which cert to use.
All six must be present or the Windows build stays **unsigned** (the "Prepare Windows
signing" step prints which path it took).

## 4. Build & verify

Run the workflow (or push a `desktop-v*` tag). The **windows-latest** job signs the
`.exe` via `Invoke-TrustedSigning`. On a Windows box, confirm:

```powershell
Get-AuthenticodeSignature 'RDK Setup 0.1.0.exe' | Format-List Status, SignerCertificate
# Status → Valid ;  SignerCertificate subject → your org name
```

Download it and the SmartScreen prompt should now show **your publisher name** (and
disappear entirely once Trusted Signing's reputation applies, which is immediate for
Trusted Signing).

## Troubleshooting (Windows)

**Still "Unknown Publisher" / unsigned** → the "Prepare Windows signing" step logged
`building UNSIGNED` because one of the six secrets is missing/misnamed. All six are
required.

**`Invoke-TrustedSigning` auth error** → the service principal lacks the **Certificate
Profile Signer** role on the account, or `AZURE_CLIENT_SECRET` is stale (SP secrets
expire — regenerate and update the secret).

**`ERROR: Az.CodeSigning`/module install fails** → transient PSGallery/NuGet hiccup on
the runner; the build's sign-retry (3×) usually clears it. Re-run if not.

**Wrong endpoint region** → `AZURE_CODE_SIGNING_ENDPOINT` must match the region the
account was created in, or signing 404s.
</content>
