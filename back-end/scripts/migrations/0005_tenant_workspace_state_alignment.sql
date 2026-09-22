-- Align the persisted workspace/tenant lifecycle with the public API contract.
--
-- Public API Workspace.state:
--   active | suspended | closing | closed
--
-- This is a forward-only correction. The migration runner executes this file
-- and its schema_migrations ledger write in one transaction.

SET ROLE dhumi_owner;

-- Fail closed if the database is not at the exact approved pre-migration
-- shape. Do not silently replace a constraint changed by another migration.
DO $migration$
DECLARE
  v_definition text;
  v_validated boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO v_definition, v_validated
  FROM pg_constraint AS c
  JOIN pg_class AS t
    ON t.oid = c.conrelid
  JOIN pg_namespace AS n
    ON n.oid = t.relnamespace
  WHERE n.nspname = 'app'
    AND t.relname = 'tenants'
    AND c.conname = 'tenants_state_check'
    AND c.contype = 'c';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION
      'Expected CHECK constraint app.tenants.tenants_state_check is missing';
  END IF;

  IF v_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Expected CHECK constraint app.tenants.tenants_state_check is not validated';
  END IF;

  IF v_definition <>
      'CHECK ((state = ANY (ARRAY[''active''::text, ''suspended''::text, ''closed''::text])))' THEN
    RAISE EXCEPTION
      'Unexpected pre-migration definition for app.tenants.tenants_state_check: %',
      v_definition;
  END IF;
END
$migration$;

ALTER TABLE app.tenants
  DROP CONSTRAINT tenants_state_check;

ALTER TABLE app.tenants
  ADD CONSTRAINT tenants_state_check
  CHECK (state IN ('active', 'suspended', 'closing', 'closed'));

-- Verify the exact post-migration shape before the surrounding migration
-- transaction is allowed to commit.
DO $migration$
DECLARE
  v_definition text;
  v_validated boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO v_definition, v_validated
  FROM pg_constraint AS c
  JOIN pg_class AS t
    ON t.oid = c.conrelid
  JOIN pg_namespace AS n
    ON n.oid = t.relnamespace
  WHERE n.nspname = 'app'
    AND t.relname = 'tenants'
    AND c.conname = 'tenants_state_check'
    AND c.contype = 'c';

  IF v_definition <>
      'CHECK ((state = ANY (ARRAY[''active''::text, ''suspended''::text, ''closing''::text, ''closed''::text])))' THEN
    RAISE EXCEPTION
      'Unexpected post-migration definition for app.tenants.tenants_state_check: %',
      COALESCE(v_definition, '<missing>');
  END IF;

  IF v_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Post-migration CHECK constraint app.tenants.tenants_state_check is not validated';
  END IF;
END
$migration$;

RESET ROLE;
