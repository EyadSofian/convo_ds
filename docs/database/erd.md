# CONVO — Data model (P0 proposal)

PostgreSQL. Every tenant-owned table carries `tenant_id uuid NOT NULL`. Every cross-entity FK is **composite** and includes `tenant_id`, so a cross-tenant relationship cannot be represented. RLS is enabled on every tenant-owned table with `USING` and `WITH CHECK`.

Conventions:

- PKs are `uuid` (v7 where ordering helps) exposed as opaque strings; provider IDs stay opaque text and are never coerced to numbers or UUID-validated.
- Timestamps are `timestamptz`, stored UTC. Schedules additionally carry an IANA `timezone text`.
- Money is `numeric(20,6)` in **minor units with an explicit currency**, never float.
- Soft state uses explicit enums, never magic integers.
- `xmin`-style optimistic concurrency is replaced by an explicit `version integer NOT NULL DEFAULT 1` on contested rows (conversations, campaigns, ownership).

## 1. Installation and tenancy

```
installations            (id, singleton bool UNIQUE, deployment_mode, bootstrap_state,
                          single_tenant_id uuid NULL, recovery_hold bool, dispatch_epoch int, created_at)
tenants                  (id, name, slug, status, placement, created_at, suspended_at, deletion_requested_at)
                          status ∈ provisioning|active|suspended|deletion_pending|deleted
tenant_entitlements      (tenant_id PK, seats, channels, active_contacts, storage_bytes,
                          campaign_recipients_month, api_rate, features jsonb, updated_at)
tenant_usage_counters    (tenant_id, period, metric, value)  -- reservation-safe
idempotency_records      (tenant_id NULL, principal_id, operation, idempotency_key,
                          request_hash, state, response_status, response_body, expires_at)
                          UNIQUE NULLS NOT DISTINCT (tenant_id, principal_id, operation, idempotency_key)
```

`installations` holds exactly one row, enforced by `UNIQUE (singleton)`. `recovery_hold` is mirrored here for visibility but is **authoritatively enforced outside the application snapshot** (ADR-0014).

`single_tenant_id` is how MODE-04 is enforced *below* the service layer. A `BEFORE INSERT` trigger on `tenants` (`enforce_installation_tenancy`, migration `0004`) reads the singleton row `FOR UPDATE`; in `self_hosted_single` it claims the first company and rejects every later one with `unique_violation`. In `saas` it does nothing and the column stays NULL. The trigger also refuses **any** company while no installation row exists, so a database that never had boot configuration applied fails closed rather than silently accepting tenants of unknown mode.

Migration `0005` adds `idempotency_records`. The first request inserts a pending row, performs its business effect, and stores the HTTP result inside the same PostgreSQL transaction. A conflicting insert waits for that transaction; it then replays the completed JSON result for the same canonical keyed-HMAC request fingerprint or returns a typed conflict for another fingerprint. The server-side HMAC secret prevents a database reader from using the stored fingerprint as a password-guessing oracle. Bootstrap uses a NULL tenant scope because it runs before a tenant or principal exists, and `UNIQUE NULLS NOT DISTINCT` keeps that pre-auth scope unique. FORCE RLS exposes tenant rows only to the matching tenant context; NULL installation rows require an explicit transaction-local installation scope and are invisible from ordinary tenant transactions. The bootstrap transaction switches to and verifies the generated tenant context before inserting tenant-owned rows, without losing access to its pre-auth idempotency record.

## 2. Identity and access

