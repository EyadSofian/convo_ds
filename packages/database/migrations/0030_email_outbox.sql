-- 0030_email_outbox
-- The durable email outbox.
--
-- Until this migration, an invitation or a recovery token was handed to a
-- delivery port inside the request that created it. That is wrong in two ways
-- and both of them matter in production:
--
-- 1. **A third-party HTTP call is not durable business state.** If the provider
--    is slow the request is slow; if the provider is down the request fails
--    *after* the invitation has already been committed, so the operator is told
--    the invite failed while a live invitation exists. Worse for recovery: the
--    endpoint must answer identically for a known and an unknown address, and a
--    provider error that only ever happens for real accounts is an
--    account-existence oracle.
--
-- 2. **A retry needs somewhere to live.** An in-process retry loop dies with the
--    process. The queue has to be a table, claimed under a lease, exactly like
--    the outbound message queue it sits beside (ADR-0005, ADR-0006).
--
-- So the writing transaction commits a row here and returns. A worker claims it,
-- calls the provider, and records what happened. The API never talks to Resend.
--
-- **Scope.** This is installation infrastructure, not tenant data, and it is
-- deliberately a global table with no row level security — the same choice
-- `user_sessions`, `auth_rate_limits` and `password_recovery_challenges` make in
-- 0006, and for the same reason: password recovery has no tenant context at all
-- (the person is not signed in and may hold memberships in several companies),
-- so a tenant predicate here could only ever be NULL and deny every recovery
-- write. Isolation is instead structural: no tenant-scoped API reads this table,
-- there is no controller over it, and the only reader is the worker that drains
-- it. `tenant_id` is recorded for invitations so an operator can attribute a
-- delivery, and is NULL for recovery.
--
-- **The token at rest.** `payload` carries the one-time token, because the
-- worker has to be able to render the link and the token is only knowable once.
-- It is scrubbed to `'{}'::jsonb` the instant the row reaches a terminal state,
-- so the exposure window is the queue latency rather than the row's lifetime.
-- The compensating controls are the ones the token already has: one hour to
-- live, single use, and every session revoked when it is spent.

CREATE TABLE email_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The company an invitation belongs to. NULL for password recovery, which
  -- belongs to a person rather than to a company.
  tenant_id           uuid REFERENCES tenants (id) ON DELETE CASCADE,

  kind                text NOT NULL CHECK (kind IN ('invitation', 'password_recovery')),

  -- One row per business fact. Re-inviting the same person issues a new token
  -- and therefore a new key; a retried HTTP request carrying the same key is
  -- the same email, not a second one.
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),

  recipient_email     citext NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 254),
  -- Which language the worker renders in. Arabic is the product default.
  locale              text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),

  -- Everything the renderer needs, including the token. Scrubbed on terminal.
  payload             jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_scrubbed_at timestamptz,

  state               text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'sent', 'failed')),

  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- Beyond this the row is `failed` and stops costing anything. It is a column
  -- rather than a constant so an operator can lift it for one stuck delivery
  -- without a deploy.
  max_attempts        integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 50),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),

  -- The claim. Same shape as the outbound outbox: a lease, not a status flag,
  -- so a worker that dies mid-send releases its work by expiring rather than by
  -- remembering to clean up.
  lease_until         timestamptz,
  leased_by           text,

  provider            text,
  provider_message_id text,

  last_error_code     text,
  last_error_message  text,
  last_error_at       timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  failed_at           timestamptz,

  CONSTRAINT email_deliveries_idempotency_uq UNIQUE (kind, idempotency_key),

  -- A terminal state carries its evidence. `sent` without a provider message id
  -- is a claim nobody can check.
  CONSTRAINT email_deliveries_terminal_ck CHECK (
    (state = 'pending')
    OR (state = 'sent' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL)
    OR (state = 'failed' AND failed_at IS NOT NULL AND last_error_code IS NOT NULL)
  ),
  -- A terminal row holds no token.
  CONSTRAINT email_deliveries_scrub_ck CHECK (
    state = 'pending' OR payload_scrubbed_at IS NOT NULL
  )
);

-- The worker's claim query, and nothing else. Partial so the index stays the
-- size of the backlog rather than the size of the history.
CREATE INDEX email_deliveries_claim_idx
  ON email_deliveries (next_attempt_at, id)
  WHERE state = 'pending';

-- "How far behind is email, and what is failing" — the two questions an
-- operator asks. Both answered without scanning the sent history.
CREATE INDEX email_deliveries_failed_idx
  ON email_deliveries (failed_at DESC)
  WHERE state = 'failed';

CREATE INDEX email_deliveries_tenant_idx
  ON email_deliveries (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_deliveries TO convo_app;
