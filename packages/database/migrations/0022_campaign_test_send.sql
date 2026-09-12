-- 0022_campaign_test_send
-- An explicit, revocable allowlist for provider test recipients, plus immutable
-- evidence that a particular campaign revision queued a particular test send.

ALTER TABLE contact_identities
  ADD CONSTRAINT contact_identities_scope_identity_uq UNIQUE (tenant_id,scope_id,id);

ALTER TABLE campaign_revisions
  ADD CONSTRAINT campaign_revisions_campaign_identity_uq UNIQUE (tenant_id,campaign_id,id);

CREATE TABLE channel_test_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  authorized_by_membership_id uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_membership_id uuid,
  revoked_at timestamptz,
  CONSTRAINT channel_test_recipients_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT channel_test_recipients_scope_fk
    FOREIGN KEY (tenant_id,connection_id,identity_id)
    REFERENCES contact_identities(tenant_id,scope_id,id),
  CONSTRAINT channel_test_recipients_authorizer_fk
    FOREIGN KEY (tenant_id,authorized_by_membership_id)
    REFERENCES memberships(tenant_id,id),
  CONSTRAINT channel_test_recipients_revoker_fk
    FOREIGN KEY (tenant_id,revoked_by_membership_id)
    REFERENCES memberships(tenant_id,id),
  CONSTRAINT channel_test_recipients_revocation_ck CHECK (
    (revoked_at IS NULL) = (revoked_by_membership_id IS NULL)
    AND (revoked_at IS NULL OR revoked_at >= authorized_at)
  )
);

CREATE UNIQUE INDEX channel_test_recipients_live_uq
  ON channel_test_recipients(tenant_id,connection_id,identity_id)
  WHERE revoked_at IS NULL;

CREATE TABLE campaign_test_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  message_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_test_sends_tenant_id_uq UNIQUE (tenant_id,id),
  CONSTRAINT campaign_test_sends_message_uq UNIQUE (tenant_id,message_id),
  CONSTRAINT campaign_test_sends_revision_fk
    FOREIGN KEY (tenant_id,campaign_id,revision_id)
    REFERENCES campaign_revisions(tenant_id,campaign_id,id),
  CONSTRAINT campaign_test_sends_authorization_fk
    FOREIGN KEY (tenant_id,authorization_id)
    REFERENCES channel_test_recipients(tenant_id,id),
  CONSTRAINT campaign_test_sends_message_fk
    FOREIGN KEY (tenant_id,message_id)
    REFERENCES outbound_messages(tenant_id,id),
  CONSTRAINT campaign_test_sends_requester_fk
    FOREIGN KEY (tenant_id,requested_by_membership_id)
    REFERENCES memberships(tenant_id,id)
);

CREATE FUNCTION protect_test_recipient_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.connection_id,NEW.identity_id,NEW.label,
      NEW.authorized_by_membership_id,NEW.authorized_at)
     IS DISTINCT FROM
     (OLD.tenant_id,OLD.connection_id,OLD.identity_id,OLD.label,
      OLD.authorized_by_membership_id,OLD.authorized_at)
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'test recipient authorization history is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER channel_test_recipients_append_only
  BEFORE UPDATE ON channel_test_recipients
  FOR EACH ROW EXECUTE FUNCTION protect_test_recipient_authorization();

ALTER TABLE channel_test_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_test_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_test_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_test_sends FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_test_recipients
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
CREATE POLICY tenant_isolation ON campaign_test_sends
  USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());

GRANT SELECT,INSERT,UPDATE ON channel_test_recipients TO convo_app;
GRANT SELECT,INSERT ON campaign_test_sends TO convo_app;

ALTER TABLE campaign_audit DROP CONSTRAINT campaign_audit_act_check;
ALTER TABLE campaign_audit ADD CONSTRAINT campaign_audit_act_check CHECK (
  act IN ('created','revised','validated','approved','approval_revoked','launched','state_changed','cloned','test_sent')
);
