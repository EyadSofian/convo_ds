-- 0013_broker_relay
-- The durable relay between PostgreSQL and the broker, and the dead letters it
-- produces.
--
-- ADR-0004 makes the broker a transport, not a source of truth: a message is
-- written to PostgreSQL in the same transaction as the effect that caused it,
-- and only then published. That ordering is what makes the system survive a
-- broker outage — nothing is lost, publishing simply falls behind.
--
-- The consequence is that a publish may happen twice: the broker can confirm a
-- message and the process can die before recording the confirmation. Every
-- consumer is therefore idempotent by construction, and `broker_deliveries` is
-- where that is enforced rather than hoped for.

-- ---------------------------------------------------------------------------
-- The relay.
--
-- Installation level and deliberately small: a topic, a reference, and enough
-- bookkeeping to publish it exactly-ish once. The *content* stays in the
-- tenant-scoped tables it came from, so this table is safe to read without a
-- tenant context and there is no second copy of a customer's message to keep in
-- step (ADR-0007: queue messages carry small references).
-- ---------------------------------------------------------------------------
CREATE TABLE broker_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic          text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9._-]{2,63}$'),
  -- Ids and enough shape to route on. Never a message body.
  envelope       jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  available_at   timestamptz NOT NULL DEFAULT now(),
  -- Set only after the broker has *confirmed* the publish. A row with a claim
  -- and no confirmation is a publish whose outcome we do not know, and it is
  -- retried, because a duplicate is survivable and a lost event is not.
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  leased_by      text,
  lease_until    timestamptz,
  last_error     text,

  CONSTRAINT broker_outbox_lease_ck CHECK ((leased_by IS NULL) = (lease_until IS NULL)),
  CONSTRAINT broker_outbox_envelope_ck CHECK (jsonb_typeof(envelope) = 'object')
);

CREATE INDEX broker_outbox_ready_idx ON broker_outbox (available_at)
  WHERE published_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON broker_outbox TO convo_app;

-- ---------------------------------------------------------------------------
-- Consumer idempotency.
--
-- A consumer records that it handled an envelope *in the same transaction as
-- the handling*. A redelivery then finds the row and does nothing, which is
-- what makes at-least-once delivery safe to build on. Without this the relay's
-- honest duplicate becomes a duplicated domain effect.
-- ---------------------------------------------------------------------------
CREATE TABLE broker_deliveries (
  envelope_id  uuid NOT NULL,
  consumer     text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9._-]{2,63}$'),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),

  PRIMARY KEY (envelope_id, consumer)
);

CREATE INDEX broker_deliveries_age_idx ON broker_deliveries (processed_at);

GRANT SELECT, INSERT, UPDATE ON broker_deliveries TO convo_app;

-- ---------------------------------------------------------------------------
-- Dead letters.
--
-- A poison message is quarantined here rather than retried forever or dropped.
-- Both of those are worse: the first stops the queue moving, the second loses
-- an event with no record that it existed. A dead letter keeps the envelope,
-- the reason and the attempt count, and can be replayed by an operator — which
-- is an audited act, so `replayed_at` and `replayed_by` are columns rather than
-- a log line.
-- ---------------------------------------------------------------------------
CREATE TABLE broker_dead_letters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic         text NOT NULL,
  envelope      jsonb NOT NULL,
  reason        text NOT NULL,
  attempts      integer NOT NULL CHECK (attempts >= 1),
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  replayed_at   timestamptz,
  replayed_by   uuid,

  CONSTRAINT broker_dead_letters_replay_ck CHECK ((replayed_at IS NULL) = (replayed_by IS NULL))
);

CREATE INDEX broker_dead_letters_open_idx ON broker_dead_letters (tenant_id, quarantined_at DESC)
  WHERE replayed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON broker_dead_letters TO convo_app;