```
users                    (id, email citext UNIQUE, password_hash, mfa_state, status, created_at)
user_sessions            (id, user_id, created_at, last_seen_at, ip_hash, ua_hash, revoked_at)
user_mfa_factors         (id, user_id, type, secret_ref, confirmed_at)
user_recovery_codes      (id, user_id, code_hash, used_at)

memberships              (id, tenant_id, user_id, role_id, status, created_at, revoked_at)
                          UNIQUE (tenant_id, user_id)
roles                    (id, tenant_id NOT NULL, key, name, is_builtin, version)
                          -- Built-in roles are seeded PER TENANT at provisioning.
                          -- A shared global role row would need a nullable tenant_id,
                          -- which under MATCH SIMPLE would silently disable every
                          -- composite FK that references it. Decided during P1-T1.
                          UNIQUE (tenant_id, id), UNIQUE (tenant_id, key)
role_permissions         (tenant_id, role_id, permission_key) PK (tenant_id, role_id, permission_key)
                          FK (tenant_id, role_id) -> roles (tenant_id, id)
permissions              (key PK, description, delegable bool)

teams                    (id, tenant_id, name, archived_at)
                          -- A name is reserved only while the team is live, so an archived
                          -- "Enrollment" does not block a new one. Migration 0009 replaced
                          -- UNIQUE (tenant_id, name) with a partial unique index:
                          UNIQUE (tenant_id, id)
                          UNIQUE INDEX (tenant_id, name) WHERE archived_at IS NULL
team_members             (tenant_id, team_id, membership_id) PK (tenant_id, team_id, membership_id)
membership_scopes        (id, tenant_id, membership_id, scope_type, scope_id)
                          scope_type ∈ tenant|team|inbox
invitations              (id, tenant_id, invited_by, email, role_id, token_hash, status,
                           created_at, expires_at, accepted_at, accepted_membership,
                           revoked_at, revoked_by)
                          status ∈ pending|accepted|revoked; token_hash is an HMAC
                          fingerprint, never a token. One live invitation per address
                          (partial unique index). RLS admits the row whose token_hash
                          matches convo.credential_hash, so acceptance can find it before
                          a tenant context exists.
invitation_scopes        (tenant_id, invitation_id, scope_type, scope_id)
ownership_transfers      (id, tenant_id, from_membership, to_membership, status,
                           created_at, expires_at, settled_at)
                          status ∈ pending|accepted|declined|cancelled; one live offer per
                          company (partial unique index). No token: it is an offer the
                          recipient accepts while signed in, not a link.

-- Channels (migration 0010) -------------------------------------------------
channel_apps             (id, provider, external_app_id, secret_ref, secret_fingerprint,
                          verify_token_hash, graph_version, status, created_at, rotated_at)
                          Installation level, NOT tenant-scoped, and the runtime role has
                          only SELECT. The app secret is never here: `secret_ref` names the
                          configuration key it is read from, and `secret_fingerprint` makes
                          a rotation that skipped this row a visible mismatch rather than a
                          webhook that quietly stops verifying.
channel_connections      (id, tenant_id, app_id, kind, external_asset_id, display_name, status,
                          capabilities jsonb, asset_verified_at, credential_verified_at,
                          webhook_subscribed_at, first_inbound_at, first_outbound_at,
                          last_error_code, last_error_at, created_at, disconnected_at)
                          kind ∈ whatsapp|messenger|instagram|web_chat|custom. Readiness is
                          derived from the five evidence timestamps, never written directly.
                          UNIQUE INDEX (tenant_id, kind, external_asset_id)
                            WHERE disconnected_at IS NULL
channel_credentials      (id, tenant_id, connection_id, purpose, version, ciphertext bytea,
                          iv bytea, auth_tag bytea, key_version, fingerprint, status,
                          expires_at, created_at, revoked_at)
                          AES-256-GCM with the tenant, connection and purpose as additional
                          authenticated data, so a ciphertext moved to another row does not
                          decrypt. Rotation appends a version and supersedes the previous
                          one; there is no DELETE grant. Exactly one active version per
                          (connection, purpose), by partial unique index.
channel_asset_registry   (asset_fingerprint PK, provider, kind, external_asset_id,
                          tenant_id, connection_id, claimed_at)
                          Installation-wide: one provider asset belongs to one company
                          (CH-03). asset_fingerprint = sha256(provider:kind:external_asset_id).
                          RLS admits the row whose fingerprint matches
                          convo.asset_fingerprint, so a webhook can resolve its owner with no
                          tenant context and see nothing else. Writes still need the ordinary
                          tenant context.
webhook_receipts         (id, app_id, route_key, received_at, body_sha256, body_bytes,
                          signature_valid, outcome, tenant_id, event_count)
                          Installation level and deliberately contentless: evidence that
                          bytes arrived and whether they verified. outcome ∈ routed|
                          unknown_asset|signature_invalid|unsupported|malformed, and only a
                          routed receipt names a tenant.
channel_events           (id, tenant_id, connection_id, receipt_id, dedupe_key, event_type,
                          payload jsonb, normalized jsonb, schema_version, status,
                          quarantine_reason, received_at, processed_at)
                          The tenant-scoped raw journal, written before the ACK. `payload` is
                          the provider's own element (the evidence); `normalized` is what the
                          adapter made of it. UNIQUE (tenant_id, dedupe_key) is what makes a
                          redelivery one effect. A quarantined element keeps its payload.
channel_event_queue      (event_id PK, tenant_id, enqueued_at, attempts, leased_by,
                          lease_until, last_error)
                          Installation level and contentless, so a worker can ask "is there
                          work anywhere" with no tenant context without a carve-out on the
                          table that holds the messages. Written in the same transaction as
                          the event it points at.
inbound_events           (id, tenant_id, connection_id, event_id, kind, provider_message_id,
                          peer_identity, asset_identity, content_type, text_body,
                          attachments jsonb, detail jsonb, occurred_at, observed_at)
                          The normalized projection everything downstream reads. Both times
                          are kept because they disagree. UNIQUE INDEX
                          (tenant_id, event_id, kind, coalesce(provider_message_id, ''))
                          makes re-running the projection idempotent.

-- Outbound (migration 0011) -------------------------------------------------
channel_suppressions     (id, tenant_id, kind, peer_identity, reason, note,
                          created_at, created_by)
                          The consent check the dispatcher makes at permit time. No DELETE
                          grant: withdrawing consent is a fact with a time.
outbound_messages        (id, tenant_id, connection_id, peer_identity, author_membership,
                          message_type, text_body, template_name, template_language,
                          attachments jsonb, client_message_id,
                          command_state, state_reason,
                          delivery_state, delivery_state_at, delivery_anomaly,
                          provider_message_id, dispatch_version, created_at, settled_at)
                          Two state machines in two columns. command_state ∈ queued|
                          dispatching|provider_accepted|rejected|retry_scheduled|skipped|
                          cancelled|failed|outcome_unknown — unordered, and never folded
                          with max(). delivery_state ∈ sent|delivered|read, folded
                          separately; a receipt never moves it backwards and one that would
                          have is recorded in delivery_anomaly. UNIQUE
                          (tenant_id, client_message_id): the caller's retry is the same
                          message, not a second one.
outbox                   (message_id PK, tenant_id, connection_id, peer_identity,
                          traffic_class, available_at, attempts, leased_by, lease_until,
                          last_error)
                          Installation level and contentless, written in the same
                          transaction as the command. The partial unique index
                          (tenant_id, connection_id, peer_identity) WHERE lease_until IS NOT
                          NULL is the serialized dispatch gate: one conversation puts one
                          message on the wire at a time.
outbound_attempts        (id, tenant_id, message_id, attempt_no, permit jsonb, started_at,
                          completed_at, outcome, provider_message_id, error_code,
                          error_message)
                          Committed BEFORE the network call. outcome ∈ accepted|
                          definitely_rejected|outcome_unknown, and NULL means the attempt
                          started and no answer was ever recorded — which after a crash is
                          exactly the evidence that the result is unknown. No DELETE grant:
                          an attempt is the evidence that we did, or may have, contacted a
                          customer.

-- Broker relay (migration 0013) ----------------------------------------------
broker_outbox            (id, tenant_id, topic, envelope jsonb, created_at, available_at,
                          published_at, attempts, leased_by, lease_until, last_error)
                          Written in the same transaction as the effect it announces, and
                          `published_at` is set only after the broker CONFIRMS. A claim with
                          no confirmation is retried, because a duplicate is survivable and
                          a lost event is not (ADR-0004, ADR-0005).
broker_deliveries        (envelope_id, consumer, tenant_id, first_seen_at, attempts)
                          PK (envelope_id, consumer). A consumer records that it handled an
                          envelope in the same transaction as the handling, which is what
                          makes at-least-once delivery safe to build on.
broker_dead_letters      (id, tenant_id, topic, envelope jsonb, reason, attempts,
                          quarantined_at, replayed_at, replayed_by)
                          Bounded retries end here rather than in an infinite loop or in
                          nothing. A replay is an operator act and is recorded as one.

-- Conversations and the realtime feed (migration 0014) -----------------------
conversations            (id, tenant_id, connection_id, peer_identity, team_id,
                          assignee_membership_id, status, priority, version,
                          waiting_since, last_inbound_at, last_activity_at, created_at)
                          status ∈ open|snoozed|resolved; priority ∈ low|normal|high|urgent.
                          A channel connection IS an inbox in this build, so
                          `membership_scopes.scope_type = 'inbox'` names a connection id.
                          UNIQUE (tenant_id, connection_id, peer_identity): the same pair the
                          dispatch gate serializes on, now with an identity. `version` is the
                          claim's fence — exactly one winner, the loser gets a typed conflict
                          (IAM-13). `waiting_since` is set only while nobody holds it.
conversation_participants(tenant_id, conversation_id, membership_id, first_acted_at)
                          Participation outlives assignment: an agent reassigned tomorrow
                          keeps read access to what they wrote today. Losing inbox access
                          still overrides it, because `authorize` checks scope first.
tenant_event_sequences   (tenant_id PK, next_seq bigint)
                          A counter row, not a `bigserial`. Sequence values are handed out
                          before commit and NOT in commit order, so a subscriber polling
                          "everything after 41" can read 42 while 41 is still uncommitted and
                          never see 41 again. A row lock held to commit makes the numbers
                          dense and in commit order; the cost is that two events for one
                          company serialize here.
realtime_events          (id, tenant_id, seq, schema_version, type, entity_type, entity_id,
                          entity_version, conversation_id, connection_id, team_id,
                          assignee_membership_id, payload jsonb, occurred_at)
                          Append-only: the runtime role holds SELECT and INSERT and nothing
                          else. type ∈ message.inbound|message.delivery|conversation.assigned|
                          conversation.state|conversation.note — separate types, so a
                          subscriber authorized for receipts and not for notes can be filtered
                          without reading either. The authorization terms are COLUMNS, not
                          payload fields: visibility is decided from connection_id, team_id
                          and assignee_membership_id before the payload is looked at, so a
                          projection cannot be defeated by a payload that carries more than it
                          should (DEL-19, IAM-11).

-- Conversation reads (no migration) -------------------------------------------
-- The timeline is a **read**, not a table: `inbound_events` and
-- `outbound_messages` are merged by a `UNION ALL` at query time and paged
-- backwards with a signed, expiring cursor bound to the company, the
-- conversation and the sort. Copying them into a `messages` table would create
-- a second place for a message to exist and drift out of step with the
-- evidence it was derived from.

-- Lifecycle, notes, episodes and read cursors (migration 0017) ---------------
conversations.pending_reason / pending_since
                          Why an agent said they were waiting, and since when. The status
                          pill says a conversation is waiting; only the reason says what
                          for, and the reason is the whole value of having pressed it.
conversations.snoozed_until / snooze_timezone / wake_version
                          The instant and the ZONE, because they answer different
                          questions: the instant is when the job fires, the zone is what the
                          operator meant. Keeping only the instant makes "tomorrow morning"
                          unre-derivable after a DST change. `wake_version` is the fence —
                          re-snoozing bumps it so the job already scheduled matches nothing.
conversations.resolved_at / resolution / archived_at
                          The disposition and when it was reached. Cleared on reopen: a
                          reopened thread still carrying its old disposition would report as
                          answered while somebody is still working on it.
conversations_live_identity_uq
                          UNIQUE (tenant_id, connection_id, peer_identity) WHERE status <>
                          'archived'. The identity is held until ARCHIVAL, not until
                          resolution — a resolved thread is the one a new inbound reopens,
                          so a second row must not be created beside it. Making the index
                          partial is what lets an archived thread keep its history while the
                          customer's next message opens a thread of its own.
conversation_wakes       (tenant_id, conversation_id PK, wake_at, wake_version)
                          A durable job, not a timer in a process. The sweeper's UPDATE is
                          guarded on `wake_version` AND `status = 'snoozed'`, so a job whose
                          conversation was re-snoozed, resolved or already woken by a
                          message is a no-op — and is deleted either way, or the sweeper
                          revisits it forever.
conversation_episodes    (id, tenant_id, conversation_id, seq, opened_at, opened_by,
                          first_inbound_at, first_response_at, closed_at, resolution)
                          One row per time the conversation was WORKED. A reopen closes the
                          current episode and opens a new one; reusing the first would start
                          the second issue's clock at the first issue's first message and
                          make every resolution-time report a lie (CON-04). `first_response_at`
                          is written with `coalesce` inside the same transaction as the reply
                          command, so the first response is the first and a second reply
                          cannot move the number a report is computed from.
conversation_notes       (id, tenant_id, conversation_id, author_membership_id, body,
                          created_at, edited_at, deleted_at)
                          Internal. Never a message, never on a wire, and never a lifecycle
                          trigger — `internal_activity` is an explicit no-op row in §18.1, so
                          a note cannot reopen a resolved thread (CON-05). A deletion keeps
                          the row and its attribution and drops only the text: a thread that
                          silently lost an internal remark could not be reconstructed, and
                          one that kept the text after a deletion would not honour it.
                          Only the author may edit or delete, which is a 403 rather than a
                          404 because the caller may read the note.
conversation_reads       (tenant_id, conversation_id, membership_id) PK all three,
                          read_through, updated_at
                          Unread is DERIVED by comparing this person's cursor against
                          `conversations.last_activity_at` — no per-message bookkeeping and
                          no count for anybody to keep correct. One row per person, so two
                          agents reading the same thread never see each other's state, and
                          it is not a receipt: nothing here reaches the customer and nothing
                          here moves the conversation (MSG-04, CON-07).

-- Receipt watermark (migration 0015) -----------------------------------------
outbound_messages.receipts_folded_through timestamptz
                          The highest `inbound_events.observed_at` already folded into this
                          message's delivery state. Without it the reconciler re-folds
                          receipts it has already applied, and a correctly-ordered
                          delivered → read pair turns into a fabricated
                          `delivered_after_read` on the next sweep. Keyed on observation,
                          not on the provider's timestamp, so a genuinely late `delivered`
                          is still folded once and its anomaly recorded (DEL-16).

platform_admins          (id, user_id, granted_at)          -- no tenant membership
support_grants           (id, tenant_id, platform_admin_id, scope jsonb, reason, expires_at, revoked_at)

api_keys                 (id, tenant_id, name, prefix, verifier_hash, scopes jsonb,
                          created_by_membership_id, expires_at, rotated_from_id, revoked_at)
```

