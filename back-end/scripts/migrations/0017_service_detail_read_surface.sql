-- Least-privilege detail read surface for GET /v1/services/{service_id}.
--
-- This migration intentionally does not create or update a Service, expose
-- schema hashes or creator identity, publish catalogue content, call Bright
-- Data, widen Tenant visibility, or modify migrations 0001-0016.

SET ROLE dhumi_owner;

-- A Tenant may retrieve the provider-neutral configuration it previously
-- saved, while every internal version field remains outside the customer
-- runtime capability and existing forced RLS continues to isolate the row.
GRANT SELECT (validated_configuration)
  ON app.service_versions TO dhumi_customer_api;

RESET ROLE;
