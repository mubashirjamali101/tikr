# Security Policy

## Reporting a vulnerability

Primary contact: **security@mubashirjamali.com**

Do not open a public GitHub issue for exploitable vulnerabilities. You should receive an acknowledgement within a week.

GitHub [private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) is welcome when enabled.

Please include the version (`tikr --version` / package version), what an attacker could achieve, and steps to reproduce. Do not attach session transcripts that contain secrets.

## Scope

This policy applies to the `tikr` repository, published npm packages, and local state under `~/.tikr`.

## Threat model notes

- Usage data is stored **locally** in an encrypted, append-only ledger. It is not sent to a remote service by this tool.
- The encryption key is machine-bound and derivable by any process running as the same user — it protects copies of the data directory off-machine, not the account owner.
- Providers are only enabled when on-disk formats have been verified; guessed parsers are rejected by design.