`memberships.status ∈ active|suspended|revoked`. A partial unique index guarantees **at least one active Owner** per tenant is never removed (enforced in a trigger + service check, IAM-15).

## 3. Channels and inboxes

```
channel_connections      (id, tenant_id, provider, asset_kind, external_asset_id,
                          graph_version, config jsonb, credential_ref, readiness_state,
                          evidence jsonb, last_health_at, version)
                          UNIQUE (provider, asset_kind, external_asset_id)  -- installation-wide registry
                          readiness ∈ not_configured|authorization_pending|verifying|connected
                                     |degraded|reauthorization_required|disconnected
channel_capabilities     (connection_id, version, matrix jsonb, observed_at, source_url)
inboxes                  (id, tenant_id, name, connection_id NULLABLE, routing_policy_id, version)
                          UNIQUE (tenant_id, id) -- referenced by composite FKs
inbox_members            (tenant_id, inbox_id, membership_id) PK (tenant_id, inbox_id, membership_id)
connection_migrations    (id, tenant_id, inbox_id, from_connection_id, to_connection_id, at, actor)
```

`evidence` records the five separate proofs required before `connected`: asset authorization, grant verification, subscription verification, inbound test, outbound test (CH-02).

## 4. Contacts, identity, consent

```
contacts                 (id, tenant_id, display_name, attributes jsonb, created_at, deleted_at)
                          UNIQUE (tenant_id, id)
contact_identities       (id, tenant_id, contact_id, provider, scope_type, scope_id,
                          external_id, valid_from, valid_to, provenance jsonb)
                          FK (tenant_id, contact_id) → contacts (tenant_id, id)
                          UNIQUE (tenant_id, provider, scope_type, scope_id, external_id, valid_from)
identity_merges          (id, tenant_id, winner_contact_id, merged_contact_id, actor, at, reversible bool, evidence jsonb)
custom_fields            (id, tenant_id, key, type, validation jsonb)   UNIQUE (tenant_id, key)
tags                     (id, tenant_id, name)                          UNIQUE (tenant_id, name)
contact_tags             (tenant_id, contact_id, tag_id)  PK all three

consents                 (id, tenant_id, contact_id, channel, purpose, granted_at,
                          source, proof_ref, actor, revoked_at)          -- append-only
suppressions             (id, tenant_id, contact_id NULLABLE, identity_value_hash, channel,
                          reason, created_at, created_by, released_by_consent_id NULLABLE)
                          UNIQUE (tenant_id, identity_value_hash, channel) WHERE released_by_consent_id IS NULL
segments                 (id, tenant_id, name, ast jsonb, version)       -- validated safe AST only
imports                  (id, tenant_id, status, mapping jsonb, counts jsonb, cursor, created_by)
import_rows_errors       (id, tenant_id, import_id, row_number, reasons jsonb)
exports                  (id, tenant_id, kind, filter jsonb, status, artifact_ref, expires_at, created_by)
```

