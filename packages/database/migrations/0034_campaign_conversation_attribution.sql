-- 0034_campaign_conversation_attribution
--
-- A campaign send is evidence about outreach, not a reason to create an inbox
-- conversation. This table records that evidence durably and binds it to a
-- conversation only when a live conversation already exists, or when a later
-- customer inbound creates one. The campaign/execution/recipient identity can
-- never be rewritten after planning.

CREATE TABLE campaign_conversation_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  outbound_message_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  peer_identity text NOT NULL CHECK (length(peer_identity) BETWEEN 1 AND 256),
  sent_at timestamptz NOT NULL,
  conversation_id uuid,
  bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_conversation_attributions_campaign_fk
    FOREIGN KEY (tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_conversation_attributions_execution_fk
    FOREIGN KEY (tenant_id,execution_id) REFERENCES campaign_executions(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_conversation_attributions_recipient_fk
    FOREIGN KEY (tenant_id,recipient_id) REFERENCES campaign_recipients(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_conversation_attributions_outbound_fk
    FOREIGN KEY (tenant_id,outbound_message_id) REFERENCES outbound_messages(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_conversation_attributions_connection_fk
    FOREIGN KEY (tenant_id,connection_id) REFERENCES channel_connections(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT campaign_conversation_attributions_conversation_fk
    FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  CONSTRAINT campaign_conversation_attributions_recipient_uq UNIQUE (tenant_id,recipient_id),
  CONSTRAINT campaign_conversation_attributions_outbound_uq UNIQUE (tenant_id,outbound_message_id),
  CONSTRAINT campaign_conversation_attributions_binding_ck CHECK (
    (conversation_id IS NULL AND bound_at IS NULL) OR
    (conversation_id IS NOT NULL AND bound_at IS NOT NULL)
  )
);

CREATE INDEX campaign_conversation_attributions_campaign_idx
  ON campaign_conversation_attributions(tenant_id,campaign_id,conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX campaign_conversation_attributions_unbound_identity_idx
  ON campaign_conversation_attributions(tenant_id,connection_id,peer_identity,sent_at)
  WHERE conversation_id IS NULL;

-- Binding an as-yet-unbound record is the sole permitted mutation. It prevents
-- later reporting from silently changing which campaign a conversation came
-- from while still letting a customer reply bind the original send.
CREATE FUNCTION enforce_campaign_conversation_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.tenant_id,NEW.campaign_id,NEW.execution_id,NEW.recipient_id,
        NEW.outbound_message_id,NEW.connection_id,NEW.peer_identity,NEW.sent_at)
       IS DISTINCT FROM
       (OLD.tenant_id,OLD.campaign_id,OLD.execution_id,OLD.recipient_id,
        OLD.outbound_message_id,OLD.connection_id,OLD.peer_identity,OLD.sent_at) THEN
      RAISE EXCEPTION 'campaign conversation attribution identity is immutable';
    END IF;
    IF OLD.conversation_id IS NOT NULL OR NEW.conversation_id IS NULL OR NEW.bound_at IS NULL THEN
      RAISE EXCEPTION 'campaign conversation attribution may only be bound once';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_conversation_attributions_immutable
  BEFORE UPDATE ON campaign_conversation_attributions
  FOR EACH ROW EXECUTE FUNCTION enforce_campaign_conversation_attribution();

ALTER TABLE campaign_conversation_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_conversation_attributions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_conversation_attributions
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
GRANT SELECT,INSERT,UPDATE ON campaign_conversation_attributions TO convo_app;
