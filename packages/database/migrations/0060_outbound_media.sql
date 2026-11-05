CREATE TABLE outbound_message_media (
  tenant_id uuid NOT NULL,
  message_id uuid PRIMARY KEY,
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 180),
  mime_type text NOT NULL,
  is_voice boolean NOT NULL,
  FOREIGN KEY (tenant_id,message_id) REFERENCES outbound_messages(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE outbound_message_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_message_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_message_media
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
GRANT SELECT,INSERT ON outbound_message_media TO convo_app;
