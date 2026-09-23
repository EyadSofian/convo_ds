-- Preserve what the operator actually sent, independently of later edits to the
-- provider's template catalogue. Values are customer-facing message evidence;
-- secrets and provider credentials are never stored here.
ALTER TABLE outbound_messages
  ADD COLUMN template_provider_id text,
  ADD COLUMN template_components jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN template_preview text,
  ADD CONSTRAINT outbound_template_components_array_ck
    CHECK (jsonb_typeof(template_components) = 'array'),
  ADD CONSTRAINT outbound_template_evidence_ck
    CHECK (template_name IS NOT NULL OR (template_provider_id IS NULL AND template_preview IS NULL AND template_components = '[]'::jsonb));
