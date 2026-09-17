# Security audit

Scope: `apps/api/src`, `apps/web/src`, `apps/web/server.mjs`, `packages/domain/src`,
`packages/database` (source and all 32 migrations), `deploy/`, and the root
build/deploy configuration. Reviewed from `2aa0881` through the current
uncommitted hardening candidate, including migration 0032 and automation.

Findings are numbered `S-n` and carry the evidence that closed them.

---

## Critical

### S-1 · Anonymous denial of service through a shared rate-limit bucket — FIXED

**Was:** `FastifyAdapter` was constructed with no `trustProxy`. Every browser
request reaches the API through the public web service's reverse proxy, so
`request.ip` was the *web service's* address for every user on the installation.

The login limiter buckets on that address. Five failed logins from any
unauthenticated attacker therefore blocked **every** user of the installation
for fifteen minutes. The same applied to `recovery:ip` and `recovery:complete`.
As a side effect, `user_sessions.ip_hash` recorded one identical value for every
session, so the column answering "where was this session created" answered
nothing.

**Why the obvious fix is worse:** trusting `X-Forwarded-For` unconditionally
lets an attacker send a fresh random address per request and never be rate
limited at all — turning a denial of service into an unlimited
credential-guessing oracle. The web proxy also passed the client's own
`X-Forwarded-For` through untouched, so there was no trustworthy entry in it.

**Fixed by** making the trusted hop count explicit configuration
(`CONVO_TRUSTED_PROXY_HOPS`, default **0**), counting from the right-hand end of
the header, and making the web proxy append its own observed address
(`apps/web/server.mjs`) so there is an entry worth trusting.

**Evidence:** `apps/api/src/client-address.ts`, wired at
`apps/api/src/app.ts:61`. Deployment value documented in
`docs/runbooks/RAILWAY_PRODUCTION.md` and `.env.example`.

**Residual:** staging is set to `2` and the API logged that value at startup.
Production still lacks the setting; at the safe default its bucket is shared.

---

## High

### S-2 · Invitation and recovery email silently sent nothing — FIXED

`ApiModule` bound `LoggingRecoveryDelivery` and `LoggingInvitationDelivery` by
default, and `startApi` passed no adapters, so **production ran the logging
adapters**. An operator inviting a colleague saw success; nothing was sent.

A confidentiality issue as much as an availability one: the product told an
administrator that access had been granted when no credential had been
delivered, so the real state of who can join was unknown.

**Fixed by** a durable outbox (migration `0030`), a real Resend adapter, and
fail-closed configuration: a process with `NODE_ENV=production` refuses to boot
when the email provider is missing or set to `logging`.

**Evidence:** `apps/api/src/email/*`, 21 config tests, 14 provider tests, 16
integration tests in `tests/integration/api-email.test.ts`.

### S-3 · Password-recovery timing and failure mode were an account oracle — FIXED

`RecoveryService.start` called `delivery.deliver(...)` inline, **after** the
challenge row committed, and only when the address had a real account. Two
observable differences followed:

1. a real address did strictly more work, so the response was measurably slower;
2. a provider failure produced a 500 — and only ever for a real address.

The endpoint's careful byte-identical 202 does not help when the *status code*
differs for accounts that exist.

**Fixed by** replacing the inline provider call with an outbox INSERT on the
same transaction. Both branches now perform one or two INSERTs and nothing else.

**Evidence:** `apps/api/src/auth/recovery.service.ts`,
`tests/integration/api-email.test.ts` asserts identical bodies for known and
unknown addresses, and that a delivery is queued only for the real one.

### S-4 · No Content-Security-Policy or clickjacking protection — FIXED

The web server sent only `X-Content-Type-Options` and `Referrer-Policy`. There
was no CSP, no `frame-ancestors`, no `X-Frame-Options`, no HSTS and no
`Permissions-Policy`. The whole operator console could be framed by any origin.

