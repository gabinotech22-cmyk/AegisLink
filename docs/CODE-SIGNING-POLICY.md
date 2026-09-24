# Code signing policy — AegisLink Desktop

> Estado: **borrador para la solicitud a SignPath Foundation** (D-3 en
> `docs/DESKTOP-BETA.md`). Este texto es el que SignPath exige publicar de forma
> visible (en su formato: "Code signing policy") antes de aprobar la firma
> gratuita OSS. Cuando la solicitud se apruebe, se enlaza desde el README y se
> quita esta nota.

## Program

Free code signing for Windows binaries is provided by
[SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## What gets signed

Only the AegisLink Desktop installers (`AegisLink Setup <version>.exe`, NSIS) and
the portable executable (`AegisLink <version>.exe`), built from
[github.com/gabinotech22-cmyk/AegisLink](https://github.com/gabinotech22-cmyk/AegisLink)
(`desktop/`) by the project's own GitHub Actions workflow from a tagged commit
on `main`. Nothing built on a developer machine is ever submitted for signing.

The embedded Tor binary shipped next to the app (`resources/tor/tor.exe`), and
its pluggable-transport client for bridges
(`resources/tor/pluggable_transports/lyrebird.exe`), come
unmodified from the Tor Expert Bundle of the Tor Project, fetched by
`desktop/scripts/fetch-tor.mjs` and verified against a pinned SHA-256 taken from
the Tor Project's signed checksum file; they are not re-signed by us.

## Team roles

| Role | Who | Responsibility |
|---|---|---|
| Author | gabinotech22-cmyk (project maintainer) | Direct commit access |
| Reviewer | gabinotech22-cmyk | Reviews every external contribution before merge |
| Approver | gabinotech22-cmyk | Approves each signing request per release |

Two-factor authentication is enforced on the GitHub account and on the
SignPath account.

## Privacy policy

The desktop application does not collect, transmit or store any telemetry,
analytics, crash reports or personal data. All network traffic goes exclusively
to the AegisLink relay over the Tor network and is end-to-end encrypted. See the
project [privacy policy](../privacy-policy.md).

## License

AegisLink is licensed under the GNU GPL-3.0 (OSI-approved), with no commercial
dual licensing.
