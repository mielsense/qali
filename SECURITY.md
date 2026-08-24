# Security policy

## Supported versions

Security fixes are applied to the latest published Qali release. Development
builds and old local packages are not supported release channels.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for
[`mielsense/qali`](https://github.com/mielsense/qali/security/advisories/new).
Do not open a public issue for a vulnerability that could expose calendar data,
OAuth credentials, Keychain items, local files, update authority, or arbitrary
native execution.

Include the affected version, macOS version, reproduction steps using synthetic
data, and the boundary you believe is crossed. Never attach real calendar
records, refresh tokens, OAuth client secrets, signing certificates, App Store
Connect keys, personal logs, or database copies.

You should receive an acknowledgement within seven days. A fix and disclosure
timeline will depend on severity and whether a signed desktop release is
required.
