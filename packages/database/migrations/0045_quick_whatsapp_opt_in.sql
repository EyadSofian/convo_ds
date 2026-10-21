-- Preserve the operator's evidence reference for a business-initiated send.
-- This is not inferred consent; the sender must identify an external record.
ALTER TABLE outbound_messages ADD COLUMN opt_in_proof_ref text;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_opt_in_proof_ref_len
  CHECK (opt_in_proof_ref IS NULL OR length(opt_in_proof_ref) BETWEEN 3 AND 500);
