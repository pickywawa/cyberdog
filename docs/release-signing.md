# Signing and notarizing the macOS releases

GitHub release DMGs can be signed with an Apple **Developer ID Application** certificate and notarized, so macOS opens them without any warning and Homebrew accepts them. The [release workflow](../.github/workflows/release.yml) does it automatically when the secrets below exist, and falls back to the unsigned (ad hoc) build when they do not (forks, local builds).

The Mac App Store build is a different thing: it uses an *Apple Distribution* certificate and its own entitlements (`build/entitlements.mas*.plist`, `npm run dist:mas`).

## One-time setup

1. **Developer ID Application certificate.** Only the Account Holder can create it, in *Certificates, Identifiers & Profiles → Certificates → + → Developer ID Application* (profile type *G2 Sub-CA*), from a certificate signing request. Export the certificate and its private key from Keychain Access as a `.p12` file with a password.
2. **A dedicated API key for notarization.** In App Store Connect → *Users and Access → Integrations → Team Keys*, create a key with the **Developer** role only (not Admin) and download the `.p8` once.
3. **GitHub secrets** (repository → *Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `MACOS_CERT_P12_BASE64` | the `.p12` file, base64 encoded: `base64 -i developer-id.p12 \| pbcopy` |
| `MACOS_CERT_PASSWORD` | the `.p12` password |
| `APPLE_API_KEY_P8` | the full text of the `.p8` key file |
| `APPLE_API_KEY_ID` | the key ID of that API key |
| `APPLE_API_ISSUER_ID` | the issuer ID (App Store Connect → Integrations) |

With `gh`:

```sh
gh secret set MACOS_CERT_P12_BASE64 < developer-id.p12.base64
gh secret set MACOS_CERT_PASSWORD
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER_ID
```

## Building locally

```sh
export CSC_LINK=/path/to/developer-id.p12 CSC_KEY_PASSWORD='…'
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8 APPLE_API_KEY_ID=XXXXXXXXXX APPLE_API_ISSUER=…
npm run dist:mac:signed
```

`dist:mac:signed` uses the hardened runtime with `build/entitlements.mac.plist`, signs with the identity named in `package.json`, notarizes the app with Apple and staples the ticket. Check the result with:

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Cyberdog.app
xcrun stapler validate dist/mac-arm64/Cyberdog.app
spctl --assess --type execute --verbose=4 dist/mac-arm64/Cyberdog.app
```

## After the first signed release

- Remove the quarantine `postflight` block from the [Homebrew tap](https://github.com/pickywawa/homebrew-cyberdog) cask.
- Drop the `xattr` workaround from the macOS install instructions in the README.
