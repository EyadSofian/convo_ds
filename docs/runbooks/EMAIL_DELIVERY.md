# Runbook: email delivery

Covers the two transactional emails this product sends — workspace invitations
and password recovery — from the request that queues one to the provider that
carries it.

## The shape of it

```
request transaction
  ├── invitations / password_recovery_challenges   (the IAM fact)
  └── email_deliveries                             (the instruction to send)
                    ↓  commits together, or not at all
      worker-integration, every tick
                    ↓
              Resend HTTP API
                    ↓
      state = sent + provider_message_id, payload scrubbed
           or state = failed + last_error_code, payload scrubbed
```

No request path ever calls a provider. `InvitationService` and `RecoveryService`
write a row through `RECOVERY_DELIVERY` / `INVITATION_DELIVERY` on the caller's
own executor, and return. That is what makes an invitation and its email atomic,
and it is what stops a provider outage becoming a 500 on a recovery request —
which would be an account-existence oracle, because only a real account triggers
a send.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `CONVO_EMAIL_PROVIDER` | **yes in production** | `resend` or `logging` |
| `CONVO_EMAIL_FROM` | when `resend` | `Name <address@domain>` or a bare address. The domain must be verified with Resend first. |
| `CONVO_RESEND_API_KEY` | when `resend` | ≥16 characters. Never logged, never returned by any API. |
| `CONVO_PUBLIC_BASE_URL` | yes | Every link in every email is built from this |

**Production fails closed.** A process with `NODE_ENV=production` refuses to
start when the provider is missing or set to `logging`, with a named
configuration issue. There is no silent fallback to a logging adapter; that
behaviour is what made the previous build appear to send invitations it never
sent.

`logging` is available outside production only. It writes a redacted line, sends
nothing, and returns a synthetic id so the outbox state machine still completes.

## Before the first production send

1. Verify the sending domain in Resend (DNS: SPF, DKIM, and the return-path
   record Resend gives you). An unverified domain is the single most common
   cause of `provider_credentials_rejected`.
2. Set `CONVO_EMAIL_FROM` to an address **on that verified domain**.
3. Set `CONVO_PUBLIC_BASE_URL` to the public origin the browser actually uses. A
   wrong value here sends every recipient to a host that will not accept their
   token.
4. Deploy `convo-worker-integration`. Without it, deliveries queue and nothing
   drains them.

## Checking it is working

```sql
-- Backlog and failures, the two numbers worth alerting on.
SELECT state, count(*), min(created_at) AS oldest
  FROM email_deliveries GROUP BY state;

-- What is failing, and why.
SELECT kind, last_error_code, count(*), max(last_error_at) AS latest
  FROM email_deliveries
 WHERE state = 'failed'
 GROUP BY kind, last_error_code
 ORDER BY latest DESC;
```

`EmailOutboxService.backlog()` returns the same three numbers
(`pending`, `failed`, `oldestPendingAgeSeconds`) for a dashboard.

**Alert on**: `pending` older than 15 minutes, or any increase in `failed`.
A healthy installation has a pending count that is almost always zero.

## Error codes and what to do

| `last_error_code` | Meaning | Action |
| --- | --- | --- |
| `provider_credentials_rejected` | 401/403 from Resend | The API key is wrong, or the sending domain is not verified. Fix, then resend. |
| `invalid_request:<name>` | 422 from Resend | Usually a malformed `CONVO_EMAIL_FROM`. Fix, then resend. |
| `rate_limited` | 429 | Retried automatically with backoff. No action unless it persists. |
| `provider_unavailable` | 5xx | Retried automatically. Check Resend status. |
| `provider_timeout` / `provider_unreachable` | No answer came back | Retried automatically. A duplicate is possible and acceptable here. |
| `attempts_exhausted:<code>` | Six attempts, all retryable failures | The underlying `<code>` is the real problem. Fix it, then resend. |
| `payload_unrenderable` | The stored payload is unusable | A bug, not an outage. Capture the row id and raise it. |
| `email_provider_not_configured` | No provider bound | Only reachable outside production. Configure one. |

Retry schedule: 30s, 1m, 2m, 4m, 8m, capped at one hour, six attempts.

## Resending

There is no "resend" button yet. To requeue a failed delivery, issue a **new**
invitation from the People screen — it supersedes the old one, mints a new token
and writes a new `email_deliveries` row. That is the correct action rather than
replaying the old row: the previous token may have been partially delivered, and
a token whose fate is unknown should be revoked rather than re-sent.

Do **not** flip a `failed` row back to `pending`. The payload was scrubbed when
it reached a terminal state, so the row no longer holds the token and the worker
would only fail it again as `payload_unrenderable`.

## The token at rest

`email_deliveries.payload` holds the one-time token between queueing and sending,
because the worker has to render the link and the token is knowable only once. It
is scrubbed to `'{}'` in the same statement that sets the terminal state, and the
table's `email_deliveries_scrub_ck` constraint refuses any other combination.

The exposure window is therefore the queue latency — seconds in normal
operation. The compensating controls are the ones the token already has: one hour
to live for recovery, seven days for an invitation, single use, and every session
revoked when a recovery token is spent.

**Never** log a row's payload, and never add the payload to an API response.

## What is not implemented

- No bounce or complaint handling. Resend's webhooks are not consumed, so a
  hard bounce is invisible to this product.
- No per-person language preference: emails render in
  `CONVO_DEFAULT_LOCALE`.
- No operator-facing delivery log in the UI. The SQL above is the interface.
