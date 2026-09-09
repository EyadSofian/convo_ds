-- 0010_channels
-- The channel foundation: provider apps, tenant connections, versioned
-- credentials, the installation-wide asset registry, and the durable webhook
-- ingress journal.
--
-- Three decisions shape this file.
--
-- 1. **A secret never sits in an ordinary column.** An app secret belongs to the
--    installation and is read from configuration by reference, so rotating it is
--    an operations act and a database reader learns nothing. A tenant's access
--    token cannot live in configuration — it arrives from an OAuth grant — so it
--    is stored as AES-256-GCM ciphertext with its IV, tag and key version, and
--    the plaintext exists only inside the credential service.
--
-- 2. **The tenant is resolved from a verified asset, never from the caller.**
--    A webhook arrives with no session. `channel_asset_registry` is the one
--    installation-wide table that maps a provider asset to its owner, and its
--    RLS policy admits exactly the row whose fingerprint the ingress has already
--    verified — the same one-row carve-out invitations use, not a flag that
--    opens the table.
--
-- 3. **What we received and what was in it are different facts.** A receipt is
--    installation-level evidence that bytes arrived and whether their signature
--    held; it carries no payload. The payload lives in a tenant-scoped event row
--    and only for a delivery we could actually route. An asset nobody in this
--    installation has connected leaves a receipt and no content, which is both
--    the privacy-correct answer and the honest one.

