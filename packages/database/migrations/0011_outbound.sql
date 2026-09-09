-- 0011_outbound
-- The outbound path: commands, the durable outbox, the attempt ledger, and the
-- two delivery state machines that fold independently.
--
-- The shape of this file is ADR-0006, and every column here exists because the
-- obvious simpler design is wrong in a specific way:
--
-- 1. **`outcome_unknown` is a state, not an error.** Between sending an HTTP
--    request to a provider and storing the answer there is a window in which we
--    genuinely cannot know whether a message went out. Collapsing that into
--    "failed" and retrying sends duplicate messages to real customers. It gets
--    its own command state, and nothing automatically resends it.
--
-- 2. **Command state and delivery state are different columns.** What we asked
--    the provider to do and what the provider later says happened are separate
--    facts that arrive out of order. One column would mean a late `delivered`
--    overwriting a `read`, or a `max(status)` that quietly invents an ordering
--    the provider never claimed.
--
-- 3. **An attempt row commits before the network call.** After a crash,
--    recovery finds an attempt with no recorded response and marks it
--    `outcome_unknown` — it does not re-send. An attempt table written *after*
--    the response cannot distinguish "never sent" from "sent, answer lost".

-- ---------------------------------------------------------------------------
-- Suppression: the consent check at permit time.
--
-- A recipient who has opted out stays opted out even when every other check
-- passes, and the check happens at dispatch rather than at draft: consent can be
-- withdrawn while a message sits in the queue (DEL-11).
-- ---------------------------------------------------------------------------
CREATE TABLE channel_suppressions (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind          text NOT NULL
                  CHECK (kind IN ('whatsapp', 'messenger', 'instagram', 'web_chat', 'custom')),
  -- The provider's identity for the recipient, as it appears on an event.
  peer_identity text NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('opt_out', 'complaint', 'bounce', 'manual')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,

  PRIMARY KEY (id),
  CONSTRAINT channel_suppressions_uq UNIQUE (tenant_id, kind, peer_identity),
  CONSTRAINT channel_suppressions_actor_fk
    FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, id) ON DELETE SET NULL
);

ALTER TABLE channel_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_suppressions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_suppressions
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: withdrawing consent is a fact with a time. Re-consenting is a new
-- record elsewhere, not the quiet removal of the evidence that it happened.
GRANT SELECT, INSERT ON channel_suppressions TO convo_app;

