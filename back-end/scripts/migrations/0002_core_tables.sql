-- Canonical Demo Production data model.
--
-- UUIDs are internal primary keys. Public API serialization is responsible for
-- Dhumi public identifiers; this schema never uses provider identifiers as
-- customer-facing IDs. Provider references are encrypted/fingerprinted only.

SET ROLE dhumi_owner;

CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL CHECK (email_normalized = lower(email_normalized)),
  password_hash text NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'locked', 'suspended', 'closed')),
  email_verified_at timestamptz,
  failed_auth_count integer NOT NULL DEFAULT 0 CHECK (failed_auth_count >= 0),
  last_failed_auth_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (email_normalized)
);

CREATE TABLE app.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'suspended', 'closed')),
  suspension_reason_code text,
  suspension_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.tenant_user_access (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  access_role text NOT NULL DEFAULT 'owner' CHECK (access_role = 'owner'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_user_access_by_user_state_idx
  ON app.tenant_user_access (user_id, state);

CREATE TABLE app.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  token_family_hash bytea NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  device_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  security_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at)
);
CREATE INDEX auth_sessions_expiry_state_idx
  ON app.auth_sessions (state, expires_at);

CREATE TABLE app.legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  document_version text NOT NULL,
  document_hash bytea NOT NULL,
  disclosure_version text,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locale text NOT NULL,
  request_id uuid,
  ip_fingerprint bytea,
  acceptance_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, tenant_id, document_type, document_version, document_hash)
);

CREATE TABLE app.platform_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  creator_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  key_prefix text NOT NULL,
  key_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key_prefix),
  UNIQUE (key_hash),
  CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY[
      'catalog:read', 'services:read', 'services:write', 'runs:read',
      'runs:write', 'results:read', 'usage:read'
    ]::text[]
  )
);
CREATE INDEX platform_api_keys_by_tenant_state_idx
  ON app.platform_api_keys (tenant_id, state, created_at DESC);

-- Global catalogue, adapter, evidence and private provider configuration.
CREATE TABLE app.launch_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_code text NOT NULL,
  scope_type text NOT NULL,
  scope_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'expired', 'revoked')),
  restricted_reference text NOT NULL,
  evidence_hash bytea,
  effective_at timestamptz,
  expires_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (evidence_code, scope_type, scope_key),
  CHECK (expires_at IS NULL OR effective_at IS NULL OR expires_at > effective_at)
);

CREATE TABLE app.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_code text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('local', 'test', 'staging', 'production')),
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('enabled', 'disabled')),
  launch_evidence_id uuid REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  expires_at timestamptz,
  changed_by text NOT NULL,
  changed_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feature_code, environment)
);

CREATE TABLE app.adapter_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  product_family text NOT NULL CHECK (product_family IN ('marketplace_dataset', 'scraper_library')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.adapter_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_definition_id uuid NOT NULL REFERENCES app.adapter_definitions(id) ON DELETE RESTRICT,
  semantic_version text NOT NULL,
  capability_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  code_artifact_digest bytea NOT NULL,
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (adapter_definition_id, semantic_version)
);

CREATE TABLE app.service_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$'),
  product_family text NOT NULL CHECK (product_family IN ('marketplace_dataset', 'scraper_library')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'disabled', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.service_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_template_id uuid NOT NULL REFERENCES app.service_templates(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  public_name text NOT NULL,
  public_description text NOT NULL,
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  availability_copy text NOT NULL,
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  launch_evidence_id uuid NOT NULL REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  effective_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (service_template_id, version)
);

CREATE TABLE app.provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code text NOT NULL DEFAULT 'bright_data',
  environment text NOT NULL CHECK (environment IN ('local', 'test', 'staging', 'production')),
  vault_secret_reference text NOT NULL,
  vault_secret_version_reference text,
  owner_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  permission_label text NOT NULL,
  state text NOT NULL DEFAULT 'inactive' CHECK (state IN ('inactive', 'active', 'retired')),
  expires_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  launch_evidence_id uuid REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_code, environment, vault_secret_reference)
);

CREATE TABLE app.provider_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_template_version_id uuid NOT NULL REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  provider_credential_id uuid NOT NULL REFERENCES app.provider_credentials(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('local', 'test', 'staging', 'production')),
  operation_code text NOT NULL,
  provider_resource_ciphertext bytea NOT NULL,
  provider_resource_fingerprint bytea NOT NULL,
  output_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  commercial_config_version text NOT NULL,
  config_version text NOT NULL,
  launch_evidence_id uuid NOT NULL REFERENCES app.launch_evidence(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, service_template_version_id, adapter_version_id, commercial_config_version)
);
CREATE UNIQUE INDEX provider_mappings_one_active_per_template_environment_idx
  ON app.provider_mappings (service_template_version_id, environment)
  WHERE state = 'enabled';