-- ---------------------------------------------------------------------------
-- Provider apps — installation level, not tenant level.
--
-- In SaaS one Meta app serves every tenant; in a self-hosted installation the
-- operator registers their own. Either way the app is installation
-- configuration, so this table holds identifiers and a *reference* to the
-- secret, never the secret.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_apps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL CHECK (provider IN ('meta', 'web_chat', 'custom')),
  -- The provider's own identifier for the app. Public: it appears in redirect
  -- URLs and in the provider's console.
  external_app_id   text NOT NULL,
  -- The configuration key the app secret is read from, e.g. `META_APP`. The
  -- value is never stored. Uppercase and underscore only, so it cannot be
  -- turned into a path or an injection.
  secret_ref        text NOT NULL CHECK (secret_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- Fingerprint of the secret this row was created against. Rotating the
  -- configured value without updating the row is then a visible mismatch
  -- rather than a webhook that silently stops verifying.
  secret_fingerprint text NOT NULL CHECK (secret_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The GET challenge token, hashed. It authenticates nothing on a POST
  -- (ADR-0005) and is stored the same way every other credential is.
  verify_token_hash text NOT NULL CHECK (verify_token_hash ~ '^[0-9a-f]{64}$'),
  -- Pinned per adapter, per environment (ADR-0009). Never follow-the-latest.
  graph_version     text NOT NULL CHECK (graph_version ~ '^v[0-9]+\.[0-9]+$'),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  rotated_at        timestamptz,

  CONSTRAINT channel_apps_external_uq UNIQUE (provider, external_app_id)
);

-- Installation configuration, like `installations`: the runtime reads it and
-- never creates or deletes one.
GRANT SELECT ON channel_apps TO convo_app;

-- ---------------------------------------------------------------------------
-- Connections — one per provider asset, tenant-scoped.
--
-- "One asset, one connection" is enforced installation-wide by the registry
-- below; this table adds the per-tenant half: one live connection per asset
-- within a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_connections (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  app_id            uuid REFERENCES channel_apps (id),
  kind              text NOT NULL
                      CHECK (kind IN ('whatsapp', 'messenger', 'instagram', 'web_chat', 'custom')),
  -- The provider's identifier for the asset: a phone number id, a Page id, an
  -- Instagram professional account id, a widget installation id.
  external_asset_id text NOT NULL,
  display_name      text NOT NULL,
  -- Readiness is derived from evidence, never set by hand. `connected` is the
  -- absence of a reason not to be, and every reason has its own column below.
  status            text NOT NULL DEFAULT 'not_configured'
                      CHECK (status IN ('not_configured', 'authorization_needed', 'webhook_pending',
                                        'healthy', 'degraded', 'disconnected')),
  -- The capability matrix the adapter reported for the pinned version, frozen
  -- at connect time so a version bump is a visible diff (ADR-0009).
  capabilities      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Separate evidence, separately earned (CH-02). A non-empty token proves none
  -- of these.
  asset_verified_at        timestamptz,
  credential_verified_at   timestamptz,
  webhook_subscribed_at    timestamptz,
  first_inbound_at         timestamptz,
  first_outbound_at        timestamptz,
  last_error_code   text,
  last_error_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  disconnected_at   timestamptz,

  PRIMARY KEY (id),
  CONSTRAINT channel_connections_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_connections_disconnected_ck CHECK (
    (status = 'disconnected') = (disconnected_at IS NOT NULL)
  ),
  CONSTRAINT channel_connections_error_ck CHECK (
    (last_error_code IS NULL) = (last_error_at IS NULL)
  )
);

-- One live connection per asset inside a tenant. A disconnected one keeps its
-- history and stops reserving the asset, exactly as an archived team keeps its
-- history and stops reserving its name.
CREATE UNIQUE INDEX channel_connections_live_asset_uq
  ON channel_connections (tenant_id, kind, external_asset_id)
  WHERE disconnected_at IS NULL;

CREATE INDEX channel_connections_tenant_idx ON channel_connections (tenant_id, kind);

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_connections
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON channel_connections TO convo_app;

-- ---------------------------------------------------------------------------
-- Credentials — versioned, encrypted, and never returned.
--
-- Rotation appends a version rather than overwriting one, so a credential in
-- flight during a rotation can still be identified afterwards, and revoking a
-- version is a fact with a time rather than a row that vanished.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_credentials (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN ('access_token', 'refresh_token', 'signing_key')),
  version        integer NOT NULL CHECK (version > 0),
  -- AES-256-GCM. Three separate columns because a concatenated blob invites a
  -- parser, and a parser invites an off-by-one that decrypts the wrong bytes.
  ciphertext     bytea NOT NULL,
  iv             bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag       bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  -- Which configured key encrypted it, so a key rotation is auditable and an
  -- undecryptable row is diagnosable rather than mysterious.
  key_version    text NOT NULL CHECK (key_version ~ '^[a-z0-9_]{1,32}$'),
  -- Identifies the secret without revealing it: lets a re-authorization notice
  -- "this is the same token again" without ever comparing plaintext.
  fingerprint    text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,

  PRIMARY KEY (id),
  CONSTRAINT channel_credentials_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_credentials_connection_fk
    FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_credentials_version_uq UNIQUE (tenant_id, connection_id, purpose, version),
  CONSTRAINT channel_credentials_revoked_ck CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

-- Exactly one active credential per purpose per connection. Two active tokens
-- for one asset means a send picks one at random and a rotation cannot be
-- reasoned about.
CREATE UNIQUE INDEX channel_credentials_active_uq
  ON channel_credentials (tenant_id, connection_id, purpose)
  WHERE status = 'active';

ALTER TABLE channel_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_credentials
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: a revoked credential is evidence. Rotation supersedes, it does not
-- erase.
GRANT SELECT, INSERT, UPDATE ON channel_credentials TO convo_app;

-- ---------------------------------------------------------------------------
-- The installation-wide asset registry (CH-03).
--
-- A provider asset belongs to exactly one tenant across the whole installation.
-- Without this, two tenants could each "connect" the same WhatsApp number and
-- inbound messages would route by whichever row was found first.
--
-- The second tenant's attempt is refused by a unique violation, which the
-- service reports as a conflict **without naming the other tenant** — that a
-- number is already claimed here is not information the claimant is entitled to.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_asset_registry (
  -- sha256(provider || ':' || kind || ':' || external_asset_id). The ingress
  -- computes this from the verified payload and looks the row up by it, so the
  -- policy below can admit exactly one row without a tenant context.
  asset_fingerprint text PRIMARY KEY CHECK (asset_fingerprint ~ '^[0-9a-f]{64}$'),
  provider          text NOT NULL CHECK (provider IN ('meta', 'web_chat', 'custom')),
  kind              text NOT NULL
                      CHECK (kind IN ('whatsapp', 'messenger', 'instagram', 'web_chat', 'custom')),
  external_asset_id text NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL,
  claimed_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT channel_asset_registry_asset_uq UNIQUE (provider, kind, external_asset_id),
  CONSTRAINT channel_asset_registry_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
      REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE channel_asset_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_asset_registry FORCE ROW LEVEL SECURITY;

-- One row wide. `convo.asset_fingerprint` is transaction-local and is compared
-- against the primary key, so the ingress sees exactly the asset whose id it
-- has already verified against the provider's signature — and nothing else.
-- Writes always require the ordinary tenant context.
CREATE POLICY tenant_isolation ON channel_asset_registry
  USING (
    tenant_id = app_current_tenant()
    OR asset_fingerprint = nullif(current_setting('convo.asset_fingerprint', true), '')
  )
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, DELETE ON channel_asset_registry TO convo_app;

-- ---------------------------------------------------------------------------
-- Webhook receipts — installation level, no payload.
--
-- Evidence that bytes arrived, whether the signature held, and what we did with
-- them. Deliberately carries no message content: a delivery for an asset this
-- installation does not know must not leave customer data behind.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid REFERENCES channel_apps (id),
  -- The URL path parameter the delivery arrived on. Public, and not authority.
  route_key       text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  body_sha256     text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_bytes      integer NOT NULL CHECK (body_bytes >= 0),
  signature_valid boolean NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN (
                    'routed', 'unknown_asset', 'signature_invalid', 'unsupported', 'malformed'
                  )),
  -- Informational only: routing already happened, this records where it went.
  -- CASCADE, not SET NULL: a routed receipt names its tenant by construction,
  -- so orphaning it would violate the check below and block tenant deletion.
  tenant_id       uuid REFERENCES tenants (id) ON DELETE CASCADE,
  event_count     integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),

  -- A rejected delivery never names a tenant, because it was never routed.
  CONSTRAINT webhook_receipts_routed_ck CHECK (
    (outcome = 'routed') = (tenant_id IS NOT NULL)
  )
);

