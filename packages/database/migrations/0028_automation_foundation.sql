-- 0028_automation_foundation
-- First-class, multi-step automations. Product templates are immutable starters;
-- tenant automations and every execution/recipient are durable, versioned evidence.

INSERT INTO permissions(key,description,delegable) VALUES
  ('automation.read','Read automation definitions, runs and recipient evidence',true),
  ('automation.create','Create and duplicate draft automations',true),
  ('automation.edit','Edit draft or paused automation workflows',true),
  ('automation.activate','Activate or resume an automation',false),
  ('automation.pause','Pause or archive an automation',false),
  ('automation.test','Run an automation against approved test recipients',false);

INSERT INTO builtin_role_grants(role_key,permission_key,scope_level) VALUES
  ('owner', 'automation.read', 'tenant'),
  ('owner', 'automation.create', 'tenant'),
  ('owner', 'automation.edit', 'tenant'),
  ('owner', 'automation.activate', 'tenant'),
  ('owner', 'automation.pause', 'tenant'),
  ('owner', 'automation.test', 'tenant'),
  ('admin', 'automation.read', 'tenant'),
  ('admin', 'automation.create', 'tenant'),
  ('admin', 'automation.edit', 'tenant'),
  ('admin', 'automation.activate', 'tenant'),
  ('admin', 'automation.pause', 'tenant'),
  ('admin', 'automation.test', 'tenant');

INSERT INTO role_permissions(tenant_id,role_id,permission_key,scope_level)
SELECT r.tenant_id,r.id,g.permission_key,g.scope_level
  FROM roles r JOIN builtin_role_grants g ON g.role_key=r.key
 WHERE r.is_builtin AND g.permission_key LIKE 'automation.%';

CREATE TABLE automation_templates (
  key text PRIMARY KEY,
  category text NOT NULL CHECK(category IN ('academic','sales','marketing','operations','custom')),
  name text NOT NULL,
  description text NOT NULL,
  preset jsonb NOT NULL CHECK(jsonb_typeof(preset)='object'),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  provider_template_id text NOT NULL,
  template_name text NOT NULL,
  language text NOT NULL,
  category text NOT NULL,
  status text NOT NULL CHECK(status IN ('approved','pending','paused','rejected','disabled')),
  components jsonb NOT NULL CHECK(jsonb_typeof(components)='array'),
  variables jsonb NOT NULL CHECK(jsonb_typeof(variables)='array'),
  last_synced_at timestamptz NOT NULL,
  CONSTRAINT whatsapp_templates_connection_fk FOREIGN KEY(tenant_id,connection_id) REFERENCES channel_connections(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT whatsapp_templates_provider_uq UNIQUE(tenant_id,connection_id,provider_template_id),
  CONSTRAINT whatsapp_templates_tenant_id_uq UNIQUE(tenant_id,id)
);
CREATE INDEX whatsapp_templates_search_idx ON whatsapp_templates(tenant_id,connection_id,lower(template_name),language,status);

CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  description text CHECK(description IS NULL OR length(description)<=1000),
  template_key text REFERENCES automation_templates(key),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','paused','archived')),
  workflow jsonb NOT NULL CHECK(jsonb_typeof(workflow)='object'),
  timezone text NOT NULL DEFAULT 'UTC' CHECK(length(timezone) BETWEEN 1 AND 100),
  next_run_at timestamptz,
  last_run_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by_membership_id uuid,
  updated_by_membership_id uuid,
  activated_by_membership_id uuid,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automations_tenant_id_uq UNIQUE(tenant_id,id),
  CONSTRAINT automations_name_uq UNIQUE(tenant_id,name),
  CONSTRAINT automations_creator_fk FOREIGN KEY(tenant_id,created_by_membership_id) REFERENCES memberships(tenant_id,id) ON DELETE SET NULL(created_by_membership_id),
  CONSTRAINT automations_updater_fk FOREIGN KEY(tenant_id,updated_by_membership_id) REFERENCES memberships(tenant_id,id) ON DELETE SET NULL(updated_by_membership_id),
  CONSTRAINT automations_activator_fk FOREIGN KEY(tenant_id,activated_by_membership_id) REFERENCES memberships(tenant_id,id) ON DELETE SET NULL(activated_by_membership_id),
  CONSTRAINT automations_activation_ck CHECK((state='active' AND activated_at IS NOT NULL) OR state<>'active')
);
CREATE INDEX automations_due_idx ON automations(next_run_at) WHERE state='active' AND next_run_at IS NOT NULL;

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','partially_completed','failed','cancelled')),
  mode text NOT NULL DEFAULT 'production' CHECK(mode IN ('production','test')),
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  trigger_type text NOT NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(trigger_payload)='object'),
  workflow_snapshot jsonb NOT NULL CHECK(jsonb_typeof(workflow_snapshot)='object'),
  audience_count integer NOT NULL DEFAULT 0 CHECK(audience_count>=0),
  queued_count integer NOT NULL DEFAULT 0 CHECK(queued_count>=0),
  sent_count integer NOT NULL DEFAULT 0 CHECK(sent_count>=0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK(delivered_count>=0),
  failed_count integer NOT NULL DEFAULT 0 CHECK(failed_count>=0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK(skipped_count>=0),
  error jsonb,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_runs_automation_fk FOREIGN KEY(tenant_id,automation_id) REFERENCES automations(tenant_id,id),
  CONSTRAINT automation_runs_tenant_id_uq UNIQUE(tenant_id,id),
  CONSTRAINT automation_runs_idempotency_uq UNIQUE(tenant_id,automation_id,idempotency_key)
);
CREATE INDEX automation_runs_history_idx ON automation_runs(tenant_id,automation_id,scheduled_for DESC);

CREATE TABLE automation_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  automation_run_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  identity_id uuid,
  template_id uuid,
  outbound_command_id uuid,
  provider_message_id text,
  status text NOT NULL CHECK(status IN ('pending','queued','sent','delivered','read','failed','skipped','cancelled','outcome_unknown')),
  variables_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(variables_snapshot)='object'),
  queued_at timestamptz, sent_at timestamptz, delivered_at timestamptz, failed_at timestamptz,
  error_code text, error_message text, retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  CONSTRAINT automation_recipients_run_fk FOREIGN KEY(tenant_id,automation_run_id) REFERENCES automation_runs(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_recipients_customer_fk FOREIGN KEY(tenant_id,customer_id) REFERENCES contacts(tenant_id,id),
  CONSTRAINT automation_recipients_identity_fk FOREIGN KEY(tenant_id,identity_id) REFERENCES contact_identities(tenant_id,id),
  CONSTRAINT automation_recipients_template_fk FOREIGN KEY(tenant_id,template_id) REFERENCES whatsapp_templates(tenant_id,id),
  CONSTRAINT automation_recipients_command_fk FOREIGN KEY(tenant_id,outbound_command_id) REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT automation_recipients_identity_uq UNIQUE(tenant_id,automation_run_id,customer_id,identity_id)
);
CREATE INDEX automation_recipients_status_idx ON automation_recipients(tenant_id,automation_run_id,status);

