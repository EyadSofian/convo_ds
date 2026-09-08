-- 0004_installation_mode
-- Enforces the single-company contract of a self-hosted installation in the
-- database itself (MODE-04).
--
-- The application refuses to create a second company, the provisioning API
-- refuses it, and the UI never offers it -- but "by any path" in the acceptance
-- criterion includes a support script, a replayed job and a future endpoint
-- nobody has written yet. Only a constraint that sits under all of them can
-- honour that, so the claim is made here.

ALTER TABLE installations
  ADD COLUMN single_tenant_id uuid;

COMMENT ON COLUMN installations.single_tenant_id IS
  'The one company a self_hosted_single installation may hold. NULL in saas mode.';

-- The runtime role may create the singleton row at boot. It cannot create a
-- second one: installations_singleton_uq allows exactly one row to exist, ever.
GRANT INSERT ON installations TO convo_app;

CREATE FUNCTION enforce_installation_tenancy() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  mode    text;
  claimed uuid;
BEGIN
  -- FOR UPDATE serialises concurrent first-company inserts on the singleton
  -- row, so two transactions cannot both observe an unclaimed installation.
  SELECT deployment_mode, single_tenant_id
    INTO mode, claimed
    FROM installations
   WHERE singleton IS TRUE
     FOR UPDATE;

  IF mode IS NULL THEN
    RAISE EXCEPTION 'convo: no installation row; boot configuration has not been applied'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF mode = 'self_hosted_single' THEN
    IF claimed IS NULL THEN
      UPDATE installations SET single_tenant_id = NEW.id WHERE singleton IS TRUE;
    ELSIF claimed <> NEW.id THEN
      RAISE EXCEPTION
        'convo: this single-company installation already holds company %', claimed
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_installation_tenancy
  BEFORE INSERT ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_installation_tenancy();
