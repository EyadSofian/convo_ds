-- Existing templates remain available until an administrator restricts them.
ALTER TABLE whatsapp_templates
  ADD COLUMN visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','teams')),
  ADD COLUMN access_version integer NOT NULL DEFAULT 1 CHECK (access_version > 0);
CREATE TABLE whatsapp_template_teams (
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  team_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,template_id,team_id),
  FOREIGN KEY (tenant_id,template_id) REFERENCES whatsapp_templates(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,team_id) REFERENCES teams(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_template_teams_team_idx ON whatsapp_template_teams(tenant_id,team_id,template_id);
ALTER TABLE whatsapp_template_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_template_teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_template_teams
 USING(tenant_id=app_current_tenant()) WITH CHECK(tenant_id=app_current_tenant());
GRANT SELECT,INSERT,DELETE ON whatsapp_template_teams TO convo_app;
ALTER TABLE admin_audit_events DROP CONSTRAINT admin_audit_events_subject_type_check;
ALTER TABLE admin_audit_events ADD CONSTRAINT admin_audit_events_subject_type_check
 CHECK (subject_type IN ('membership','role','team','invitation','ownership','whatsapp_template'));
