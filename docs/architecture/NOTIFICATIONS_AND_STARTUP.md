# Notifications, mobile delivery, and startup

Status: feature-branch implementation; not deployed or live-push verified.

## Transport decision

**KEEP SSE**, with one cursor correction. Product events flow server → client; user commands already use authenticated, CSRF-protected HTTP. The existing feed has a durable tenant sequence, catch-up, per-event authorization, cursor resume, permission invalidation, and reset handling. WebSocket would not provide closed-browser delivery or make notification state durable. The stream now puts each event's own sequence in its SSE `id`; a disconnect after the first event in a batch can resume without skipping the rest.

The `notifications` table is the source of truth. `notification.changed` is a recipient-only invalidation in the existing feed; the browser re-reads the list/count. Push is a separate best-effort delivery channel. Neither SSE nor push grants access to the linked entity.

## Data and access rules

- A notification is keyed by tenant, recipient membership, kind, target, and a producer-supplied deduplication key. The API only lists/marks records for the authenticated active membership under tenant RLS.
- Current producers are customer inbound to the current assignee, assignment, and handoff request. Campaign and automation target kinds are reserved in the schema but are **not yet produced** by those domains.
- Inbound, routing change, notification insert, push enqueue, and SSE invalidation commit in the same domain transaction. A duplicate source event cannot create a second notification with the same key.
- Push-device subscriptions are encrypted with `CONVO_CREDENTIAL_KEYS`, bound to tenant and device ID. The API never returns endpoint/keys. Within a tenant, one active push endpoint may belong to only one device/member; switching accounts retires the previous registration.
- The push queue contains only IDs, state, lease, and error codes. The integration worker enters tenant RLS context before reading encrypted device material. It sends generic, body-free payloads. 404/410 revoke a subscription; network, 408, 429 and 5xx retry up to five attempts. A crash after provider acceptance but before queue settlement can duplicate a generic OS hint; the durable notification remains deduplicated.
- A push click opens the existing authorized route (`/#/inbox/:conversationId` for a conversation/handoff). The route/API must re-check access; revoked access yields the normal unavailable/permission state. No message text, customer name, phone, note, cookie, token, or tenant ID goes to the lock screen.
- Each browser explicitly enables push; opening the app or drawer never requests permission. Logout attempts local unsubscribe and server revocation. If offline, the server will eventually disable a stale endpoint on 404/410.

## Configuration and activation

Schema migration: `0039_notifications.sql`. The API needs `CONVO_WEB_PUSH_PUBLIC_KEY` and the existing credential encryption keys to register devices. Only `worker-integration` reads `CONVO_WEB_PUSH_PRIVATE_KEY` and `CONVO_WEB_PUSH_SUBJECT`, plus the matching public key and encryption keys. All three VAPID values must be complete for that worker. Never put the private key in web assets, ordinary API process variables, logs, or Git. In-app notifications work without VAPID; OS push remains unavailable until configured and live tested on controlled devices.

Before staging activation: configure a staging-only VAPID key pair, apply migration, run the API and integration worker at the same SHA, register a controlled device by an explicit click, send a controlled inbound message, then verify the durable record, unread badge, background OS push, tap/deep link, permission denial after revocation, retry, and restart/replay. No production rollout is implied by unit/integration results.

## Mobile paths

The installable PWA uses a service worker and Web Push. `notification_devices` has platform and multi-device identity fields so later packaged Android/iOS clients can register FCM/APNs tokens without changing notification persistence. Native token registration, native delivery adapters, and packaged-app deep-link handlers are **future work**, not claimed as implemented. An OS badge uses the server unread count where the browser supports the Badging API; active browsers receive count invalidations over SSE.

## Initial open/reload

The HTML prepaints saved language/direction and theme before the main bundle. A data-free shell placeholder renders immediately; while the HTTP-only session is checked, the app shows a matching route-aware skeleton rather than an empty document or full-screen spinner. This placeholder must not render protected navigation or tenant data before authorization. Existing self-hosted font preloads remain. On normal route refresh, the stable shell stays visible while critical data resolves; realtime reconnects using the durable cursor.

Browser timing and authenticated visual QA still need repeatable measurements before a release claim. The local unauthenticated browser check proved a rendered error gate rather than a blank screen; it did not prove authenticated startup performance.