CREATE TABLE app.catalog_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  provider_credential_id uuid NOT NULL REFERENCES app.provider_credentials(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.catalog_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_import_id uuid NOT NULL REFERENCES app.catalog_imports(id) ON DELETE RESTRICT,
  provider_resource_ciphertext bytea NOT NULL,
  provider_resource_fingerprint bytea NOT NULL,
  metadata_object_key text,
  metadata_checksum bytea,
  review_state text NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (catalog_import_id, provider_resource_fingerprint)
);

-- Tenant-owned Services and their immutable versions.
CREATE TABLE app.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
  service_template_id uuid NOT NULL REFERENCES app.service_templates(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE app.service_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  service_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  service_template_version_id uuid NOT NULL REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  validated_configuration jsonb NOT NULL,
  schema_hash bytea NOT NULL,
  created_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (service_id, version),
  FOREIGN KEY (tenant_id, service_id)
    REFERENCES app.services (tenant_id, id) ON DELETE RESTRICT
);

-- Customer-visible work. The exact provider execution configuration is pinned
-- at admission, never resolved from whichever mapping is active later.
CREATE TABLE app.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  service_version_id uuid NOT NULL,
  service_template_version_id uuid NOT NULL REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  provider_mapping_id uuid NOT NULL REFERENCES app.provider_mappings(id) ON DELETE RESTRICT,
  commercial_config_version text NOT NULL,
  public_status text NOT NULL DEFAULT 'queued'
    CHECK (public_status IN ('queued', 'running', 'ready', 'failed', 'cancelled', 'expired')),
  internal_status text NOT NULL DEFAULT 'QUEUED'
    CHECK (internal_status IN (
      'QUEUED', 'SUBMITTED', 'UPSTREAM_REJECTED', 'CANCELLED',
      'RESULT_RECEIVED', 'PROCESSING', 'COMPLETED', 'PROCESSING_FAILED', 'EXPIRED'
    )),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  retryable boolean NOT NULL DEFAULT false,
  retry_of_run_id uuid,
  customer_error_code text,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  expired_at timestamptz,
  next_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_version_id)
    REFERENCES app.service_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, retry_of_run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX runs_by_tenant_created_idx ON app.runs (tenant_id, created_at DESC, id DESC);
CREATE INDEX runs_by_tenant_status_idx ON app.runs (tenant_id, public_status, created_at DESC);
CREATE INDEX runs_scheduler_idx ON app.runs (internal_status, next_action_at) WHERE next_action_at IS NOT NULL;

CREATE TABLE app.run_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  kind text NOT NULL CHECK (kind IN ('submission', 'poll', 'download', 'reconciliation')),
  state text NOT NULL CHECK (state IN ('claimed', 'accepted', 'rejected', 'ambiguous', 'completed', 'failed')),
  outcome_class text,
  fence_token uuid NOT NULL DEFAULT gen_random_uuid(),
  worker_lease_expires_at timestamptz,
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  provider_mapping_id uuid NOT NULL REFERENCES app.provider_mappings(id) ON DELETE RESTRICT,
  provider_credential_id uuid NOT NULL REFERENCES app.provider_credentials(id) ON DELETE RESTRICT,
  provider_reference_ciphertext bytea,
  provider_reference_fingerprint bytea,
  request_evidence_reference text,
  response_evidence_reference text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (run_id, attempt_number, kind),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX run_attempts_one_active_claim_idx
  ON app.run_attempts (run_id, kind)
  WHERE state = 'claimed';

