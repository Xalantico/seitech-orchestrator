# ENS (Esquema Nacional de Seguridad, RD 311/2022) · technical measures checklist

What the platform provides for each technical control family, and what remains an organisational or infrastructure task for the operator.
Category/level (basic, medium, high) must be set by the data owner; the measures below cover **medium**.

| Measure | Control | Provided by the platform | Operator must |
|---|---|---|---|
| org.1–4 | Policy, regulations, procedures | `docs/` (this folder), RBAC catalogue | Approve the security policy; appoint the security officer |
| op.pl.2 | Security architecture | `docs/architecture.md`, network segmentation in compose/Helm (`internal` network, LAN-only consoles) | Review per environment |
| op.acc.1 | Identification | Unique user per person (Keycloak/OIDC, OTP), API keys per integration | Disable shared accounts |
| op.acc.2 | Access requirements | RBAC with permission catalogue; row-level security by delegation/zone/project | Review role design with the business |
| op.acc.3 | Segregation of duties | `toxic_role_combinations` blocks incompatible roles | Define the combinations |
| op.acc.4 | Access management | Least-privilege defaults; admin actions audited | Quarterly access review (Governance → Usage / Users) |
| op.acc.5–6 | Authentication | MFA (TOTP) required; password policy 12+ chars, complexity, history, expiry; lockout | Keep Keycloak up to date; Entra ID federation if corporate |
| op.exp.2–3 | Configuration / change control | Everything in git; migrations versioned; deploy via `deploy.yml` with Environment approvals | Configure required reviewers on `preprod` and `prod` |
| op.exp.5 | Change management | Pull requests + CI (lint, typecheck, tests, CodeQL, Trivy, SBOM, secret scan) | Enforce branch protection |
| op.exp.6 | Protection against malware | ClamAV scan on every upload | Keep signatures fresh (freshclam is enabled) |
| op.exp.7 | Incident management | Alertmanager rules, error panel, audit log | Define the incident procedure and CCN-CERT notification path |
| op.exp.8 | Activity log | Hash-chained append-only `audit_log` (`make verify-audit`); structured JSON logs to Loki | Retention ≥ legal minimum; ship to SIEM |
| op.exp.10 | Protection of log keys | Audit table not writable by the app role | Restrict DB owner access |
| op.exp.11 | Cryptographic key protection | Secrets in Vault KV v2; PII encrypted with pgcrypto using a Vault-held key | KMS auto-unseal and key rotation in real environments |
| op.cont.2 | Continuity plan | Backups to two sites; `make restore-drill` | Run the drill quarterly and record it |
| op.cont.3 | Periodic tests | Restore drill, k6 load profile | Schedule them |
| op.mon.1–2 | Intrusion detection / metrics | Prometheus, Grafana, Loki, Tempo; rate limiting; login throttling | Connect to the corporate SOC |
| mp.if.1–9 | Facilities | Out of scope (hosting) | Hosting provider evidence |
| mp.per | Personnel | Out of scope | Training, NDAs |
| mp.eq.2 | Lock-out of workstation | Server-side sessions with absolute expiry (`SESSION_TTL_DAYS`, revocable per user) | Endpoint lock-out policy; lower the TTL for sensitive environments |
| mp.com.2 | Confidentiality in communications | TLS 1.3 only at the edge, HSTS, secure cookies | Use trusted certificates in non-local environments |
| mp.com.3 | Integrity and authenticity | Signed webhooks (HMAC), signed export links, session cookies HttpOnly + SameSite | Rotate webhook secrets |
| mp.si.2 | Cryptography of media | Encrypted PII columns; object store server-side encryption is configurable | Enable disk / bucket encryption in the hosting layer |
| mp.sw.1–2 | Secure development, acceptance | Typed code, zod validation of every input, CI gates, dependency review | Pen-test before go-live |
| mp.info.1 | Personal data | GDPR export/erasure, retention policy in code, data minimisation in logs (`engine/redact.ts`) | RAT (records of processing), DPIA, DPO sign-off |
| mp.info.3 | Electronic signature | e-sign integration adapter | Qualified provider contract |
| mp.info.6 | Backups | WAL-G continuous archive + base backups, second-site mirror | Verify RPO/RTO against the agreed targets |
| mp.s.2 | Protection of web services | CSP/nosniff/frame-deny headers, CORS allow-list, rate limit | WAF in front if exposed to the Internet |

## Evidence the operator can produce from the system

* Audit chain integrity: `make verify-audit`.
* Access list: Governance → Usage, Admin → Users/Roles.
* Backup evidence: `wal-g backup-list` output, last `make restore-drill` log.
* Change evidence: GitHub Environment approval history for `deploy.yml`.
* Vulnerability evidence: CodeQL and image-scan results in CI.