Suppression is keyed by a **hashed identity value** so it survives contact merges and deletions.

### As built (migrations 0016 and 0019)

Contacts, scoped identities, consent, labels and typed custom fields exist today. Merges, segments, imports and exports remain unbuilt.

```
contacts                 (id, tenant_id, display_name, attributes jsonb,
                          created_at, updated_at, deleted_at)
                          UNIQUE (tenant_id, id). Deliberately thin: the channel-specific
                          facts live on the identity rows, and business fields live in
                          `attributes` because every company means something different by
                          "grade", "branch" or "plan". `display_name` is what an agent sees
                          and may correct — it is NOT an identity, and correcting it links
                          nothing and unlinks nothing (CT-01).
                          A soft delete keeps the row: a conversation that referenced the
                          contact must still render, and erasing history would erase the
                          evidence of what was said to whom.
contact_identities       (id, tenant_id, contact_id, kind, scope_id, external_id,
                          valid_from, valid_to, provenance jsonb)
                          `scope_id` is the channel connection the external id is meaningful
                          in — a Messenger id is page-scoped, so the same person messaging
                          two pages is two identities (CT-02). Rotation CLOSES an interval
                          and opens a new one rather than overwriting a column: a number
                          reassigned to somebody else must not silently re-attribute the
                          messages sent to it before the reassignment.
                          UNIQUE (tenant_id, kind, scope_id, external_id) WHERE valid_to IS NULL
                          — one *live* identity per scoped external id; history is unbounded,
                          the present is not.
                          FK (tenant_id, scope_id) → channel_connections ON DELETE CASCADE, so
                          a contact can outlive every identity it arrived on. The directory
                          keeps such a contact rather than dropping it, because its consent
                          history is attached to the contact, not to the connection.
consents                 (id, tenant_id, contact_id, channel, purpose, state, source,
                          proof_ref, actor_membership_id, recorded_at)
                          Append-only in the grant, not only by convention: the runtime role
                          holds SELECT and INSERT and NOTHING else. A consent record is a
                          claim about a moment — who said what, through which channel, for
                          which purpose, on whose word — and a table that can be edited
                          cannot answer the question it exists to answer (CT-06).
                          Withdrawal is a NEW ROW. The current state is the newest row per
                          (contact, channel, purpose), which is why `recorded_at` is in the
                          index rather than a `current` flag somebody has to maintain.
                          state ∈ granted|withdrawn; source ∈ customer_message|agent_recorded|
                          import|web_form. `import` can never mean opt-in on its own (CT-07).
conversations.contact_id Nullable, resolved when the customer's first message is normalized.
                          A conversation opened by an outbound template to a number nobody
                          has heard from has no contact yet, and inventing one from a phone
                          number would be the inference this schema exists to refuse.
                          ON DELETE SET NULL: a purged contact does not take the conversation
                          with it.
labels                    (id, tenant_id, name, color, state, version, created_at, updated_at)
                          A partial unique index protects active names. Retirement preserves
                          old assignments and frees the name for an intentional replacement.
contact_labels            Assignment intervals with actor and removal attribution.
conversation_labels       Assignment intervals with actor and removal attribution.
custom_fields             (id, tenant_id, target, key, name, type, options, state, version)
                          target ∈ contact|conversation; type ∈ text|number|boolean|date|
                          single_select|multi_select. Target, key and type are immutable;
                          changing one would reinterpret every historical value.
contact_custom_field_values
conversation_custom_field_values
                          Store original `value_json` beside bounded `search_value`.
                          Database triggers repeat target/state/type/option validation so a
                          future writer cannot bypass the API's domain validator.
metadata_audit            Append-only actor/effect evidence for catalogue and entity changes.
```

