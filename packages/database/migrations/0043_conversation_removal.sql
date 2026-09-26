-- Removing an archived conversation from the workspace.
--
-- The conversation, its messages and its audit stay: they are evidence, and
-- the append-only tables around them never lose a row. What changes is that a
-- removed conversation no longer appears anywhere an operator works — not in
-- the archive, not in search, not by id. Only an archived conversation can be
-- removed, and the removal records who did it and when.
ALTER TABLE conversations
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_membership_id uuid,
  ADD CONSTRAINT conversations_deleted_archived_ck
    CHECK (deleted_at IS NULL OR status = 'archived');
