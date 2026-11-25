# DS Omnichannel WhatsApp API for CRM teams

Version 1 · Server-to-server integration

The CRM selects a WhatsApp sender and sends an approved template through Omni. Omni records the message in the corresponding Inbox conversation and returns IDs and status the CRM can attach to its case, lead, or activity.

## Setup

1. In Omni, open **Settings → WhatsApp CRM connection**. Copy the Workspace ID and ask an authorized admin to create a key selecting the permitted WhatsApp senders.
2. Save the key in the CRM server's secret store. The key is shown once and stays valid until revoked, subject to the issuing admin’s access. Existing keys that were still valid at the update keep the same token without an expiry date. Keep it out of browsers, spreadsheets, URLs, client logs and support tickets.
3. Call the API over HTTPS with `Authorization: Bearer <CRM_KEY>`. No Omni login cookie, CSRF header, or Meta access token is needed. Use `Content-Type: application/json` for POST.
4. Verify that the required WhatsApp numbers are connected, webhook subscriptions are active, and templates are synchronized. If a sender's displayed phone number is missing, an admin can use **Channels → Verify connection** to refresh it. Use the sender's Omni `id` for API calls. The Meta `phoneNumberId` is a separate identifier.

Production base URL:

```text
https://omnichannel.berlitzdigitalschool-eg.com/api/v1/tenants/{tenantId}/crm/whatsapp
```

Import `crm-whatsapp.openapi.json` into Postman or your OpenAPI client and set the server variable `tenantId` plus Bearer auth. All examples use placeholders and a fictitious recipient.

## Endpoints

| Method | Path relative to the base URL | Result |
| --- | --- | --- |
| GET | `/senders` | Allowed connected WhatsApp senders, readiness, Omni IDs and Meta phone number IDs |
| GET | `/senders/{connectionId}/templates` | Synchronized catalogue for that sender. Pass `?cursor={nextCursor}` for the next page |
| POST | `/lookup` | Matched Omni contact and current conversations with the allowed senders |
| POST | `/messages` | Queues one template and returns the contact, conversation and outward message IDs |
| GET | `/messages/{messageId}` | Current dispatch, delivery and conversation status for a message created by this key |

Success returns `{"data": ..., "request_id": "..."}`. Keep `request_id` for support. Dates use UTC ISO 8601.

## Select the sender and template

Fetch senders and filter on `sendReady: true`. Map the CRM's Sales/Operations choice to the selected sender's `id`. This value identifies the sending Inbox, even when both numbers use the same display name.

```bash
curl --fail-with-body "$OMNI_CRM_BASE/senders" \
  -H "Authorization: Bearer $OMNI_CRM_KEY"

curl --fail-with-body "$OMNI_CRM_BASE/senders/$OMNI_SENDER_ID/templates" \
  -H "Authorization: Bearer $OMNI_CRM_KEY"
```

Send only when the catalogue item has `status: "approved"` and `sendSupported: true`. Use its Omni `id` from the selected sender, even if another sender has a template with the same name and language. The `parameters` definitions list the exact keys and value types to supply, such as `body:1`, `body:agent_name`, or `button:0:1`. Send an empty object for a template with no parameters. The catalogue includes component text and language for CRM-side selection and preview.

## Look up a contact or check for an existing thread

```bash
curl --fail-with-body "$OMNI_CRM_BASE/lookup" \
  -H "Authorization: Bearer $OMNI_CRM_KEY" -H 'Content-Type: application/json' \
  -d '{"phone":"+12025550123"}'
```

Supply an international phone with country code, or `contactId` if the CRM already knows the Omni UUID. When a contact has multiple WhatsApp numbers, supply both. Phone is returned with a leading `+`. This step does not change contacts or conversations.

| Lookup result | Send behavior |
| --- | --- |
| Contact and conversation on the selected sender | Reuse that conversation. Pass its `conversationId` to require that exact thread |
| Contact on another allowed sender only | Reuse the contact if the match is unique, then open a thread on the selected sender |
| Contact with no current thread on the selected sender | Open a thread on the selected sender |
| No matched contact | Queue the send and create a contact and thread together. Optionally give the contact a `displayName` |
| Only archived conversations | Open a new thread on the selected sender. Archived history remains accessible in Omni |
| Multiple matching contacts or numbers | Return 409. Use a confirmed `contactId` and `phone` to disambiguate. Omni does not merge conflicting records |

A key can look up WhatsApp identities and threads on its allowed lines. Contacts known only on other lines or channels are outside its lookup. On an existing conversation the send uses its current owner and lifecycle state. New threads go through Omni's normal routing.

## Send a template

Persist a stable `clientMessageId` with the CRM activity **before** calling Omni. Use an opaque ID unique to that send, such as a CRM activity UUID. Store the returned `id`, `contactId`, `conversationId`, and `connectionId` on the same activity. Save the customer's documented WhatsApp permission in the CRM, and pass an opaque internal reference to it as `optInReference`. A reference does not override an opt-out recorded in Omni.