**Suppression is not in `consents`.** It stays in `channel_suppressions`, keyed by `(kind, peer_identity)` rather than by contact — which is what makes "a suppression survives a contact merge, a deletion and a CRM import" true rather than hopeful. A contact's suppressed channels are derived by joining its **live** identities against that table, so an ended identity cannot carry a suppression forward to whoever holds the number now.

## 5. Conversations and messages

```
conversations            (id, tenant_id, inbox_id, contact_id, contact_identity_id,
                          status, priority, assignee_membership_id, team_id,
                          owner_state, owner_version, snoozed_until, snooze_timezone,
                          last_customer_message_at, last_agent_message_at,
                          version, created_at, archived_at)
                          status ∈ open|pending|snoozed|resolved
                          owner_state ∈ bot_active|handoff_pending|human_active|bot_paused
                          FK (tenant_id, inbox_id) → inboxes (tenant_id, id)
                          FK (tenant_id, contact_id) → contacts (tenant_id, id)
                          UNIQUE (tenant_id, inbox_id, contact_identity_id)
                            WHERE archived_at IS NULL AND status IN ('open','pending','snoozed')
conversation_participants(tenant_id, conversation_id, membership_id, role, joined_at)
conversation_episodes    (id, tenant_id, conversation_id, opened_at, resolved_at, reopened_from_id)
conversation_audit       (id, tenant_id, conversation_id, actor_membership_id NULLABLE,
                          act, from_value, to_value, at_version, detail jsonb, at)
                          append-only to the runtime role
conversation_handoffs    (id, tenant_id, conversation_id, from_membership_id,
                          to_membership_id, state, note, based_on_version,
                          based_on_assignee_membership_id, created_at, expires_at,
                          settled_at, settled_by_membership_id)
                          state ∈ pending|accepted|declined|cancelled|expired
                          UNIQUE (tenant_id, conversation_id) WHERE state = 'pending'
conversation_handoff_expiries(handoff_id, tenant_id, conversation_id, expires_at)
                          ids and times only; swept by worker-inbound without exposing note text
conversation_collaborators(id, tenant_id, conversation_id, membership_id,
                          added_by_membership_id, added_at, removed_at)
                          UNIQUE (tenant_id, conversation_id, membership_id)
                            WHERE removed_at IS NULL

messages                 (id, tenant_id, conversation_id, direction, kind, body jsonb,
                          author_membership_id NULLABLE, is_private bool,
                          provider_message_id NULLABLE, client_message_id NULLABLE,
                          created_at, seq bigint)
                          FK (tenant_id, conversation_id) → conversations (tenant_id, id)
                          UNIQUE (tenant_id, conversation_id, client_message_id)
                          UNIQUE (tenant_id, connection_scope_key, provider_message_id)
read_cursors             (tenant_id, conversation_id, membership_id, last_seen_seq, updated_at)
drafts                   (tenant_id, conversation_id, membership_id, body jsonb, updated_at)
attachments              (id, tenant_id, owner_kind, owner_id, storage_key, mime, bytes,
                          scan_state, is_private bool, created_at)
                          scan_state ∈ pending|clean|infected|failed
```

