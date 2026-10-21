-- Earlier profile lookups could exhaust their five attempts while Meta app
-- permissions were being configured. Give those unresolved senders a new
-- attempt after the lookup fix; no contact name is changed by this migration.
UPDATE contact_profile_queue
   SET attempts = 0,
       next_attempt_at = now(),
       lease_until = NULL,
       last_error_code = NULL
 WHERE attempts >= 5;
