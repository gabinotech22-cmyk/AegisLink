# Certificate Pinning — AegisLink

Pinning of the relay's TLS SubjectPublicKeyInfo (SPKI) defeats MITM via
compromised CAs or user-installed root certificates. Both Android and iOS
clients ship with the pin embedded so a rogue cert chain cannot be trusted.

## Files

- Android: `mobile/android/app/src/main/res/xml/network_security_config.xml`
- iOS: `mobile/app.json` → `ios.infoPlist.NSAppTransportSecurity.NSPinnedDomains`

Both currently contain `REPLACE_WITH_PRIMARY_SPKI_SHA256_BASE64=` and
`REPLACE_WITH_BACKUP_SPKI_SHA256_BASE64=` placeholders. They MUST be filled
in before the next production release.

## Extracting the pin from the live relay

```bash
openssl s_client -servername aegislink.duckdns.org \
  -connect aegislink.duckdns.org:443 < /dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl enc -base64
```

The output is the **primary** pin (base64, ~44 chars ending in `=`).

## Generating a backup pin

Generate a backup RSA-4096 (or ECDSA P-256) keypair on an air-gapped machine.
Compute the SPKI hash with the same command on the backup public key. Store
the private key in offline cold storage — paper backup, hardware token, or
equivalent. The pin goes in the manifest as the second `<pin>` entry.

The backup pin protects against accidental loss of the primary key: a forced
keypair rotation without a backup pin in shipped clients bricks every install.

## When to rotate the pin

Rotate when:
- The relay's TLS private key is compromised (immediately).
- The relay's TLS private key is rotated for hygiene (~ every 1-2 years).
- The certificate is migrated to a new keypair (e.g. moving from LetsEncrypt
  cert issued from an old account to a new one).

A pin rotation REQUIRES a new app release. Phased rollout:
1. Add the new pin as a second entry alongside the old one.
2. Ship the dual-pin release.
3. Wait until >95 % of installs have updated (typically 4-6 weeks).
4. Switch the server's keypair to the new one.
5. In a follow-up release, drop the old pin.

## Pin expiration

`<pin-set expiration="2027-12-31">` — past this date Android ignores the
pin-set and falls back to default trust (fail-open). Extend the expiration
in every release. Track the next expiration in the team calendar.

## Verifying pinning works

After a release, intentionally serve a different cert (e.g. via a local proxy
with mitmproxy + self-signed CA installed in the user trust store on a test
device) and confirm the app fails to connect with a TLS handshake error.
On Android, the failure surfaces as `CertificateException: Pin verification
failed`. On iOS, `NSURLErrorDomain Code=-1202`.

## Debug builds

The `<debug-overrides>` block in `network_security_config.xml` allows
user-installed CAs ONLY for debug builds (`debuggable="true"` in the manifest).
Production releases never trust user roots — they enforce pinning unconditionally.