CREATE INDEX webhook_receipts_time_idx ON webhook_receipts (received_at DESC);
CREATE INDEX webhook_receipts_tenant_idx ON webhook_receipts (tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;

-- Installation-level ledger, append-only from the application's side.
GRANT SELECT, INSERT ON webhook_receipts TO convo_app;

-- ---------------------------------------------------------------------------
-- Channel events — the tenant-scoped raw journal, and the dedupe boundary.
--
-- Persisted before the ACK. `dedupe_key` is provider- and type-specific
-- (ADR-0005): the same message arriving twice, in two differently ordered
-- batches, produces one row and therefore one domain effect.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_events (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id     uuid NOT NULL,
  receipt_id        uuid NOT NULL REFERENCES webhook_receipts (id) ON DELETE CASCADE,
  -- Stable across redeliveries of the same fact. Unique per tenant, so one
  -- tenant's ids can never suppress another's.
  dedupe_key        text NOT NULL,
  event_type        text NOT NULL,
  -- The provider's own element, stored intact. An unsupported shape is kept
  -- rather than dropped (CH-01) so it can be rendered as a documented fallback
  -- and replayed once support exists.
  payload           jsonb NOT NULL,
  -- What the adapter made of it. Kept beside the raw form rather than instead
  -- of it: the raw is the evidence and the replay source, and this is the
  -- interpretation the projection was built from. Storing only one of the two
  -- means either losing the evidence or re-parsing later against a normalizer
  -- that may since have changed.
  normalized        jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version    integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'normalized', 'quarantined')),
  quarantine_reason text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,

  PRIMARY KEY (id),
  CONSTRAINT channel_events_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_events_dedupe_uq UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT channel_events_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
      REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_events_quarantine_ck CHECK (
    (status = 'quarantined') = (quarantine_reason IS NOT NULL)
  ),
  CONSTRAINT channel_events_processed_ck CHECK (
    (status = 'received') = (processed_at IS NULL)
  )
);

