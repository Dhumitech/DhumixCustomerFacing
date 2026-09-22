-- Align persistent catalogue slugs with the accepted public item-route grammar.
--
-- This migration intentionally does not publish or backfill a Template, change
-- catalogue RLS or grants, add an index, call Bright Data, or modify migrations
-- 0001-0013.

SET ROLE dhumi_owner;

-- Every published slug must remain addressable through the accepted
-- /v1/catalog/templates/{slug} contract; repeated or edge hyphens are invalid.
ALTER TABLE app.service_templates
  DROP CONSTRAINT service_templates_slug_check,
  ADD CONSTRAINT service_templates_slug_check
  CHECK (
    length(slug) BETWEEN 3 AND 100
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );

RESET ROLE;
