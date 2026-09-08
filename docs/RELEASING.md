# Release guide

Codex Token Usage uses GitHub Actions to build two self-contained macOS packages:

- `arm64` for Apple Silicon
- `x64` for Intel

Every release also contains a ZIP for the one-command installer and `SHA256SUMS` for integrity verification.

## Normal release

Prepare the version on a release branch:

```bash
git pull --rebase
git switch -c codex/release-0.2.0
npm run check
npm run release:prepare -- 0.2.0
git add .
git commit -m "release: v0.2.0"
git push -u origin codex/release-0.2.0
```

Open and merge a pull request after CI passes. Then tag the exact merged commit from an up-to-date `main` branch:

```bash
git switch main
git pull --ff-only
git tag v0.2.0
git push origin v0.2.0
```

The tag must exactly match the version in `package.json`. GitHub Actions rejects a mismatch.

## Apple signing and notarization

Unsigned builds are suitable for development, but a public app should use a **Developer ID Application** certificate and Apple notarization. This requires an active Apple Developer Program membership.

Create a Developer ID Application certificate in the Apple Developer portal or Xcode, export the certificate and private key from Keychain Access as a password-protected `.p12`, then create an App Store Connect API key with notarization access.

Add these repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` certificate and private key |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full identity, for example `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect `.p8` API key |
| `APPLE_API_KEY_ID` | API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |

Encode the files without copying their binary contents into the terminal history:

```bash
base64 -i DeveloperID.p12 | pbcopy
base64 -i AuthKey_KEYID.p8 | pbcopy
```

Paste each clipboard value directly into its corresponding GitHub secret. Never commit certificates, private keys, passwords, or API keys to the repository.

When all six secrets exist, the workflow signs the bundled Node.js executable and the app, submits the app to Apple with `notarytool`, staples the ticket, and only then creates the DMG and ZIP. A tagged stable release fails closed when signing secrets are absent or incomplete. A manually dispatched workflow may still produce an explicitly unsigned preview artifact for testing, but it never creates a stable Release.

## First public release checklist

- Repository visibility is Public.
- GitHub Actions are enabled with read/write workflow permissions.
- `main` passes CI.
- Release version and tag match.
- Both architectures are present in the Release.
- `SHA256SUMS` contains all four packages.
- A clean Mac can open the DMG, drag the app, launch it, and see the menu bar icon.
- For signed releases, `spctl --assess --type execute --verbose "Codex Token Usage.app"` succeeds.

## Updating the one-command installer

The installer always downloads stable asset names from the latest GitHub Release, so its command does not change between versions. Do not rename these assets without updating `scripts/install-release.sh`:

- `Codex-Token-Usage-macOS-arm64.zip`
- `Codex-Token-Usage-macOS-x64.zip`
- `SHA256SUMS`