```bash
curl --fail-with-body "$OMNI_CRM_BASE/messages" \
  -H "Authorization: Bearer $OMNI_CRM_KEY" -H 'Content-Type: application/json' \
  -d '{
    "connectionId": "11111111-1111-4111-8111-111111111111",
    "phone": "+12025550123",
    "displayName": "Example Customer",
    "template": {"id": "22222222-2222-4222-8222-222222222222", "parameters": {"body:1": "Example"}},
    "clientMessageId": "crm-activity-000042",
    "optInReference": "crm-consent-000017"
  }'
```

`phone` and `contactId` are alternative identifiers. Use both to check the number against the known contact. `displayName` applies to newly created contacts only. Optionally pass `conversationId` from lookup to guard against a stale or wrong thread. If it no longer matches the chosen sender and recipient, the API returns 409 without queuing anything.

HTTP **202** means Omni durably queued the command. It does not mean WhatsApp delivered it. The same key, same `clientMessageId`, and same request return the original message on retry. Reusing the same ID for a changed request returns 409. Never change keys or generate a new client ID to retry an uncertain send.

A queue response looks like this:

```json
{
  "data": {
    "id": "33333333-3333-4333-8333-333333333333",
    "clientMessageId": "crm-activity-000042",
    "connectionId": "11111111-1111-4111-8111-111111111111",
    "contactId": "44444444-4444-4444-8444-444444444444",
    "conversationId": "55555555-5555-4555-8555-555555555555",
    "conversationStatus": "open",
    "commandState": "queued",
    "stateReason": null,
    "deliveryState": null,
    "deliveryAnomaly": null,
    "providerMessageId": null,
    "queuedAt": "2026-11-24T12:00:00.000Z",
    "settledAt": null,
    "lastCustomerMessageAt": null
  },
  "request_id": "66666666-6666-4666-8666-666666666666"
}
```

## Track the case

```bash
curl --fail-with-body "$OMNI_CRM_BASE/messages/$OMNI_MESSAGE_ID" \
  -H "Authorization: Bearer $OMNI_CRM_KEY"
```

| Field | Use in the CRM |
| --- | --- |
| `commandState` | `queued`, `dispatching`, or `retry_scheduled` mean keep polling. `provider_accepted` means Meta accepted it. `rejected`, `failed`, `skipped`, and `cancelled` are final. `outcome_unknown` requires review before any deliberate resend |
| `stateReason` | Machine-readable explanation or null |
| `deliveryState` | null until evidence arrives, then `sent`, `delivered`, or `read`. Receipts depend on Meta and the recipient |
| `deliveryAnomaly` | Receipt anomaly, including provider-reported delivery failure where available |
| `conversationStatus` | Current Omni conversation lifecycle |
| `lastCustomerMessageAt` | Last inbound message on that conversation, or null. This is thread activity and does not attribute a reply to the template |
| `providerMessageId` | Meta's message ID when accepted |
| `queuedAt`, `settledAt` | Queue and final command timestamps |
| `conversationId` | Link to `https://omnichannel.berlitzdigitalschool-eg.com/#/inbox/{conversationId}` for a permitted Omni operator |

Poll every 5–10 seconds during dispatch, then back off for delivery/read status. Aggregate traffic from one client IP is limited to 300 requests per minute. Honor `Retry-After` on 429. This integration exposes polling, not a CRM callback or a transcript. During key rotation use the old key to finish polling its outstanding messages until you revoke it.

## Failure handling

| HTTP | What to do |
| --- | --- |
| 400 | Correct the request, phone, UUID, cursor, or parameter shape |
| 401 | Verify tenant and key. Check revocation and whether the issuing admin can still manage API keys. Any key that expired before the no-expiry update remains invalid |
| 403 | The current access rules deny this send or template |
| 404 | Use a sender, contact or message visible to this key |
| 409 | Check `error.code`. Refresh the catalogue for `template_not_sendable`, fix the channel for `channel_not_ready`, resolve identity conflicts, or recalculate the expected conversation after `conversation_mismatch`. Stop on `consent_withdrawn` |
| 422 | Fix required template values, or select a supported template |
| 429 | Wait at least `Retry-After` seconds and back off |
| 5xx / network timeout | Retry with the same key, identical body and same `clientMessageId` |

Errors return `{"error":{"code":"…","message":"…","request_id":"…","details":[]}}`. Keep request IDs, not secrets or full customer data, in support logs.

## Acceptance checklist

- Create a separate key for testing. Confirm the catalogue returns each permitted line and the desired template language, then revoke the test key when finished.
- With an opted-in test number, send from Sales and verify the template appears in its Inbox conversation. Poll until a provider status arrives.
- Repeat the exact request and confirm the same IDs return. Send a separate activity from Operations and confirm a separate conversation on that line with the same contact.
- Test a new number, a known contact, an invalid template, a line outside the key, and revocation. Send test messages only to approved test recipients.
