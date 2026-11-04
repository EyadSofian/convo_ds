ALTER TABLE campaign_leads
  DROP CONSTRAINT campaign_leads_course_name_check,
  ADD CONSTRAINT campaign_leads_course_name_check
    CHECK (course_name = '' OR length(trim(course_name)) BETWEEN 1 AND 160);
