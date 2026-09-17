-- 0026_contact_field_email_phone
-- EMAIL and PHONE are business field types, not inferred contact identities.
-- Values keep the operator-entered representation while search_value carries a
-- normalized form produced by the domain layer.

ALTER TABLE custom_fields DROP CONSTRAINT custom_fields_type_check;
ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_type_check CHECK (
  type IN ('text','number','boolean','date','email','phone','single_select','multi_select')
);

CREATE OR REPLACE FUNCTION enforce_custom_field_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  field_target text;
  field_type text;
  field_options jsonb;
  field_state text;
BEGIN
  SELECT target, type, options, state
    INTO field_target, field_type, field_options, field_state
    FROM custom_fields WHERE id = NEW.field_id;
  IF field_target IS NULL OR field_target <> TG_ARGV[0] OR field_state <> 'active' THEN
    RAISE EXCEPTION 'custom field is unavailable for this target';
  END IF;
  IF (field_type = 'text' AND (jsonb_typeof(NEW.value_json) <> 'string'
                              OR length(trim(NEW.value_json #>> '{}')) NOT BETWEEN 1 AND 500))
     OR (field_type = 'email' AND (jsonb_typeof(NEW.value_json) <> 'string'
          OR length(NEW.value_json #>> '{}') NOT BETWEEN 3 AND 254
          OR NEW.value_json #>> '{}' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     OR (field_type = 'phone' AND (jsonb_typeof(NEW.value_json) <> 'string'
          OR NEW.value_json #>> '{}' !~ '^\+[1-9][0-9]{6,14}$'))
     OR (field_type = 'number' AND jsonb_typeof(NEW.value_json) <> 'number')
     OR (field_type = 'boolean' AND jsonb_typeof(NEW.value_json) <> 'boolean')
     OR (field_type = 'date' AND (jsonb_typeof(NEW.value_json) <> 'string'
          OR NEW.value_json #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$'
          OR to_char(to_date(NEW.value_json #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') <> NEW.value_json #>> '{}'))
     OR (field_type = 'single_select' AND (jsonb_typeof(NEW.value_json) <> 'string' OR NOT field_options @> jsonb_build_array(NEW.value_json #>> '{}')))
     OR (field_type = 'multi_select' AND (
          jsonb_typeof(NEW.value_json) <> 'array'
          OR jsonb_array_length(NEW.value_json) NOT BETWEEN 1 AND 20
          OR NOT field_options @> NEW.value_json
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.value_json) AS item(value)
                      WHERE jsonb_typeof(value) <> 'string')
          OR (SELECT count(*) <> count(DISTINCT value #>> '{}')
                FROM jsonb_array_elements(NEW.value_json) AS item(value)))) THEN
    RAISE EXCEPTION 'custom field value has the wrong type';
  END IF;
  RETURN NEW;
END;
$$;
