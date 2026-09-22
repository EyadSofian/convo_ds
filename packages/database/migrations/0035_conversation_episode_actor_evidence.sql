-- 0035_conversation_episode_actor_evidence
--
-- Preserve who produced the two operator-owned lifecycle facts that reports
-- use. Historical episodes deliberately remain NULL: inferring an actor from
-- a later assignment or a message is not evidence and would corrupt history.

ALTER TABLE conversation_episodes
  ADD COLUMN first_response_by_membership_id uuid,
  ADD COLUMN closed_by_membership_id uuid,
  ADD CONSTRAINT conversation_episodes_first_response_actor_fk
    FOREIGN KEY (tenant_id, first_response_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL,
  ADD CONSTRAINT conversation_episodes_closed_actor_fk
    FOREIGN KEY (tenant_id, closed_by_membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE SET NULL;

-- Draft removal is deliberately confined to the definition row and its empty
-- schedule entry. Execution evidence is never deleted through this grant.
GRANT DELETE ON automations TO convo_app;
