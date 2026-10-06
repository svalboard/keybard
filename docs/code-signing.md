# Code signing the Windows installer

The Keybard Host installer (`KeybardHostSetup.exe`) is not code-signed yet, so Windows SmartScreen warns on first run ("Windows protected your PC" → **More info → Run anyway**). Signing is already wired into the build. It switches on when credentials are added, with no build changes.

## What gets signed

When signing is configured, `companion/overlay-host/packaging/windows/build.py`:

1. Signs `Keybard Host.exe` after PyInstaller builds it, before it goes into the installer.
2. Has Inno Setup sign `KeybardHostSetup.exe` and the uninstaller it generates (`SignTool` / `SignedUninstaller`).
3. Checks each file with Windows' own `Get-AuthenticodeSignature`. The build fails unless every signature is valid and timestamped.

The CMD/ZIP package and `keybard-paranoid.html` are not executables and are not signed. Their checksums are in `SHA256SUMS.txt`.

## The switch

Signing is driven by one value, `KEYBARD_SIGN_COMMAND`: a command line that signs one file, with `{file}` where the file goes. In CI it comes from the repository secret of the same name (`.github/workflows/keybard-host-release.yml`, the **Build installer** step). If the secret is absent, the build is unsigned, as it is today.

Every signature needs an RFC 3161 timestamp, so signed files stay valid after the certificate expires.

## Option A: Azure Artifact Signing (formerly Trusted Signing)

Microsoft's managed service is the cheapest and simplest route, on the order of $10/month. Eligibility has been limited to organizations and individuals in certain countries, starting with the US and Canada, and needs identity validation. Check the current terms.

1. In Azure, create an Artifact Signing account, a certificate profile (Public Trust) and complete identity validation for Svalboard.
2. Create an app registration or managed identity with the signing role on that profile. Configure GitHub OIDC (federated credentials) so the workflow can sign in without a stored password.
3. In the **windows-installer** job, before **Build installer**, add an `azure/login` step and install the signing client (the `signtool` dlib and its `metadata.json`). Microsoft's documentation has the current package names.
4. Set the secret, for example:
   `KEYBARD_SIGN_COMMAND = signtool sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "<path>\Azure.CodeSigning.Dlib.dll" /dmdf "<path>\metadata.json" {file}`

## Option B: an OV certificate with cloud signing

Use a certificate authority's cloud key service, for example DigiCert KeyLocker, SSL.com eSigner or GlobalSign. It typically costs a few hundred dollars a year, and the CA validates the company in days to a couple of weeks. Since 2023, keys must live in hardware or a cloud HSM, so a downloadable `.pfx` is no longer an option, and a USB token can't be used from CI.

1. Buy the certificate in Svalboard's name and enroll in the CA's cloud signing.
2. Add the CA's signing tool to the job, and its credentials as secrets.
3. Set `KEYBARD_SIGN_COMMAND` to that tool's sign command with `{file}`. It must request a timestamp.

An EV certificate no longer bypasses SmartScreen on its own, so it is rarely worth the extra cost now.

## After enabling

- **SmartScreen reputation builds with real downloads.** The warning fades over the first weeks of a signed release, not instantly.
- **Sign every release with the same identity,** so reputation carries over.
- **winget follows naturally:** submit a manifest pointing at the signed installer, and `winget install Svalboard.KeybardHost` works.
- **The Microsoft Store (MSIX) is a separate route** with Store signing and automatic updates. It needs MSIX packaging and Store review.

## Testing the switch without a certificate

`companion/overlay-host/tests/test_windows_build.py` checks the wiring with a fake signer. A CI dry run can also sign with a throwaway self-signed certificate trusted only on the runner. That exercises the real Inno Setup signing and the signature check, but the result is not trusted anywhere else and must never be released.
