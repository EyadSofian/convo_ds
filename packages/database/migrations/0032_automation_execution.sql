-- Durable, ordered automation execution. The global queue contains identifiers
-- and timings only; workflow and customer data remain behind forced tenant RLS.

ALTER TABLE automation_recipients
  ADD COLUMN current_step integer NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT automation_recipients_tenant_id_uq UNIQUE (tenant_id,id);

ALTER TABLE automation_recipients
  DROP CONSTRAINT automation_recipients_status_check,
  ADD CONSTRAINT automation_recipients_status_check CHECK(status IN (
    'pending','queued','sent','delivered','read','completed','failed','skipped','cancelled','outcome_unknown'
  ));

CREATE TABLE automation_action_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  automation_run_id uuid NOT NULL,
  automation_recipient_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step_id text NOT NULL,
  step_type text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','waiting','completed','failed','skipped')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  outbound_message_id uuid,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_action_run_fk FOREIGN KEY (tenant_id,automation_run_id)
    REFERENCES automation_runs(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_action_recipient_fk FOREIGN KEY (tenant_id,automation_recipient_id)
    REFERENCES automation_recipients(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_action_message_fk FOREIGN KEY (tenant_id,outbound_message_id)
    REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT automation_action_order_uq UNIQUE (tenant_id,automation_recipient_id,step_index),
  CONSTRAINT automation_action_step_uq UNIQUE (tenant_id,automation_recipient_id,step_id)
);

CREATE INDEX automation_action_due_idx
  ON automation_action_executions(tenant_id,automation_run_id,available_at,automation_recipient_id,step_index)
  WHERE state IN ('pending','waiting');

ALTER TABLE automation_action_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_action_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_action_executions
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
GRANT SELECT,INSERT,UPDATE ON automation_action_executions TO convo_app;

CREATE TABLE automation_work_queue (
  automation_run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_work_queue_run_fk FOREIGN KEY (tenant_id,automation_run_id)
    REFERENCES automation_runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX automation_work_queue_due_idx
  ON automation_work_queue(available_at,tenant_id,automation_run_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON automation_work_queue TO convo_app;

-- Preserve runs materialized before this migration instead of stranding them.
INSERT INTO automation_work_queue(automation_run_id,tenant_id,available_at)
SELECT id,tenant_id,coalesce(scheduled_for,created_at)
  FROM automation_runs WHERE status='queued'
ON CONFLICT DO NOTHING;