`seq` is a per-conversation monotonic sequence used for cursors and read state. `is_private` on both message and attachment is the structural guarantee behind COL-01/MEDIA-04.

Assignment, handoff acceptance and self-claim set `owner_state = human_active` and increment both the conversation fence and `owner_version`. A pending handoff does not move the assignee. Its stored expiry is consumed by `worker-inbound`; acceptance re-checks the recipient and the assignee premise inside the transaction. Participants record action and are never deleted; collaborators are removable invitations, so ending one stops future collaborator reach without erasing authorship.

## 6. Delivery

```
raw_events               (id, connection_id, received_at, headers jsonb, body bytea,
                          signature_ok bool, processed_at, quarantine_reason)
normalized_events        (id, tenant_id, raw_event_id, schema_version, type, dedupe_key,
                          payload jsonb, created_at)
                          UNIQUE (tenant_id, dedupe_key)
outbox_events            (id, tenant_id, aggregate, aggregate_id, type, payload jsonb,
                          created_at, published_at, confirm_id)
idempotency_records      (id, tenant_id NULL, principal_id, operation, idempotency_key,
                          request_hash, state, response_status, response_body,
                          created_at, expires_at)
                          state ∈ pending|completed
                          UNIQUE NULLS NOT DISTINCT
                          (tenant_id, principal_id, operation, idempotency_key)

send_commands            (id, tenant_id, conversation_id NULLABLE, campaign_id NULLABLE,
                          recipient_identity_id, connection_id, kind, payload jsonb,
                          command_status, owner_version_at_create, created_by, created_at)
                          command_status ∈ queued|dispatching|provider_accepted|rejected
                                          |retry_scheduled|skipped|cancelled|failed|outcome_unknown
delivery_attempts        (id, tenant_id, command_id, attempt_no, permit_id, started_at,
                          finished_at, outcome, provider_message_id, provider_error jsonb)
                          outcome ∈ accepted|definitely_rejected|outcome_unknown
                          UNIQUE (tenant_id, command_id, attempt_no)
delivery_receipts        (id, tenant_id, provider_message_id, state, provider_at, observed_at, raw jsonb)
                          state ∈ sent|delivered|read|failed
                          UNIQUE (tenant_id, provider_message_id, state, provider_at)
dispatch_permits         (id, tenant_id, connection_id, conversation_id NULLABLE,
                          fencing_token bigint, epoch int, issued_at, expires_at, consumed_at)
```

