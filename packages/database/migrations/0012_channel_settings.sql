-- 0012_channel_settings
-- Per-connection configuration for the channels we own.
--
-- The Meta channels need none of this: their identity, their allowed callers
-- and their rate limits all belong to the provider. Website Chat and the Custom
-- Channel API have no provider, so the things a provider would otherwise
-- enforce have to be declared per connection and enforced by us.
--
-- One `jsonb` column rather than four typed ones because the contents differ by
-- channel kind — an origin allowlist means nothing to a Custom Channel, and a
-- declared type list means nothing to a widget. Typed columns would be null for
-- every kind that does not use them, and a reader would have to know which
-- nulls are meaningful.
--
-- What it holds today:
--
--   web_chat  { "origins": ["https://school.example"], "rate_per_minute": 120 }
--   custom    { "declared_types": ["text"], "rate_per_minute": 600 }
--
-- Nothing secret goes in here. The signing key for these channels is a
-- `signing_key` credential in `channel_credentials`, encrypted like every other.

ALTER TABLE channel_connections
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- An object, never an array or a scalar: every reader indexes it by key, and a
-- non-object would make each of them defend against a shape the column should
-- not be able to hold.
ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_settings_ck
  CHECK (jsonb_typeof(settings) = 'object');
