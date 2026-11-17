ALTER TABLE outbound_message_media
  DROP CONSTRAINT outbound_message_media_data_check,
  ADD CONSTRAINT outbound_message_media_data_check CHECK (
    octet_length(data) BETWEEN 1 AND CASE
      WHEN mime_type IN ('video/mp4', 'video/3gpp') THEN 16777216
      ELSE 5242880
    END
  ) NOT VALID;