Command state and provider delivery state are deliberately in **different tables**. The message-level projection folding receipts is derived and recomputable (ADR-0006).

## 7. Templates and campaigns

```
templates                (id, tenant_id, connection_id, name, language, category,
                          components jsonb, provider_status, local_revision, last_sync_at)
                          UNIQUE (tenant_id, connection_id, name, language)
template_revisions       (id, tenant_id, template_id, revision, components jsonb, created_at)

campaigns                (id, tenant_id, name, objective, inbox_id, connection_id,
                          control_state, current_revision_id, created_by, created_at)
                          control_state ∈ draft|validating|ready|scheduled|running|pausing
                                         |paused|dispatch_completed|cancelling|cancelled|failed
campaign_revisions       (id, tenant_id, campaign_id, revision, template_revision_id,
                          variables jsonb, schedule jsonb, budget jsonb, content_hash, created_at)
campaign_approvals       (id, tenant_id, campaign_id, revision_id, approver_membership_id,
                          approved_at, revoked_at, revision_hash)
campaign_executions      (id, tenant_id, campaign_id, revision_id, state, launched_at,
                          scheduled_for, started_at, completed_at, stop_version)
                          UNIQUE (tenant_id, campaign_id)          -- exactly one execution
audience_snapshots       (id, tenant_id, campaign_id, revision_id, taken_at, schema_version,
                          source jsonb, counts jsonb)
campaign_recipients      (id, tenant_id, execution_id, contact_id, identity_id,
                          rendered_variables jsonb,
                          snapshot_eligibility jsonb, dispatch_eligibility jsonb,
                          state, command_id NULLABLE, last_error jsonb)
                          state ∈ planned|queued|in_flight|accepted|delivered|read
                                 |failed|skipped|cancelled|outcome_unknown
                          UNIQUE (tenant_id, execution_id, identity_id)
campaign_work_queue      (execution_id, tenant_id, available_at, stop_version, created_at)
                          PK (execution_id) -- contentless global due-work discovery
campaign_retry_runs      (id, tenant_id, campaign_id, execution_id,
                          requested_by_membership_id, recipient_count, requested_at)
campaign_retry_recipients(id, tenant_id, retry_run_id, recipient_id,
                          previous_command_id, replacement_command_id, previous_error, created_at)
                          UNIQUE (tenant_id, retry_run_id, recipient_id)
                          UNIQUE (tenant_id, replacement_command_id)
budget_reservations      (id, tenant_id, execution_id, recipient_id,
                          estimated_amount_minor numeric(20,6), reserved_amount_minor numeric(20,6),
                          committed_amount_minor numeric(20,6), reconciled_amount_minor numeric(20,6),
                          currency, state, created_at, released_at, reconciled_at)
                          state ∈ reserved|committed|released|held_unknown|reconciled
usage_events             (id, tenant_id, kind, quantity, amount_minor, currency,
                          estimated bool, reconciled_at, provider_ref)
price_cards              (id, provider, category, market, currency, amount_minor,
                          effective_from, effective_to, source_url, observed_at)
```