**Fixed by** a full header set in `apps/web/server.mjs`: CSP with
`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`,
`base-uri 'self'`, `form-action 'self'`, `object-src 'none'`; plus
`X-Frame-Options: DENY`, `Permissions-Policy`, and HSTS **only when the request
arrived over TLS** so a local HTTP origin is never pinned to a scheme it does
not serve.

`script-src` retains `'unsafe-inline'`. That is a real and stated limitation:
`index.html` carries an inline theme script that must run before first paint to
avoid a light flash, and a static file server streaming a fixed file cannot mint
a per-response nonce. Removing it needs the theme script moved to a hashed
external file, or a templating step in the web server.

### S-5 · Tenant-wide invitations were impossible (HTTP 500) — FIXED

`invitation_scopes` (migration 0008) declared
`PRIMARY KEY (tenant_id, invitation_id, scope_type, scope_id)` while its CHECK
required `scope_id IS NULL` for a tenant scope. A PRIMARY KEY makes its columns
`NOT NULL` regardless of the column declaration, so the two constraints could
never both hold. **Every** tenant-wide invitation — the ordinary case of an
administrator inviting a colleague to the whole company — failed with a
not-null violation surfaced as a 500.

An availability defect, but a security-relevant one: the only working invitation
paths were narrower scopes, so operators had an incentive to over-grant through
other means.

Found by writing the first test that exercised that scope.

**Fixed by** migration `0031`: drop the key, drop the residual `NOT NULL`
(dropping a PK does not clear it), and re-express uniqueness as a unique index
with `NULLS NOT DISTINCT`. `membership_scopes` had this right from the start
with a surrogate key.

---

## Medium

### S-6 · Unauthenticated writes on the webhook route — OPEN, accepted

`POST /api/v1/webhooks/meta/:appConnectionId` writes a `webhook_receipts` row
for **every** delivery, including ones whose signature fails. An attacker who
learns a valid app-connection UUID can drive unbounded inserts.

Accepted for the MVP, deliberately: a receipt for a failed verification is
exactly the evidence an operator needs when a provider claims it delivered
something, and dropping it to save a row would remove the audit trail that makes
signature failures diagnosable at all.

Compensating: the UUID is not guessable; the body limit is 512 KB; the row
stores a hash and a byte count, never the body.

**To close:** rate-limit unverified deliveries per route key, and add retention
to `webhook_receipts` (see `DATABASE_AUDIT.md`, D-4).

### S-7 · A recovery token is at rest in the outbox — OPEN, accepted and bounded

`email_deliveries.payload` holds the one-time token between queueing and
sending, because the worker must render the link and the token is knowable only
once.

Mitigated structurally: the payload is scrubbed to `'{}'` **in the same
statement** that sets the terminal state, and `email_deliveries_scrub_ck`
refuses any other combination — so a `sent` or `failed` row holding a token
cannot exist. The window is the queue latency, seconds in normal operation.

Compensating controls are the ones the token already has: one hour to live,
single use, and every session revoked when it is spent.

**To close:** encrypt the payload with the existing `CredentialCipher`. That
needs `CONVO_CREDENTIAL_KEYS` to become required, which today is optional
because an installation with no channels needs no key.

### S-8 · A successful login resets the IP bucket — OPEN

`AuthService.login` resets both `login-account` and `login-ip` on success. An
attacker holding one valid account can clear the IP bucket at will and then
guess against other accounts without IP-based throttling. The per-account bucket
still applies, so this narrows rather than removes the control.

**To close:** reset only the account bucket on success.

### S-9 · A session write on every authenticated request — OPEN

`AuthService.authenticate` issues
`UPDATE user_sessions SET last_seen_at = now()` on **every** authenticated
request. At scale this is a write per read, on a hot row per active user, with
the WAL and bloat that implies.

Performance rather than security, but it is a self-inflicted amplification
factor available to any authenticated user.

