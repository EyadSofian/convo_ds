-- 0024_campaign_failed_retry
-- Immutable evidence for an operator-requested retry of terminal failed
-- recipients. A retry reuses the execution and recipient ledger; this table
-- preserves the old and replacement commands so updating the current pointer
-- cannot erase history.

CREATE TABLE campaign_retry_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  recipient_count integer NOT NULL CHECK (recipient_count > 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_retry_runs_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaign_retry_runs_campaign_fk FOREIGN KEY (tenant_id,campaign_id)
    REFERENCES campaigns(tenant_id,id),
  CONSTRAINT campaign_retry_runs_execution_fk FOREIGN KEY (tenant_id,execution_id)
    REFERENCES campaign_executions(tenant_id,id),
  CONSTRAINT campaign_retry_runs_requester_fk FOREIGN KEY (tenant_id,requested_by_membership_id)
    REFERENCES memberships(tenant_id,id)
);

CREATE TABLE campaign_retry_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  retry_run_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  previous_command_id uuid NOT NULL,
  replacement_command_id uuid NOT NULL,
  previous_error jsonb NOT NULL CHECK (jsonb_typeof(previous_error) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_retry_recipients_run_fk FOREIGN KEY (tenant_id,retry_run_id)
    REFERENCES campaign_retry_runs(tenant_id,id),
  CONSTRAINT campaign_retry_recipients_recipient_fk FOREIGN KEY (tenant_id,recipient_id)
    REFERENCES campaign_recipients(tenant_id,id),
  CONSTRAINT campaign_retry_recipients_previous_command_fk FOREIGN KEY (tenant_id,previous_command_id)
    REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT campaign_retry_recipients_replacement_command_fk FOREIGN KEY (tenant_id,replacement_command_id)
    REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT campaign_retry_recipients_once_uq UNIQUE (tenant_id,retry_run_id,recipient_id),
  CONSTRAINT campaign_retry_recipients_command_uq UNIQUE (tenant_id,replacement_command_id),
  CONSTRAINT campaign_retry_recipients_distinct_command_ck CHECK (previous_command_id <> replacement_command_id)
);

ALTER TABLE campaign_retry_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_retry_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_retry_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_retry_recipients FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON campaign_retry_runs
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_retry_recipients
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT ON campaign_retry_runs,campaign_retry_recipients TO convo_app;

ALTER TABLE campaign_audit DROP CONSTRAINT campaign_audit_act_check;
ALTER TABLE campaign_audit ADD CONSTRAINT campaign_audit_act_check CHECK (
  act IN ('created','revised','validated','approved','approval_revoked','launched','state_changed','cloned','test_sent','retried')
);