CREATE TABLE app.run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  source text NOT NULL,
  attempt_id uuid,
  event_idempotency_key text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_reference text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, event_idempotency_key),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES app.run_attempts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('raw', 'normalized')),
  artifact_version integer NOT NULL DEFAULT 1 CHECK (artifact_version > 0),
  object_key text NOT NULL,
  content_type text NOT NULL,
  content_encoding text,
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  checksum bytea NOT NULL,
  schema_version text,
  state text NOT NULL CHECK (state IN ('durable', 'validated', 'quarantined', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (run_id, attempt_id, kind, artifact_version),
  UNIQUE (object_key),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES app.run_attempts (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid,
  service_template_version_id uuid NOT NULL REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
  adapter_version_id uuid NOT NULL REFERENCES app.adapter_versions(id) ON DELETE RESTRICT,
  meter_code text NOT NULL,
  quantity numeric(20, 6) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  outcome text NOT NULL,
  source text NOT NULL CHECK (source IN ('adapter', 'artifact', 'reconciliation', 'adjustment')),
  reconciliation_state text NOT NULL DEFAULT 'observed'
    CHECK (reconciliation_state IN ('observed', 'partially_reconciled', 'reconciled')),
  provider_reference_fingerprint bytea,
  evidence_reference text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES app.run_attempts (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX usage_events_by_tenant_recorded_idx
  ON app.usage_events (tenant_id, recorded_at DESC);

CREATE TABLE app.provider_cost_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider_code text NOT NULL DEFAULT 'bright_data',
  product_family text NOT NULL CHECK (product_family IN ('marketplace_dataset', 'scraper_library')),
  commercial_config_version text NOT NULL,
  evidence_reference text,
  estimated_amount_micros bigint NOT NULL CHECK (estimated_amount_micros >= 0),
  currency_code text NOT NULL DEFAULT 'USD' CHECK (currency_code ~ '^[A-Z]{3}$'),
  unit text NOT NULL,
  state text NOT NULL CHECK (state IN ('held', 'finalized', 'released')),
  finalized_amount_micros bigint CHECK (finalized_amount_micros >= 0),
  held_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (run_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.runs (tenant_id, id) ON DELETE RESTRICT
);

-- Idempotency is authoritative in PostgreSQL. Signup records intentionally
-- have no tenant yet; authenticated mutations always have one.
CREATE TABLE app.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  scope_kind text NOT NULL CHECK (scope_kind IN ('signup', 'tenant')),
  actor_fingerprint bytea NOT NULL,
  operation_code text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash bytea NOT NULL,
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed', 'failed')),
  response_status integer,
  resource_type text,
  resource_id uuid,
  related_resource_id uuid,
  response_body_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (scope_kind = 'signup' AND tenant_id IS NULL)
    OR (scope_kind = 'tenant' AND tenant_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idempotency_records_signup_scope_idx
  ON app.idempotency_records (actor_fingerprint, operation_code, idempotency_key)
  WHERE scope_kind = 'signup';
CREATE UNIQUE INDEX idempotency_records_tenant_scope_idx
  ON app.idempotency_records (tenant_id, operation_code, idempotency_key)
  WHERE scope_kind = 'tenant';

CREATE TABLE app.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  ordering_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  claimed_by text,
  claim_token uuid,
  published_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claimed_at IS NULL) = (claim_token IS NULL))
);
CREATE INDEX outbox_events_pending_idx
  ON app.outbox_events (available_at, created_at)
  WHERE published_at IS NULL;
CREATE INDEX outbox_events_stale_claim_idx
  ON app.outbox_events (claimed_at)
  WHERE published_at IS NULL AND claimed_at IS NOT NULL;

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES app.tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  outcome text NOT NULL,
  reason text,
  request_id uuid,
  ip_fingerprint bytea,
  safe_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_by_tenant_time_idx
  ON app.audit_events (tenant_id, occurred_at DESC);

-- Updated timestamps are database-derived, not trusted from an application.
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenants_touch_updated_at BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenant_user_access_touch_updated_at BEFORE UPDATE ON app.tenant_user_access
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER auth_sessions_touch_updated_at BEFORE UPDATE ON app.auth_sessions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER platform_api_keys_touch_updated_at BEFORE UPDATE ON app.platform_api_keys
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER launch_evidence_touch_updated_at BEFORE UPDATE ON app.launch_evidence
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER feature_flags_touch_updated_at BEFORE UPDATE ON app.feature_flags
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER service_templates_touch_updated_at BEFORE UPDATE ON app.service_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER provider_credentials_touch_updated_at BEFORE UPDATE ON app.provider_credentials
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER services_touch_updated_at BEFORE UPDATE ON app.services
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER runs_touch_updated_at BEFORE UPDATE ON app.runs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER run_attempts_touch_updated_at BEFORE UPDATE ON app.run_attempts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER provider_cost_holds_touch_updated_at BEFORE UPDATE ON app.provider_cost_holds
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER idempotency_records_touch_updated_at BEFORE UPDATE ON app.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER outbox_events_touch_updated_at BEFORE UPDATE ON app.outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

RESET ROLE;
