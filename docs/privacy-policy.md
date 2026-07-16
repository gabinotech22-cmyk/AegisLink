# AegisLink Privacy Policy

**Effective date:** 2026-05-21
**Last updated:** 2026-07-16

AegisLink is a privacy-first encrypted messaging application. This policy explains exactly what data we collect, what we do not collect, and why. We have written it to be read, not to obscure.

---

## 1. Who We Are

AegisLink is operated by the AegisLink project (contact: see §9). The application is open-source software. The relay server infrastructure is self-hosted and does not depend on any third-party cloud provider with access to user data.

---

## 2. What We Collect

We collect the absolute minimum required to operate a relay-based messaging service.

| Data | Why | How long |
|------|-----|----------|
| A randomly generated pseudonymous identifier ("AegisID") | To route encrypted messages to your device | Until you delete your account |
| Public cryptographic keys (identity key, signed pre-key, one-time pre-keys) | To enable other users to establish an E2EE session with you without a central authority | Until you rotate or delete them |
| Encrypted message ciphertext in transit | To forward messages to recipients who are temporarily offline | Deleted immediately upon delivery or after 30 days maximum if undelivered |
| Push token (an app-scoped routing identifier issued by Apple/Google — **not** a hardware or advertising ID) | To send a generic wake-up notification when a message is waiting | Stored only while you are registered; deleted on account deletion |

That is the complete list.

We do not use analytics SDKs or crash-reporting services that phone home. The one external service we rely on is push delivery: wake-up notifications are routed through Expo's push service and Apple/Google push infrastructure, which receive only your push token and a generic, contentless payload ("new encrypted message" / "incoming call") — never message content, sender, recipient, or any other metadata.

---

## 3. What We Do NOT Collect

The following data is **never** collected, stored, or transmitted to our servers:

- Your real name, email address, phone number, or any other personally identifying information
- Your IP address — the relay server discards the source IP of every connection at the middleware layer before any log is written
- Message content — all messages are end-to-end encrypted; the relay receives only opaque ciphertext and cannot read them
- Message metadata such as who you communicate with, how often, or message sizes
- Your location
- Device identifiers (IMEI, advertising ID, etc.)
- Contacts list
- Profile photos or any biometric data
- Call duration or call partners for voice/video calls (signaling is minimal and not logged)
- Timestamps of when you sent or received specific messages — the relay logs only coarse system-level metrics (requests per minute, error counts) with no user attribution

---

## 4. End-to-End Encryption

All messages, attachments, voice calls, and video calls are encrypted end-to-end using the Double Ratchet Algorithm (forward-secret session keys) with X3DH key agreement, implemented using the TweetNaCl library (auditable open-source cryptography).

**Your private keys never leave your device.** They are generated on your device at setup, stored in the operating system's protected credential storage (iOS Keychain Services / Android Keystore, via `expo-secure-store`), and are never transmitted anywhere.

The AegisLink relay server is architecturally incapable of reading your messages. Even if the server were compromised or served with a legal order, the ciphertext it holds would be computationally infeasible to decrypt without the private keys that exist only on your device.

---

## 5. Ephemeral Messages

AegisLink supports user-configurable message timers. When a timer is set, messages are automatically deleted from both devices after the specified duration. Deleted messages are permanently removed from device storage and from the relay (where they were never stored in plaintext to begin with).

---

## 6. Backups

**Local backup:** Encrypted using a key derived from a passphrase you choose. The backup file is stored on your device only. We do not have access to it.

**Remote backup (optional):** If you enable remote backup, an encrypted archive is uploaded to a storage location of your choice. The encryption key is derived solely from your passphrase and is never transmitted to AegisLink. We cannot recover your backup if you lose your passphrase.

---

## 7. Payment Privacy (Lightning Network)

AegisLink Work and optional premium features can be paid for using Bitcoin over the Lightning Network. Lightning payments are pseudonymous by design. We do not require any personal information to process a payment. We do not link payment channel information to AegisIDs. Payment receipts are validated cryptographically without storing payment metadata beyond the proof of payment itself.

We do not accept credit cards, PayPal, or any payment method that would require us to collect your name, billing address, or card number.

---

## 8. Data Retention

| Data type | Retention period |
|-----------|-----------------|
| Undelivered encrypted messages | Max 30 days; deleted immediately upon delivery |
| Public keys (pre-keys) | Until rotated or account deleted |
| FCM/APNs tokens | Until account deleted |
| Server-side system logs (aggregate, no user attribution) | 7 days rolling |

On account deletion, all data associated with your AegisID is permanently deleted within 24 hours. There is no retention beyond this window.

---

## 9. Open Source and Auditability

AegisLink's application code and relay server code are published as open-source software. You can inspect every cryptographic operation, every server-side handler, and every data access pattern. We encourage independent security audits. The source is available at: https://github.com/gabinotech22-cmyk/AegisLink

Anyone can verify that the claims in this privacy policy are technically enforced in the codebase, not merely stated in a document.

---

## 10. Children

AegisLink does not knowingly collect any information from anyone under 13 years of age. The app is not directed at children. If you become aware that a child has registered, please contact us so we can delete the account.

---

## 11. Changes to This Policy

If we make material changes to this policy, we will update the effective date above and publish the new version in the open-source repository where it can be reviewed with full version history. We will not make changes that reduce your privacy protections without prominent notice.

---

## 12. Contact

For privacy questions, data deletion requests, or security disclosures:

- Email: privacy@aegislink.io (PGP key available in the repository)
- GitHub: https://github.com/gabinotech22-cmyk/AegisLink/security/advisories/new (for security issues)

---

*Una versión en español de esta política está disponible bajo petición. Envíe un correo a privacy@aegislink.io con el asunto "Privacy Policy — Español".*
