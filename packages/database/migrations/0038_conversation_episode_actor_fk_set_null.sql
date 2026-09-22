-- 0038_conversation_episode_actor_fk_set_null
-- A membership deletion clears only the optional actor reference. The tenant
-- component of each composite FK remains non-null and tenant-scoped.

ALTER TABLE conversation_episodes
  DROP CONSTRAINT conversation_episodes_first_response_actor_fk,
  DROP CONSTRAINT conversation_episodes_closed_actor_fk;

ALTER TABLE conversation_episodes
  ADD CONSTRAINT conversation_episodes_first_response_actor_fk
    FOREIGN KEY (tenant_id, first_response_by_membership_id)
    REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (first_response_by_membership_id),
  ADD CONSTRAINT conversation_episodes_closed_actor_fk
    FOREIGN KEY (tenant_id, closed_by_membership_id)
    REFERENCES memberships (tenant_id, id)
    ON DELETE SET NULL (closed_by_membership_id);
