DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.marketplace_sample_versions
    WHERE retention_policy_version <> 'linkedin-posts-sample-30d-v1'
       OR expires_at <> collected_at + interval '30 days'
  ) THEN
    RAISE EXCEPTION
      'Existing Marketplace samples do not satisfy the accepted 30-day retention policy';
  END IF;
END;
$$;

ALTER TABLE app.marketplace_sample_versions
  ADD CONSTRAINT marketplace_sample_versions_retention_policy_v1_check
  CHECK (
    retention_policy_version = 'linkedin-posts-sample-30d-v1'
    AND expires_at = collected_at + interval '30 days'
  );
