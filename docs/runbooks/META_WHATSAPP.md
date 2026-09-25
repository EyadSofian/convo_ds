# Runbook: Meta channels — WhatsApp, Messenger and Instagram

Covers connecting a WhatsApp Business phone number, Facebook Page or Instagram
professional account, what the transport does with each kind of provider
answer, and what is genuinely not supported.

## Status

The transport is implemented and unit-tested against a scripted Graph API
(`apps/api/src/channels/meta-whatsapp.transport.test.ts`, scripted Graph tests
covering every outcome branch).

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
| Outbound template | yes (approved catalogue entries, positional text parameters, durable preview evidence) |
| Outbound media | **no** — requires uploading to Meta and holding a media id, a separate flow |
| Inbound text, media, reactions, identity change | yes (normalization, already fixture-tested) |
| Delivery and read receipts | yes, folded onto the message by provider id |
| Messenger outbound text | yes — Page-scoped Graph `/{page-id}/messages` |
| Instagram outbound text | yes — Facebook Login with linked Page token, Graph `/{page-id}/messages` |
| Messenger / Instagram media | **no** — explicit `attachment_not_supported`; never silently downgraded |

Messenger and Instagram share the app registration and webhook signature
scheme, but not the send contract, messaging window or template rules. CONVO
uses each product's own Graph payload and validates its own asset before the
channel can become healthy.

### WhatsApp template send contract

The operator flow reads a bounded, paginated catalogue through the authorized
conversation endpoint. It never calls Meta when the picker opens. A manual
refresh requires channel-management permission and uses the existing
connection-scoped sync. Queueing a send accepts the local template id and text
values only; the API re-reads the row under the caller's tenant and exact
conversation connection, and requires the current provider status to be
`approved`. The worker sends through the existing outbox and rebuilds the Meta
components from the persisted canonical send evidence.

Supported today:

- no-variable templates;
- positional `{{n}}` text parameters in TEXT HEADER and BODY components;
- positional text values for dynamic URL buttons, using Meta's button index;
- static footer and button labels in the preview.

The product explicitly refuses media headers (image, video, document, location),
named or malformed placeholders, Flow/OTP/copy-code buttons, and any component
whose parameter contract is not implemented. Those rows remain visible with a
non-sendable explanation when returned by a non-approved status filter. They
are never sent after silently dropping an unsupported component. The approved
send view shows only approved rows.

Meta's maintained Cloud API collection shows the template envelope as
`type: "template"` with `name`, `language.code`, and optional `components`; its
examples cover body text parameters and button parameters. This implementation
matches that envelope for its supported subset, and has exact JSON transport
tests: [Meta send sample template](https://www.postman.com/meta/whatsapp-business-platform/request/v43klng/send-sample-issue-resolution-template),
[Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-071cfa60-0704-41d2-bca2-36ba6bd33dfe).

The outbound record stores the chosen template name/language, canonical
parameter component snapshot and rendered body preview. Historical outbound
rows are not backfilled with guessed parameters. The timeline additionally
binds inbound history to the conversation's half-open creation/archive interval;
outbound rows use their durable `conversation_id`, with the same temporal
interval as a compatibility boundary only for pre-existing rows without an id.

The service-window rule is unchanged: free-form text is accepted only when the
current conversation has a recent inbound event; an approved template is still
eligible outside that window. Inbound realtime invalidates the open conversation
projection so the composer can become writable without a browser refresh.

## Connecting

1. In Meta: create a **Business messaging** app in the intended Business
   Portfolio. Keep it in Development mode while using only controlled test
   accounts. Add the Messenger and Instagram products (and WhatsApp only when
   its owned WABA is available). Record the public App ID; do not put secrets
   in tickets, source, browser settings or chat.
2. Obtain the **App Secret** and a scoped, long-lived token for the exact
   asset: a Page token with `pages_messaging` for Messenger; a Page token with
   `instagram_basic` and `instagram_manage_messages` for the linked Instagram
   professional account (plus the Page read/manage permissions needed for
   discovery and webhook setup); and, if
   applicable, a System User token with `whatsapp_business_messaging`.
3. Register the Meta application as an installation-level `channel_apps` row
   using the approved database/migration-admin procedure. Its `secret_ref`
   must name the Railway variable suffix, and its verify token must be stored
   only as the row's SHA-256 hash. The API runtime intentionally cannot create
   this privileged row.
4. Set the app secret as a Railway secret named
   `CONVO_CHANNEL_SECRET_<REF>`, where `<REF>` matches the `secret_ref` stored on
   the `channel_apps` row. App secrets live in configuration, never in a column:
   rotating one is an operations act, not a database write.
5. Set `CONVO_CHANNEL_TRANSPORT=meta` on `convo-api` and every worker that
   dispatches (`convo-worker-interactive`, `convo-worker-campaign`).
6. Set `CONVO_CREDENTIAL_KEYS=v1:<base64 32 bytes>`. Without it the credential
   service refuses to seal the access token and the connection cannot be saved.
7. Create the channel connection in the product: Messenger uses its **Page ID**;
   Instagram uses its **Instagram professional account ID plus the linked
   Facebook Page ID**; WhatsApp uses its **Phone Number ID**. Select the
   registered public App ID and supply that channel's access token. For
   Instagram Facebook Login, the token must belong to the linked Page, not an
   Instagram Login token. It
   is sealed with AES-256-GCM, bound to tenant + connection + purpose, and is
   opened only inside the dispatch transaction.
8. Point the Meta webhook at
   `https://<public origin>/api/v1/webhooks/meta/<appConnectionId>` and use the
   verify token the app was configured with.
9. Run the connection test. It reads the asset back from Graph, so it fails
   with `asset_mismatch` when a token is valid but belongs to a different Page,
   linked Instagram account or phone number — the most common
   misconfiguration. Existing Instagram connections without a Page ID show
   `instagram_page_required`; use **Verify & save** to bind the correct Page
   only after its stored credential passes Page + Instagram identity checks.
10. Subscribe only the fields required for the connected products. Run one
    controlled inbound and one controlled agent reply per channel, then record
    the provider message ID and the delivery/read status where Meta exposes it.

The Channels tile says **Send unverified** while the first outbound evidence is
missing, even if inbound transport is healthy. The underlying `healthy`
readiness remains eligible for a *first* controlled send; requiring prior
outbound evidence at dispatch would deadlock verification. A queued or rejected
message is not outbound proof.

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