**To close:** update only when `last_seen_at` is older than, say, 60 seconds.

---

## Verified and correct — no change needed

These were reviewed closely and are right. Listed because "we looked" is part of
the evidence.

| Area | Finding |
| --- | --- |
| **Password hashing** | Argon2id, m=19456 KiB, t=2, p=1. Meets OWASP's second recommended profile. |
| **Login enumeration** | An unknown user is verified against a real dummy hash, so the timing does not branch. |
| **Session tokens** | 32 random bytes, base64url; only an HMAC fingerprint is stored. Comparison is `timingSafeEqual` with a length guard. |
| **CSRF** | Double-submit; both the cookie and the `x-csrf-token` header must match the session's stored fingerprint. `SameSite=Strict`. `Secure` derives from the public base URL being https. Session cookie is `HttpOnly` and path-scoped to `/api/v1`. |
| **Recovery completion** | One transaction: claim the challenge by conditional UPDATE, replace the password, revoke **every** session, spend every other outstanding challenge. Two concurrent requests with the same token cannot both succeed. |
| **Decoy challenges** | A challenge row is written for unknown addresses too, with a NULL user, so the table's size and shape are not a directory. |
| **Webhook signature** | HMAC over the **exact raw bytes** — a dedicated content-type parser keeps the buffer and hands the route no parsed body, so nothing downstream can trust a field before the signature holds. Constant-time compare, replay window. |
| **Tenant resolution** | From the verified asset id **inside** the signed payload, never from a path parameter, header or query string. |
| **Tenant isolation** | `SET LOCAL` plus a read-back assertion that the database agrees, on every tenant transaction. RLS `ENABLE` **and** `FORCE` with both `USING` and `WITH CHECK`; `app_current_tenant()` is NULL when unset, so the default is DENY. |
| **The RLS carve-outs** | Two, each transaction-local and each matched against exactly **one** column — the invitation fingerprint or the asset fingerprint the caller demonstrably holds. Not "all invitations while a flag is set". |
| **Credential encryption** | AES-256-GCM, fresh 12-byte IV per record, tag stored separately, AAD binding tenant + connection + purpose so a ciphertext cannot be replayed into another row, named key version for rotation. |
| **App secrets** | In configuration, never in a column. Rotating one is an operations act. |
| **SQL injection** | Every query is parameterised. The only interpolated identifiers are in the restore harness and are quoted; they come from `information_schema`, never from a request. |
| **Mass assignment** | Request parsers are allow-lists that reject unexpected fields by name. |
| **IDOR** | Every tenant-scoped read and write goes through `AuthorizationService.authorized`, which sets the RLS context; a wrong id returns no rows rather than another tenant's. |
| **Body limits** | 1 MB globally, 512 KB on webhooks. |
| **Secrets in the browser** | None. `npm audit --prod` at high severity is part of `test:security`. |
| **Dynamic execution** | No `eval`, no `new Function`, no `child_process` in product code. |
| **Logging** | Structured, with a redaction deny-list **and** a structural rule: objects and arrays are never expanded, so a headers bag or a row cannot leak by accident. Errors log `message`, never `stack`. 27 tests, including one asserting a nested cookie does not appear. |

---

## Not assessed

- **Frontend XSS.** `apps/web/src` was reviewed for `innerHTML` and
  `dangerouslySetInnerHTML` patterns and for direct DOM sinks, and the render
  path uses `textContent`. It was **not** line-by-line reviewed across all
  29,630 lines; a focused frontend review is outstanding.
- **Penetration testing.** Nothing here is a substitute. No dynamic scan, no
  fuzzing of the webhook parser against malformed provider payloads.
- **Dependency CVEs beyond `pnpm audit --prod`.** No SCA tool with a
  vulnerability database is configured.
- **The Meta transport against live assets.** The adapter is unit-tested against
  a scripted Graph API; no real token, signature or message has been exchanged.