-- ---------------------------------------------------------------------------
-- Outbound commands.
--
-- One row per thing an operator asked us to send. It is created inside the same
-- transaction as its outbox entry, so a command can never exist with nothing
-- scheduled to dispatch it (DEL-07).
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_messages (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id       uuid NOT NULL,
  -- Who it is going to, in the provider's own vocabulary. Together with the
  -- connection this is the conversation key until the inbox model exists.
  peer_identity       text NOT NULL,
  author_membership   uuid,
  message_type        text NOT NULL,
  text_body           text,
  template_name       text,
  template_language   text,
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The caller's own id for this message. Two requests carrying the same one are
  -- the same message, however many times a flaky client retries.
  client_message_id   text NOT NULL,

  -- What *we* did. Nine states, and every one of them is reachable.
  command_state       text NOT NULL DEFAULT 'queued' CHECK (command_state IN (
                        'queued', 'dispatching', 'provider_accepted', 'rejected',
                        'retry_scheduled', 'skipped', 'cancelled', 'failed', 'outcome_unknown'
                      )),
  -- Why, when it is not simply "accepted". A typed reason from the permit or
  -- from the provider, never free text from a client.
  state_reason        text,

  -- What the *provider* later said happened. NULL until a receipt arrives, and
  -- folded independently of the column above: a `read` is not an advanced form
  -- of `dispatching`.
  delivery_state      text CHECK (delivery_state IN ('sent', 'delivered', 'read')),
  delivery_state_at   timestamptz,
  -- Anomalies are recorded, not smoothed over: a `failed` after a confirmed
  -- `delivered` does not erase the delivery (ADR-0006).
  delivery_anomaly    text,

  provider_message_id text,
  -- Incremented on every state change. A worker's update carries the version it
  -- read, so a stale worker cannot overwrite a newer decision (DEL-18).
  dispatch_version    integer NOT NULL DEFAULT 0 CHECK (dispatch_version >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,

  PRIMARY KEY (id),
  CONSTRAINT outbound_messages_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT outbound_messages_connection_fk
    FOREIGN KEY (tenant_id, connection_id)
      REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT outbound_messages_author_fk
    FOREIGN KEY (tenant_id, author_membership)
      REFERENCES memberships (tenant_id, id) ON DELETE SET NULL,
  -- One command per client id per company: the client's retry is the same
  -- message, not a second one.
  CONSTRAINT outbound_messages_client_uq UNIQUE (tenant_id, client_message_id),
  CONSTRAINT outbound_messages_accepted_ck CHECK (
    (command_state = 'provider_accepted') = (provider_message_id IS NOT NULL)
  ),
  CONSTRAINT outbound_messages_delivery_ck CHECK (
    (delivery_state IS NULL) = (delivery_state_at IS NULL)
  ),
  -- A delivery state without a provider id would be a receipt we could not have
  -- matched to anything.
  CONSTRAINT outbound_messages_delivery_needs_id_ck CHECK (
    delivery_state IS NULL OR provider_message_id IS NOT NULL
  ),
  CONSTRAINT outbound_messages_template_ck CHECK (
    (template_name IS NULL) = (template_language IS NULL)
  )
);

CREATE INDEX outbound_messages_conversation_idx
  ON outbound_messages (tenant_id, connection_id, peer_identity, created_at DESC);

CREATE INDEX outbound_messages_provider_idx
  ON outbound_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbound_messages
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON outbound_messages TO convo_app;

-- ---------------------------------------------------------------------------
-- The outbox.
--
-- Written in the same transaction as the command. Installation-level and
-- contentless for the same reason the inbound queue is: a dispatcher has to be
-- able to find work without a tenant context, and the honest way to allow that
-- is a table holding ids and timings rather than a carve-out on the table that
-- holds what customers wrote.
--
-- The partial unique index is the **serialized dispatch gate**: at most one
-- in-flight dispatch per conversation, so two workers cannot put two messages
-- on the wire out of order (DEL-18).
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  message_id    uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  -- Repeated here so the gate can be an index rather than a join.
  peer_identity text NOT NULL,
  -- Traffic class, so interactive replies and bulk campaigns can be drained by
  -- different pools sharing one provider rate limit (ADR-0007).
  traffic_class text NOT NULL DEFAULT 'interactive'
                  CHECK (traffic_class IN ('interactive', 'bulk')),
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  leased_by     text,
  lease_until   timestamptz,
  last_error    text,

  CONSTRAINT outbox_lease_ck CHECK ((leased_by IS NULL) = (lease_until IS NULL))
);

CREATE INDEX outbox_ready_idx ON outbox (tenant_id, traffic_class, available_at);

-- One conversation, one message on the wire at a time.
CREATE UNIQUE INDEX outbox_dispatch_gate_uq
  ON outbox (tenant_id, connection_id, peer_identity)
  WHERE lease_until IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON outbox TO convo_app;

-- ---------------------------------------------------------------------------
-- The attempt ledger.
--
-- One row per network attempt, committed **before** the request leaves. The
-- `permit` snapshot records what was true when we decided to send — the window,
-- the consent state, the template — so a later argument about why a message went
-- out has an answer that is not a guess.
-- ---------------------------------------------------------------------------
CREATE TABLE outbound_attempts (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  message_id          uuid NOT NULL,
  attempt_no          integer NOT NULL CHECK (attempt_no > 0),
  permit              jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  -- NULL means the attempt started and we never recorded an answer, which after
  -- a crash is exactly the evidence that makes it `outcome_unknown`.
  outcome             text CHECK (outcome IN ('accepted', 'definitely_rejected', 'outcome_unknown')),
  provider_message_id text,
  error_code          text,
  error_message       text,

  PRIMARY KEY (id),
  CONSTRAINT outbound_attempts_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT outbound_attempts_message_fk
    FOREIGN KEY (tenant_id, message_id)
      REFERENCES outbound_messages (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT outbound_attempts_no_uq UNIQUE (tenant_id, message_id, attempt_no),
  CONSTRAINT outbound_attempts_completed_ck CHECK (
    (outcome IS NULL) = (completed_at IS NULL)
  ),
  CONSTRAINT outbound_attempts_accepted_ck CHECK (
    outcome <> 'accepted' OR provider_message_id IS NOT NULL
  )
);

CREATE INDEX outbound_attempts_open_idx ON outbound_attempts (tenant_id, started_at)
  WHERE outcome IS NULL;

ALTER TABLE outbound_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbound_attempts
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: an attempt is the evidence that we did or may have contacted a
-- customer. It is never removed to tidy up a retry.
GRANT SELECT, INSERT, UPDATE ON outbound_attempts TO convo_app;
