-- 0005_idempotency
-- Durable, transactionally stored results for retry-safe commands (API-05).
--
-- Bootstrap is pre-authentication, so its scope has no tenant or user yet.
-- NULLS NOT DISTINCT keeps NULL a real part of the uniqueness boundary rather
-- than allowing an unlimited number of pre-auth rows with the same key.

CREATE TABLE idempotency_records (
  tenant_id       uuid,
  principal_id    text NOT NULL,
  operation       text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  state           text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT idempotency_key_length_ck
    CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT idempotency_response_ck CHECK (
    (state = 'pending' AND response_status IS NULL AND response_body IS NULL)
    OR
    (state = 'completed' AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL)
  ),
  CONSTRAINT idempotency_scope_uq
    UNIQUE NULLS NOT DISTINCT (tenant_id, principal_id, operation, idempotency_key)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

REVOKE ALL ON idempotency_records FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO convo_app;

-- Tenant commands see only their own ledger. Pre-authentication installation
-- commands explicitly enable a transaction-local installation scope; a normal
-- tenant transaction cannot observe those rows. Missing context fails closed.
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  USING (
    tenant_id = app_current_tenant()
    OR (
      tenant_id IS NULL
      AND current_setting('convo.installation_scope', true) = 'bootstrap'
    )
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    OR (
      tenant_id IS NULL
      AND current_setting('convo.installation_scope', true) = 'bootstrap'
    )
  );