`campaign_executions` has `UNIQUE (tenant_id, campaign_id)` — this single constraint is what makes CMP-08 true under concurrent launches.

Each planned outbound message carries `campaign_stop_version`. A bulk claim joins it back to the recipient execution and succeeds only while recipient=`queued`, execution=`running`, and both stop versions match. The queue has no RLS because it contains no customer content and is the worker's tenant-discovery seam; every data-bearing read happens only after entering `withTenant`.

A manual retry never creates a second execution and never rewrites its evidence. The recipient's current `command_id` advances to a new fenced command while `campaign_retry_recipients` retains both command IDs and the prior error. Only `failed` recipients enter a run; accepted, delivered, read, skipped, cancelled and `outcome_unknown` rows remain untouched. A retry can re-reserve only a reservation currently marked `released`, so a ledger mismatch aborts the whole transaction before any replacement reaches the outbox.

## 8. Integrations, automation, SLA, audit, AI

```
integrations             (id, tenant_id, kind, config jsonb, credential_ref, state, health jsonb)
integration_mappings     (id, tenant_id, integration_id, model, mapping jsonb, version)
external_links           (tenant_id, integration_id, model, external_id, internal_kind, internal_id)
                          PK (tenant_id, integration_id, model, external_id)
integration_cursors      (tenant_id, integration_id, model, cursor jsonb, updated_at)
integration_conflicts    (id, tenant_id, integration_id, model, internal_id, external_id,
                          detected_at, diff jsonb, resolved_at, resolution jsonb)

webhook_subscriptions    (id, tenant_id, url, events text[], secret_ref, secret_rotated_at, state)
webhook_deliveries       (id, tenant_id, subscription_id, event_id, attempt_no, status,
                          response_code, created_at, next_retry_at)
                          UNIQUE (tenant_id, subscription_id, event_id, attempt_no)

automations              (id, tenant_id, name, state, current_version_id)
automation_versions      (id, tenant_id, automation_id, version, definition jsonb, published_at)
automation_runs          (id, tenant_id, automation_version_id, trigger_ref, dedupe_key,
                          state, hops, trace jsonb, started_at, finished_at)
                          UNIQUE (tenant_id, automation_version_id, dedupe_key)

business_hours           (id, tenant_id, team_id NULLABLE, timezone, schedule jsonb)
holidays                 (id, tenant_id, date, name)
sla_policies             (id, tenant_id, version, definition jsonb)
sla_clock_events         (id, tenant_id, conversation_id, episode_id, policy_version,
                          clock, event, at)                 -- events, never mutable elapsed counters
csat_responses           (id, tenant_id, conversation_id, score, comment, at)

audit_events             (id, tenant_id NULLABLE, actor_kind, actor_id, action,
                          resource_kind, resource_id, at, request_id, detail jsonb)

knowledge_sources        (id, tenant_id, kind, uri, acl jsonb, version, state, ingested_at)
knowledge_chunks         (id, tenant_id, source_id, chunk_index, text, embedding vector, acl jsonb)
ai_runs                  (id, tenant_id, conversation_id, kind, model, prompt_version,
                          owner_version_at_start, state, cost_minor, latency_ms, trace_ref)
tool_approvals           (id, tenant_id, ai_run_id, tool, arguments_hash, approver_membership_id,
                          approved_at, expires_at, consumed_at)
```

## 9. Indexing and partitioning notes

- Hot list query: `conversations (tenant_id, inbox_id, status, last_customer_message_at DESC, id)`.
- Timeline: `messages (tenant_id, conversation_id, seq)`.
- Queue projection: partial index on `conversations` where `assignee_membership_id IS NULL AND status='open'`.
- Recipient drill-down: `campaign_recipients (tenant_id, execution_id, state, id)`.
- Receipts: `delivery_receipts (tenant_id, provider_message_id)`.
- **Partitioning is deferred until measured.** If `messages`, `raw_events`, `normalized_events` or `campaign_recipients` are partitioned by time, remember that a unique constraint on a partitioned table **must include the partition key** — so global dedupe (e.g. `normalized_events.dedupe_key`) needs its own non-partitioned uniqueness structure. This is called out here because it is the classic way a dedupe guarantee silently disappears.

## 10. Migration policy

Expand → backfill → contract. Backfills are cancellable and throttled. Every migration is idempotent and reversible or explicitly documented as forward-only. Migrations run as a role distinct from the runtime role (ADR-0003).
