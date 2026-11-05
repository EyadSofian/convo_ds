-- Recover accepted broadcast messages through the normal conversation and
-- routing services. Only identifiers are visible to the worker discovery query.
CREATE TABLE campaign_inbox_repairs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbound_message_id uuid PRIMARY KEY,
  FOREIGN KEY (tenant_id,outbound_message_id)
    REFERENCES outbound_messages(tenant_id,id) ON DELETE CASCADE
);
GRANT SELECT,UPDATE,DELETE ON campaign_inbox_repairs TO convo_app;

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE company record;
BEGIN
  FOR company IN SELECT id FROM tenants LOOP
    PERFORM set_config('convo.tenant_id',company.id::text,true);
    INSERT INTO campaign_inbox_repairs (tenant_id,outbound_message_id)
    SELECT outreach.tenant_id,outreach.outbound_message_id
      FROM campaign_conversation_attributions outreach
      JOIN outbound_messages message ON message.id=outreach.outbound_message_id
      JOIN channel_connections connection ON connection.id=outreach.connection_id
      LEFT JOIN conversations bound ON bound.id=outreach.conversation_id
     WHERE message.command_state='provider_accepted' AND connection.disconnected_at IS NULL
       AND (outreach.conversation_id IS NULL OR bound.status <> 'archived')
       AND (bound.id IS NOT NULL OR outreach.sent_at >= coalesce((
         SELECT max(previous.archived_at) FROM conversations previous
          WHERE previous.connection_id=outreach.connection_id AND previous.peer_identity=outreach.peer_identity
            AND previous.status='archived'
       ),'-infinity'::timestamptz))
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('convo.tenant_id','',true);
END $$;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
