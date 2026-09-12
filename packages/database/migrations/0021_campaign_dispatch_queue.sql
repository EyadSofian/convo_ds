-- 0021_campaign_dispatch_queue
-- Contentless global discovery for due campaign work, plus the stop-version
-- fence carried by each outbound command.

ALTER TABLE outbound_messages
  ADD COLUMN campaign_stop_version bigint
    CHECK (campaign_stop_version IS NULL OR campaign_stop_version >= 0);

CREATE UNIQUE INDEX campaign_recipients_command_uq
  ON campaign_recipients(tenant_id,command_id) WHERE command_id IS NOT NULL;

CREATE TABLE campaign_work_queue (
  execution_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  available_at timestamptz NOT NULL,
  stop_version bigint NOT NULL CHECK (stop_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_work_queue_execution_fk FOREIGN KEY (tenant_id,execution_id)
    REFERENCES campaign_executions(tenant_id,id) ON DELETE CASCADE
);

CREATE INDEX campaign_work_queue_due_idx
  ON campaign_work_queue(available_at,tenant_id,execution_id);

-- Deliberately no RLS: workers discover a tenant from this contentless queue,
-- then enter `withTenant` before reading a campaign, recipient or message.
GRANT SELECT,INSERT,UPDATE,DELETE ON campaign_work_queue TO convo_app;