CREATE TABLE automation_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  automation_run_id uuid NOT NULL,
  step_id text,
  level text NOT NULL CHECK(level IN ('info','warning','error')),
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_logs_run_fk FOREIGN KEY(tenant_id,automation_run_id) REFERENCES automation_runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX automation_logs_run_idx ON automation_logs(tenant_id,automation_run_id,id);

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY; ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY; ALTER TABLE automations FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_recipients ENABLE ROW LEVEL SECURITY; ALTER TABLE automation_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE automation_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_templates USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON automations USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON automation_runs USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON automation_recipients USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON automation_logs USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
GRANT SELECT ON automation_templates TO convo_app;
GRANT SELECT,INSERT,UPDATE ON whatsapp_templates,automations,automation_runs,automation_recipients TO convo_app;
GRANT SELECT,INSERT ON automation_logs TO convo_app;
GRANT USAGE,SELECT ON SEQUENCE automation_logs_id_seq TO convo_app;

WITH presets(key,category,name,description,trigger,step) AS (VALUES
 ('course_enrollment_confirmation','academic','Course Enrollment Confirmation','Confirm a student enrollment.','student_enrolled','send_whatsapp_template'),
 ('course_start_reminder','academic','Course Start Reminder','Remind learners before a course starts.','course_starting','send_whatsapp_template'),
 ('class_reminder_24h','academic','Class Reminder — 24 Hours','Remind learners 24 hours before a session.','session_starting','send_whatsapp_template'),
 ('class_reminder_same_day','academic','Class Reminder — Same Day','Send a configurable same-day session reminder.','session_starting','send_whatsapp_template'),
 ('recurring_class_reminder','academic','Recurring Class Reminder','A configurable recurring course or cohort reminder.','schedule','send_whatsapp_template'),
 ('missed_class_follow_up','academic','Missed Class Follow-up','Follow up after a configured absence event.','attendance_updated','send_whatsapp_template'),
 ('course_completion_message','academic','Course Completion Message','Send a completion message.','course_completed','send_whatsapp_template'),
 ('next_level_follow_up','academic','Next-Level Follow-up','Follow up after completion with configurable conditions.','course_completed','send_whatsapp_template'),
 ('new_lead_welcome','sales','New Lead Welcome','Welcome a new lead.','customer_created','send_whatsapp_template'),
 ('lead_follow_up','sales','Lead Follow-up','Delay and follow up when conversion has not occurred.','customer_created','delay'),
 ('no_response_follow_up','sales','No-response Follow-up','Follow up after a configurable no-reply duration.','no_reply_for_duration','send_whatsapp_template'),
 ('inactive_lead_reengagement','sales','Inactive Lead Re-engagement','Re-engage a dynamic inactive audience.','schedule','send_whatsapp_template'),
 ('scheduled_audience_message','marketing','Scheduled Audience Message','Send to a dynamic audience on a schedule.','schedule','send_whatsapp_template'),
 ('label_based_whatsapp','marketing','Label-based WhatsApp Message','React to a configured label.','label_added','send_whatsapp_template'),
 ('event_workshop_reminder','marketing','Event / Workshop Reminder','Remind a selected audience about an event.','custom_event','send_whatsapp_template'),
 ('unassigned_conversation_alert','operations','Unassigned Conversation Alert','Alert operations when a conversation remains unassigned.','conversation_created','delay'),
 ('sla_escalation','operations','SLA Escalation','Escalate a configured SLA event.','custom_event','create_internal_notification'),
 ('business_hours_follow_up','operations','Business Hours Follow-up','Handle a conversation received outside configured hours.','conversation_created','condition'),
 ('blank','custom','Blank Automation','Build an automation from scratch.','manual','condition')
)
INSERT INTO automation_templates(key,category,name,description,preset)
SELECT key,category,name,description,jsonb_build_object(
 'version',1,'trigger',jsonb_build_object('type',trigger,'config','{}'::jsonb),
 'target',jsonb_build_object('type','matching_conditions','config','{}'::jsonb),
 'steps',jsonb_build_array(jsonb_build_object('id','step_1','type',step,'config','{}'::jsonb)),
 'safety',jsonb_build_object('approvalRequired',true,'duplicateWindowSeconds',86400)
) FROM presets;
