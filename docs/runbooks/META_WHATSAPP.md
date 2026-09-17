# Runbook: WhatsApp Cloud API

Covers connecting a WhatsApp Business phone number, what the transport does with
each kind of provider answer, and what is genuinely not supported.

## Status

The transport is implemented and unit-tested against a scripted Graph API
(`apps/api/src/channels/meta-whatsapp.transport.test.ts`, 28 tests covering every
outcome branch).

**It has never been run against live Meta assets.** No authorized App ID, App
Secret, access token or phone number id exists for this installation, so no
inbound or outbound message has been exchanged with Meta. Everything below the
"Connecting" heading is written from the API contract, not from an observed
production send. That gate is `BLOCKED_EXTERNAL` in the readiness report and must
not be reported as passing until a real send has been made and evidenced.

## What is supported

| | |
| --- | --- |
| Outbound text | yes |
| Outbound template | yes (name + language; no variable substitution yet) |
| Outbound media | **no** — requires uploading to Meta and holding a media id, a separate flow |
| Inbound text, media, reactions, identity change | yes (normalization, already fixture-tested) |
| Delivery and read receipts | yes, folded onto the message by provider id |
| Messenger, Instagram | **no** — refused by name with `channel_not_supported` |

Messenger and Instagram share this app registration and this signature scheme,
but not the send contract, the messaging window or the template rules. One
adapter pretending otherwise is how Instagram ends up governed by WhatsApp's
rules (ADR-0009). They need their own adapters.

## Connecting

1. In Meta: create the app, add WhatsApp, obtain the **App Secret**, the
   **Phone Number ID** and a **System User access token** with
   `whatsapp_business_messaging`.
2. Set the app secret as a Railway secret named
   `CONVO_CHANNEL_SECRET_<REF>`, where `<REF>` matches the `secret_ref` stored on
   the `channel_apps` row. App secrets live in configuration, never in a column:
   rotating one is an operations act, not a database write.
3. Set `CONVO_CHANNEL_TRANSPORT=meta` on `convo-api` and every worker that
   dispatches (`convo-worker-interactive`, `convo-worker-campaign`).
4. Set `CONVO_CREDENTIAL_KEYS=v1:<base64 32 bytes>`. Without it the credential
   service refuses to seal the access token and the connection cannot be saved.
5. Create the channel connection in the product and supply the access token. It
   is sealed with AES-256-GCM, bound to tenant + connection + purpose, and is
   opened only inside the dispatch transaction.
6. Point the Meta webhook at
   `https://<public origin>/api/v1/webhooks/meta/<appConnectionId>` and use the
   verify token the app was configured with.
7. Run the connection test. It reads the phone number back from Graph, so it
   fails with `asset_mismatch` when the token is valid but for a different
   number — the most common misconfiguration.

## Outcome classification

This is the part that decides whether a customer gets a message twice, once or
never. `ChannelDispatcherService` acts on three outcomes:

| Provider answer | Outcome | Retried? |
| --- | --- | --- |
| 200 with a message id | `accepted` | n/a |
| 200 with no message id | `outcome_unknown` | **never** |
| timeout / network failure | `outcome_unknown` | **never** |
| 429, code 4 / 80007 / 130429 | `definitely_rejected`, retryable | yes, with backoff |
| 5xx | `definitely_rejected`, retryable | yes |
| 401 / code 190 (token expired) | `definitely_rejected`, retryable | yes — reconnect fixes it |
| code 131047 (outside 24h window) | `definitely_rejected`, permanent | no — only a template helps |
| code 131026 (undeliverable) | `definitely_rejected`, permanent | no |
| code 100 / 131009 (bad request) | `definitely_rejected`, permanent | no |
| any other 4xx | `definitely_rejected`, permanent | no |

An unrecognised refusal is treated as permanent on purpose: retrying something we
do not understand five times is how a rate limit becomes a ban.

**`outcome_unknown` is never automatically retried.** The message leaves the
outbox, keeps its state, and stays visible. Resolving it needs a verified
provider idempotency contract or a human decision, and neither is pretended here
(ADR-0006).

## Diagnosing

```sql
-- Messages that ended ambiguous. These need a person.
SELECT id, peer_identity, state_reason, settled_at
  FROM outbound_messages
 WHERE command_state = 'outcome_unknown'
 ORDER BY settled_at DESC LIMIT 50;

-- What the provider has been refusing lately.
SELECT error_code, count(*), max(completed_at)
  FROM outbound_attempts
 WHERE outcome <> 'accepted' AND completed_at > now() - interval '24 hours'
 GROUP BY error_code ORDER BY 2 DESC;

-- Webhook deliveries that failed to verify. A run of these means the app
-- secret is wrong or has been rotated without updating configuration.
SELECT outcome, count(*), max(received_at)
  FROM webhook_receipts
 WHERE received_at > now() - interval '1 hour'
 GROUP BY outcome;
```

## Token expiry

A System User token can be long-lived but not permanent. When it expires every
send returns code 190 → `credential_rejected`, retryable. The outbox retries five
times with backoff and then fails the message, so an expired token shows up as a
burst of `credential_rejected` in `outbound_attempts` rather than as silence.

Reconnect the channel with a fresh token. Messages that failed while it was
expired are not automatically re-sent — check `outbound_messages` for
`command_state = 'failed'` with `state_reason = 'credential_rejected'` and decide
per conversation.

## Rate limits

Meta's throughput limits are per phone number and tier-dependent. The dispatcher
already bounds a round by worker concurrency and deals capacity out fairly across
companies (ADR-0007), so the product does not burst. A sustained `rate_limited`
run means the number's tier is below the campaign volume being attempted — the
fix is Meta-side, not here.
