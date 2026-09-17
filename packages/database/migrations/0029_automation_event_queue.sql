-- Durable trigger intake and restart-safe scheduling for the automation engine.
CREATE TABLE automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK(length(type) BETWEEN 1 AND 80),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  payload_hash char(64) NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_events_idempotency_uq UNIQUE(tenant_id,type,idempotency_key),
  CONSTRAINT automation_events_tenant_id_uq UNIQUE(tenant_id,id)
);
CREATE INDEX automation_events_time_idx ON automation_events(tenant_id,occurred_at DESC);
ALTER TABLE automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_events USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
GRANT SELECT,INSERT ON automation_events TO convo_app;

-- Contentless discovery queue. A worker may discover company/id/due time, then
-- must enter that company's forced-RLS transaction to read the workflow.
CREATE TABLE automation_schedule_queue (
  tenant_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,automation_id),
  CONSTRAINT automation_schedule_queue_automation_fk FOREIGN KEY(tenant_id,automation_id) REFERENCES automations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX automation_schedule_queue_due_idx ON automation_schedule_queue(due_at,tenant_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON automation_schedule_queue TO convo_app;

-- PostgreSQL UNIQUE treats NULLs as distinct. For a recipient without a chosen
-- identity that would permit the same customer twice in one run.
ALTER TABLE automation_recipients DROP CONSTRAINT automation_recipients_identity_uq;
CREATE UNIQUE INDEX automation_recipients_identity_uq
  ON automation_recipients(tenant_id,automation_run_id,customer_id,identity_id) NULLS NOT DISTINCT;
