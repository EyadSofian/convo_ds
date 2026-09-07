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
installations            (id, deployment_mode, bootstrap_state, recovery_hold bool, dispatch_epoch int, created_at)
tenants                  (id, name, slug, status, placement, created_at, suspended_at, deletion_requested_at)
                          status ∈ provisioning|active|suspended|deletion_pending|deleted
tenant_entitlements      (tenant_id PK, seats, channels, active_contacts, storage_bytes,
                          campaign_recipients_month, api_rate, features jsonb, updated_at)
tenant_usage_counters    (tenant_id, period, metric, value)  -- reservation-safe
```

`installations` holds exactly one row. `recovery_hold` is mirrored here for visibility but is **authoritatively enforced outside the application snapshot** (ADR-0014).

## 2. Identity and access

```
users                    (id, email citext UNIQUE, password_hash, mfa_state, status, created_at)
user_sessions            (id, user_id, created_at, last_seen_at, ip_hash, ua_hash, revoked_at)
user_mfa_factors         (id, user_id, type, secret_ref, confirmed_at)
user_recovery_codes      (id, user_id, code_hash, used_at)

memberships              (id, tenant_id, user_id, role_id, status, created_at, revoked_at)
                          UNIQUE (tenant_id, user_id)
roles                    (id, tenant_id NULLABLE, key, name, is_builtin, version)
                          -- tenant_id NULL = built-in role shared by all tenants
role_permissions         (role_id, permission_key)          PK (role_id, permission_key)
permissions              (key PK, description, delegable bool)

teams                    (id, tenant_id, name)              UNIQUE (tenant_id, name)
team_members             (tenant_id, team_id, membership_id) PK (tenant_id, team_id, membership_id)
membership_scopes        (id, tenant_id, membership_id, scope_type, scope_id)
                          scope_type ∈ tenant|team|inbox
invitations              (id, tenant_id, email, role_id, token_hash, expires_at, accepted_at, revoked_at)
ownership_transfers      (id, tenant_id, from_membership_id, to_email, token_hash, expires_at, accepted_at)

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

## 6. Delivery

```
raw_events               (id, connection_id, received_at, headers jsonb, body bytea,
                          signature_ok bool, processed_at, quarantine_reason)
normalized_events        (id, tenant_id, raw_event_id, schema_version, type, dedupe_key,
                          payload jsonb, created_at)
                          UNIQUE (tenant_id, dedupe_key)
outbox_events            (id, tenant_id, aggregate, aggregate_id, type, payload jsonb,
                          created_at, published_at, confirm_id)
idempotency_records      (id, tenant_id, principal_id, operation, key, request_hash,
                          state, result jsonb, created_at, expires_at)
                          UNIQUE (tenant_id, principal_id, operation, key)

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
budget_reservations      (id, tenant_id, execution_id, recipient_id, amount_minor numeric(20,6),
                          currency, state, created_at, released_at)
                          state ∈ reserved|committed|released|held_unknown
usage_events             (id, tenant_id, kind, quantity, amount_minor, currency,
                          estimated bool, reconciled_at, provider_ref)
price_cards              (id, provider, category, market, currency, amount_minor,
                          effective_from, effective_to, source_url, observed_at)
```

`campaign_executions` has `UNIQUE (tenant_id, campaign_id)` — this single constraint is what makes CMP-08 true under concurrent launches.

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