CREATE INDEX channel_events_pending_idx ON channel_events (tenant_id, received_at)
  WHERE status = 'received';

ALTER TABLE channel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON channel_events TO convo_app;

-- ---------------------------------------------------------------------------
-- The inbound work queue.
--
-- Written in the same transaction as the event it points at (DEL-07), so there
-- is no window in which an event exists with nothing scheduled to process it.
--
-- Installation-level and deliberately contentless: it carries an event id, a
-- tenant id and lease bookkeeping, and nothing a customer wrote. A worker has
-- to be able to ask "is there work anywhere" without holding a tenant context,
-- and the honest way to allow that is a table with nothing private in it —
-- rather than a carve-out on the table that does hold the messages.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_event_queue (
  event_id     uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- A lease, not a lock: a worker that dies leaves a row whose lease expires,
  -- and the row becomes available again without anybody unwedging it by hand.
  leased_by    text,
  lease_until  timestamptz,
  last_error   text,

  CONSTRAINT channel_event_queue_lease_ck CHECK ((leased_by IS NULL) = (lease_until IS NULL))
);

CREATE INDEX channel_event_queue_ready_idx
  ON channel_event_queue (tenant_id, enqueued_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_event_queue TO convo_app;

-- ---------------------------------------------------------------------------
-- Normalized inbound events.
--
-- What the rest of the product reads. Provider shapes stop here: everything
-- downstream sees one vocabulary, and an adapter is the only thing that knows
-- what a `messages[0].type` was.
--
-- `occurred_at` is the provider's timestamp; `observed_at` is ours. Both are
-- kept because they disagree, and folding them loses the ordering evidence
-- (ADR-0006).
-- ---------------------------------------------------------------------------
CREATE TABLE inbound_events (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id        uuid NOT NULL,
  event_id             uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN (
                         'message', 'delivery_status', 'read_status', 'reaction',
                         'identity_change', 'unsupported'
                       )),
  -- The provider's own id for the message, when it has one. Statuses reference
  -- the message they are about.
  provider_message_id  text,
  -- Opaque, provider-scoped, and never a phone number in a log: the sender's
  -- identity as the provider expressed it.
  peer_identity        text NOT NULL,
  asset_identity       text NOT NULL,
  content_type         text,
  text_body            text,
  attachments          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Anything the normalizer understood but the vocabulary above does not carry.
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at          timestamptz NOT NULL,
  observed_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id),
  CONSTRAINT inbound_events_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT inbound_events_event_fk
    FOREIGN KEY (tenant_id, event_id) REFERENCES channel_events (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT inbound_events_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
      REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT inbound_events_event_kind_ck CHECK (
    kind <> 'message' OR provider_message_id IS NOT NULL
  )
);

-- One normalized row per source event per kind: replaying a normalization is
-- idempotent rather than additive. `coalesce` rather than a plain unique
-- constraint because NULLs are distinct from each other in SQL, which would let
-- an event with no provider id normalize twice.
CREATE UNIQUE INDEX inbound_events_source_uq
  ON inbound_events (tenant_id, event_id, kind, coalesce(provider_message_id, ''));

CREATE INDEX inbound_events_conversation_idx
  ON inbound_events (tenant_id, connection_id, peer_identity, occurred_at DESC);

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON inbound_events TO convo_app;
