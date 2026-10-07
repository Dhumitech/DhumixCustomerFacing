-- FOR REVIEW: 0070_archive; FIRST table phase, 43 -> 32, not final 25.
-- READ-ONLY baseline: 2026-10-06 / localhost:5432/dhumi_test / PostgreSQL 18.4.
-- Target: D:\BrightDataCustomerFacing\API-Design-Skill\NewRefactor\RefactorPlan\
--         Refactor-Plan.md sections 4/9; Database.md.
-- Source: existing back-end/scripts/migrations/0001--0069, all source SHA-256
-- matched to the live ledger below; replacements derive from live definitions.
-- Canonical migration body. NEVER applied; qualification of these bytes pending.
-- migrate.ps1 owns the transaction and final ledger insert; this SQL owns neither.
-- Existing eight test identities retained; NO role/login/password operations.
--
-- Observed: 43 tables, 606 stored columns, 120 functions (98 SECURITY DEFINER),
-- 83 RLS policies. API keys 3,778, audits 19,969, idempotency 11,778, envelopes 25.
-- All Marketplace archive/source/sample tables and Runs were empty.
-- Outbox 11,593 unpublished, including 207 security.api_key_revoked notices.
-- Later 0071/0073 blockers: 255 active tenants lack one accepted signup actor;
-- 770 lack an active owner membership; 4 Attempts lack a matching Run.
-- No guessed attribution, fixture cleanup, or outbox deletion is included.
--
-- Only 0070 here. Separate 0071--0075 must ship with their matching code.
-- BOTH Run writers must insert authenticated created_by_user_id and stop
-- actor_api_key_id writes; archive API-key routes/auth/envelope workers; adapt
-- presentation DTOs; stop/port commands calling the retired promotion helpers.
-- Stored sample preview/query/download/expiry remain. Promotion from internal
-- Run artifacts is the separate Target section 4 follow-up.
--
-- Review findings: scope_kind is signup/tenant, NOT API-key-only. Keep until
-- identity/idempotency cutover (source RLS/uniqueness/replay depend on it).
-- Keep qualification_packet_id as historical sample UUID until 0074; drop FK.
-- Non-NULL retained API-key actors stop migration: never assume a user actor.
-- sample_metadata_checksum preserves the safe imported-metadata digest for
-- the fixture command; exclude it from public presentation projections.
--
-- Target requires verified dump+keys+restore/reference/object drill, matching
-- backend qualification, stopped/drained processes and compatible queues.
-- Review-0070.ps1 has NO execution by default. -Apply needs reviewed SHA-256
-- and all four explicit attestations. No automatic backup/deployment/calls.
-- Atomic transaction; on error rollback all changes including ledger.
-- After commit, recovery is verified dump+keys+matching code, not reverse SQL.
-- RLS: https://www.postgresql.org/docs/18/ddl-rowsecurity.html
-- RESTRICT: https://www.postgresql.org/docs/18/sql-droptable.html

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='60s';
DO $gate$
BEGIN
 IF current_database()<>'dhumi_test'
  OR current_setting('server_version_num')::integer<180000 THEN
  RAISE EXCEPTION 'Only dhumi_test on PostgreSQL 18+ is allowed';
 END IF;
 IF coalesce(current_setting('dhumi.refactor_apply',true),'')<>'0070'
  OR coalesce(current_setting('dhumi.backup_restore_verified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.matching_backend_ready',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.processes_stopped',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.queue_compatibility_verified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.reviewed_sql_sha256',true),'')!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION '0070 review/backup/cutover gates missing; use Review-0070.ps1';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='dhumi_test'
  AND pid<>pg_backend_pid() AND usename LIKE 'dhumi_test_%_login') THEN
  RAISE EXCEPTION 'Test runtime connections remain; stop API/workers/operators';
 END IF;
END
$gate$;
SET LOCAL ROLE dhumi_owner;
SELECT pg_advisory_xact_lock(hashtextextended('dhumi_test.refactor.0070',0));
CREATE TEMP TABLE refactor_0070_ledger(version text PRIMARY KEY,checksum text NOT NULL)
ON COMMIT DROP;
INSERT INTO refactor_0070_ledger VALUES
 ('0001_bootstrap_roles_and_schema','f3bb8b9318b74413ba4cb570262046df2b7cbaeedfcbad2bc8ffc6fba61fa9ea'),
 ('0002_core_tables','7747ed1b26b990e20de30fa19478914fa02ab69c742d78b585784d78cf4e10bf'),
 ('0003_rls_transitions_and_transaction_functions','23b1073746a3dacc145ecd4c3454e5938d1a9d9e530e4fe778ef21bccd9f9bc2'),
 ('0004_database_integrity_corrections','34710ca15692ee3319fcf1cbbcb1db52f06a149f13c4405a3f067a8f36c6cc91'),
 ('0005_tenant_workspace_state_alignment','7780b5fd3fb6c9126df449249fa6f096f679bdf63ed6db1f61070e92d6131831'),
 ('0006_refresh_token_rotation','af3c6101c956bda36ef313efff2f1d678397af3842a94db415e2e05c4ed2faa4'),
 ('0007_api_key_schema_foundation','cb2dd9b4ace666d2b1c6a5edba9dd437f15daaca199929c1413edfb0246bbde0'),
 ('0008_core_integrity_constraints','08b8ab9db3fad43aec23ebad44f268e3007d81e977ff911fa142cf5b740a6529'),
 ('0009_envelope_destruction','29f5e7e80e4b92215549e4c225221ef30e505f152e7688af2581297697f4cbbf'),
 ('0010_api_key_list_read_surface','b299e93840b05495298b941e8fc497d3c44730629b44a90cb4f57d1e2fe06913'),
 ('0011_api_key_revocation','f80d48efbffef4c8ded2a5f4054a87a2a315c8ae7c840ed2ec11a86edd4d4750'),
 ('0012_api_key_revocation_event_v2','da57b06c2121afec6dc756fe5e9c6b3903982ac91cc241d525ced19140b0d0e9'),
 ('0013_catalogue_public_read_surface','869451d73d6507278329a0490b3d863986029ca5e4bdf00e676dc20bdcb88812'),
 ('0014_catalogue_slug_integrity','a23db772d09350684e9d08da7f9ab022fe049527beb64974e75d36b5e2572f79'),
 ('0015_service_list_read_surface','25cfbd8c387f2b9311ec29b2f453cf5cb6ed5c44c5aa76055e64345290d94571'),
 ('0016_service_creation','8c967f523485214a11b7b9b6b233cf79d028545c1076e9d5656ef3100dec5da4'),
 ('0017_service_detail_read_surface','8d9b859b0540ee3e3c07384d496418d3db6cb360ac97e62c37830e709d172bbd'),
 ('0018_run_admission','94ae9d7adb9ffece2e7424219945f6e77e15c04dd5a20b0ce2943d3d4063077b'),
 ('0019_run_service_lock','cdde64eff8757e0b0999db64fe34bc440724365b12108bc62f0f8828ed157688'),
 ('0020_run_list_read_surface','6c0f87c6f2c47adc88bb2af5a41ee3740cb325e5a9e44b0e236c05af96b43fd3'),
 ('0021_run_cancellation','abe0895839780783fb32c141e91cf82474cc442739602bace868f85340ea2dfe'),
 ('0022_run_retry','96f89ccca5dfb35081857054af170e4e40ba1595c4cc8072d503bd166ec4212d'),
 ('0023_run_retry_owner_rls','ed87bac9e51d05128276a82622440cb291a6cc8a6e053fb93355138bc1013971'),
 ('0024_run_retry_idempotency_lineage','92bed8d95e91d30330db4ecd9762237ab462ad81105084d4f7268ea3e250a140'),
 ('0025_run_event_list_read_surface','88ad8cf9ccc7206685dd028b59a52323e11a55dd4686a1cc844890385974c448'),
 ('0026_template_presentation_and_configuration_schema','5c1442740fa41ddd2a51443e990cfb2ea141cd20ec06d86a56fe500fba956db3'),
 ('0027_run_list_service_filter','5e538b6f30540716b2d776fb0e28d6e037aec718ffdc5fee7ef6b53a1cd72030'),
 ('0028_run_result_read_surface','08c122231cf9bb74971f770c707f77ce7c09d9bf12bffc2c58e48ff258722093'),
 ('0029_durable_execution_fencing','b935672cc78820410ab93d5c09c4d4511a32c270c1fea36352418b8ba95d0977'),
 ('0030_durable_execution_reconciliation','b8bcd4a6e1cc72f1d60e16a545c3a4478f9fab46f65ebd09d19c58bf17fc7651'),
 ('0031_provider_execution_boundary','61c19bb9dfac565db1ccf8f473f5c397b9d8d65c645963337a6ae01ffbfa2bc6'),
 ('0032_amazon_operation_definitions','92a60d577d0fa84a47fe03b4ca0aab70e8783c1d258cba888ea43ce99ea281b7'),
 ('0033_amazon_live_qualification_foundation','a08ed607df2231a408043628592b322f6a996ae1e396c36e314f0e396dfc7db5'),
 ('0034_amazon_qualification_audit_rls','a5c9eba29d6df6bc4894372a6e6daa5035c1690a3e9767c993ad5bf36a5ec857'),
 ('0035_amazon_qualification_template_version_rls','d7b3c67edf88a4f277ae736f5728339fc80e12ef9c8a7e6d40c464896c39d7e2'),
 ('0036_amazon_qualification_execution_mode','cee070da327c40ac779b4577f64833846b8ff3ad2dc6ad52229ff207c183e48b'),
 ('0037_usage_finalization','09829dc1f9637f4bbe00bf32f4250f1ae07824800cc4bf4d16b542115d6aacf3'),
 ('0038_usage_read_surface','050aab6e5903dd4513c621d3acd372dcc23eb0b4a9845d6e5e551845d2bb4e23'),
 ('0039_platform_status_projection','5db6faed19a73e30ae568dd822658d8f52a4faa9270233019c7f1a48650061fb'),
 ('0040_amazon_precise_output_contracts','1733b72ccb31d00065735f99ae96ef2d7e380d4a5c6c648ac99dc25c395e87c2'),
 ('0041_amazon_controlled_publication','6d1c813a275e172c537cd49f260269a0592ba94bb81cac10901c90d07bb3972c'),
 ('0042_provider_mapping_aad_lineage','0e258efec49c1e3745441cd242f9a9359e667fefc2987ac7e2053fae7d839442'),
 ('0043_amazon_products_input_contract_v4','56f00965f10d1abcb13ec4165a5914e6f85098201d12a4ccfaa83c5b238100ae'),
 ('0044_provider_poll_checkpoint','6144ea86ba338f2c51edd69d6c42c113b0b0a3ff40e2639a52c603849ba697f2'),
 ('0045_marketplace_catalogue_import','5a3602bb0125bb587cfe1ac7394745d29b73f4256e81f6015a89242b3c6a5d5a'),
 ('0046_marketplace_sample_ingestion','e6e0c12509d574ded99deb23cfddc15b8e25b880f67533b9a3d4e250f3d233f5'),
 ('0047_marketplace_sample_retention_policy','d372502c00bfbd240f619a55f104f7cfcf121c2edd59832a112a71a7f7315478'),
 ('0048_marketplace_sample_fixture_lifecycle','5cc2ca451dc3d6edf25a0ffedc6311fbc6d98933fb487016d7119889ce28def9'),
 ('0049_marketplace_sample_preview_read','93c7a4b612a03ce765e50d5545143842703fb0022e73300e4bb0770e512b5eb7'),
 ('0050_marketplace_sample_download_authorization','526b488ea947cf3bd75b0741f446d4290f81465500a3eae1616ba52f38345a78'),
 ('0051_marketplace_expert_enquiries','b96c2a55ead67f2492355ebdfccf6cc770f93db27c58f90eb88630cc07ba00c8'),
 ('0052_marketplace_filter_adapter_fixture','e78ab7338aa7eee7ce9980ac6e5b0af6ce54ead2c32e3cc5b5f44cd8b18b5c60'),
 ('0053_marketplace_filter_execution_rls','5e4b98e1745f8b176f317dffa7f8f0994bf1ceb6d0a781d597dc3368f3285c6c'),
 ('0054_marketplace_qualification_preflight','ada06465a57dc50a52967dd7fb1a8b519537a075a97c871dd5243f0704628ea9'),
 ('0055_marketplace_qualification_execution','7393871036e47966764606a8c4cd7dd84759b8a06b9dfa0486a36d56021920ed'),
 ('0056_marketplace_export_candidate','53eb18f59c2485c2456cb6966227d6395581c7caeec59baa54ec004c4cc9ab1e'),
 ('0057_linkedin_posts_provider_sample','535860e803d7b811614b76b583672d55a0a4a7495ffa44782fdb09138f224286'),
 ('0058_marketplace_provider_sample_timestamp_authority','c1160595d9fdc7385becf02ea584963870b75b1a1c2674bdf668960caf357014'),
 ('0059_linkedin_posts_provider_sample_version_3','b32eda2ff7e7484e2361b5147c72343db74dde62c71c4a935acdd9e5f2848f9e'),
 ('0060_linkedin_people_metadata_observation','e5a1877abd766cb5f3c24a88865009ef23436d36b10f3d2b7cd29c5354eb922b'),
 ('0061_linkedin_people_synthetic_preview','12b41e3887642a7d4da6d1bade8c10f363c34a0dad0849e0a9631aa9ac3c330e'),
 ('0062_linkedin_people_sample_timestamp_authority','077b8abbbd9d56ad8c5cd5f2fbc05ac0edea20a748081ed359abcf1b78b0dcbb'),
 ('0063_linkedin_people_contact_contract','af1a9b8900adc369d20e1dbb8193fa68dfb478769b24bd3b2e9443a80b8afe83'),
 ('0064_marketplace_sample_download_cleanup','eefa25c1aac1bd5a9527624a2e860a7f2da6b71307f49577fe2e5c6b427ba422'),
 ('0065_marketplace_fixture_current_schema','a555b737e3dfd73fd835a271c9ac562ec5203bbb87bff8616dc738c8a065f894'),
 ('0066_shared_scraper_processing','65da95f341d63abc8a7861d0f08936e111af69fb8b4a2abd0b50359c0b443a60'),
 ('0067_shared_scraper_draft_registration','c79b9dcd42fb0fb5261905f7ebd9cf0dff3fc8400ecdfaecaeb5b3842cc573fb'),
 ('0068_shared_scraper_release_identity','0fac582eef7e19bcfa969bf4b45482d8e9c6312e7ebc7c5821e6a2058bd379c7'),
 ('0069_shared_scraper_commercial_capacity','6b729ac9d99717371fe1354c3efa296625b492f07dc008f4706aea8796e9efe5');
DO $baseline$
DECLARE actual text;
BEGIN
 IF EXISTS(
 (SELECT version,checksum FROM app.schema_migrations EXCEPT
  SELECT version,checksum FROM refactor_0070_ledger)
 UNION ALL
 (SELECT version,checksum FROM refactor_0070_ledger EXCEPT
  SELECT version,checksum FROM app.schema_migrations)) THEN
  RAISE EXCEPTION 'Ledger changed since review';
 END IF;
 SELECT md5(string_agg(c.relname||'.'||a.attname||':'||
  format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,
  '|' ORDER BY c.relname,a.attnum)) INTO actual
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='app'
 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM 'bccf1c0f4d76d5f3dc1d0da7211fdeb5' THEN
  RAISE EXCEPTION 'Column inventory changed since review';
 END IF;
 SELECT md5(string_agg(pg_get_functiondef(p.oid),E'\n'
 ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))) INTO actual
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app';
 IF actual IS DISTINCT FROM 'ce52ade846cf8936f07ea5de5981c932' THEN
  RAISE EXCEPTION 'Functions changed since review';
 END IF;
 SELECT md5(string_agg(c.relname||'.'||co.conname||':'||
 pg_get_constraintdef(co.oid,true),E'\n' ORDER BY c.relname,co.conname)) INTO actual
 FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app';
 IF actual IS DISTINCT FROM '664ce4bc66fe62e21a2af34fdb39693e' THEN
  RAISE EXCEPTION 'Constraints changed since review';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN
 ('app.runs'::regclass,'app.service_template_versions'::regclass)
 AND tgname IN('runs_touch_updated_at','service_template_versions_immutable')
 AND tgenabled<>'O') THEN
  RAISE EXCEPTION 'Backfill guards must be normally enabled';
 END IF;
END
$baseline$;

-- Stable table-lock order; transactionally lift FORCE only for the owner.
CREATE TEMP TABLE refactor_0070_tables ON COMMIT DROP AS
SELECT c.relname::text table_name,c.relrowsecurity rls,c.relforcerowsecurity force_rls
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='app' AND c.relkind='r';
DO $locks$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM refactor_0070_tables ORDER BY table_name LOOP
  EXECUTE format('LOCK TABLE app.%I IN ACCESS EXCLUSIVE MODE',r.table_name);
  IF r.force_rls THEN
   EXECUTE format('ALTER TABLE app.%I NO FORCE ROW LEVEL SECURITY',r.table_name);
  END IF;
 END LOOP;
END
$locks$;

-- Reconcile all retained rows/values; only counts/digests, never row contents.
CREATE TEMP TABLE refactor_0070_retained(
 table_name text PRIMARY KEY,excluded_columns text[],row_count bigint,digest text
) ON COMMIT DROP;
DO $retain$
DECLARE r record; exclusions text[]; total bigint; value_hash text;
BEGIN
 FOR r IN SELECT * FROM refactor_0070_tables
 WHERE table_name NOT IN ('marketplace_export_candidates','marketplace_qualification_poll_checkpoints','marketplace_qualification_packets','marketplace_contact_mode_contracts','marketplace_contact_contract_packets','marketplace_catalog_metadata_observations','catalog_import_candidate_observations','provider_qualification_attempts','catalog_candidates','catalog_imports','platform_api_keys') ORDER BY table_name LOOP
  exclusions:=CASE r.table_name
   WHEN 'runs' THEN ARRAY['created_by_user_id']
   WHEN 'service_template_versions' THEN ARRAY['presentation_metadata']
   WHEN 'audit_events' THEN ARRAY['actor_api_key_id']
   WHEN 'service_versions' THEN ARRAY['created_by_api_key_id']
   WHEN 'marketplace_sample_download_authorizations' THEN ARRAY['actor_api_key_id']
   WHEN 'marketplace_expert_enquiries' THEN ARRAY['actor_api_key_id']
   WHEN 'idempotency_records' THEN ARRAY['response_envelope_ciphertext',
    'response_envelope_key_reference','response_envelope_recoverable_until',
    'response_envelope_destroyed_at']
   ELSE ARRAY[]::text[] END;
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),''''))
   FROM (SELECT md5((to_jsonb(t)-$1)::text) d FROM app.%I t) s',r.table_name)
   INTO total,value_hash USING exclusions;
  INSERT INTO refactor_0070_retained VALUES(r.table_name,exclusions,total,value_hash);
 END LOOP;
END
$retain$;
DO $actors$
BEGIN
 IF EXISTS(SELECT 1 FROM app.audit_events WHERE actor_api_key_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM app.service_versions WHERE created_by_api_key_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM app.marketplace_sample_download_authorizations WHERE actor_api_key_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM app.marketplace_expert_enquiries WHERE actor_api_key_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Retained API-key actors need explicit provenance reconciliation';
 END IF;
END
$actors$;

-- 1. Add/grant/backfill starter BEFORE any drop. Retry uses its own actor.
ALTER TABLE app.runs ADD COLUMN created_by_user_id uuid;
ALTER TABLE app.runs ADD CONSTRAINT runs_starter_user_fk
 FOREIGN KEY(created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;
ALTER TABLE app.runs ADD CONSTRAINT runs_starter_tenant_fk
 FOREIGN KEY(tenant_id,created_by_user_id)
 REFERENCES app.tenant_user_access(tenant_id,user_id) ON DELETE RESTRICT;
GRANT INSERT(created_by_user_id) ON app.runs TO dhumi_admission;
CREATE TEMP TABLE refactor_0070_starters ON COMMIT DROP AS
SELECT r.tenant_id,r.id run_id,a.actor_user_id FROM app.runs r JOIN app.audit_events a
ON a.tenant_id=r.tenant_id AND a.target_id=r.id AND a.target_type='run'
AND a.action IN('run.create','run.retry') AND a.outcome='accepted'
AND a.actor_user_id IS NOT NULL AND a.actor_api_key_id IS NULL
GROUP BY r.tenant_id,r.id,a.actor_user_id;
DO $starter_proof$
BEGIN
 IF EXISTS(SELECT 1 FROM refactor_0070_starters GROUP BY tenant_id,run_id HAVING count(*)<>1)
 OR EXISTS(SELECT 1 FROM refactor_0070_starters s WHERE NOT EXISTS(
 SELECT 1 FROM app.tenant_user_access m WHERE m.tenant_id=s.tenant_id
 AND m.user_id=s.actor_user_id)) THEN
  RAISE EXCEPTION 'Conflicting or invalid starter evidence';
 END IF;
END
$starter_proof$;
ALTER TABLE app.runs DISABLE TRIGGER runs_touch_updated_at;
UPDATE app.runs r SET created_by_user_id=s.actor_user_id
FROM refactor_0070_starters s WHERE r.id=s.run_id AND r.tenant_id=s.tenant_id;
ALTER TABLE app.runs ENABLE TRIGGER runs_touch_updated_at;
DO $starter_values$
BEGIN
 IF EXISTS(SELECT 1 FROM refactor_0070_starters s JOIN app.runs r
 ON r.id=s.run_id AND r.tenant_id=s.tenant_id
 WHERE r.created_by_user_id IS DISTINCT FROM s.actor_user_id) THEN
  RAISE EXCEPTION 'Starter backfill value mismatch';
 END IF;
END
$starter_values$;
DO $starter_cutover$
DECLARE cutover timestamptz:=clock_timestamp();
BEGIN
 IF has_column_privilege('dhumi_admission','app.runs','created_at','INSERT') THEN
  RAISE EXCEPTION 'Admission can bypass cutover by backdating';
 END IF;
 EXECUTE format('ALTER TABLE app.runs ADD CONSTRAINT runs_starter_cutover_check
 CHECK(created_at<%L::timestamptz OR created_by_user_id IS NOT NULL)',cutover);
END
$starter_cutover$;
CREATE FUNCTION app.guard_run_starter() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog,app,pg_temp AS $function$
BEGIN
 IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'RUN_STARTER_IS_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION app.guard_run_starter() FROM PUBLIC;
CREATE TRIGGER runs_starter_immutable BEFORE UPDATE ON app.runs
FOR EACH ROW EXECUTE FUNCTION app.guard_run_starter();

-- 2. Move retained public facts/digest; preserve the original metadata.
CREATE TEMP TABLE refactor_0070_presentation ON COMMIT DROP AS
SELECT id,presentation_metadata FROM app.service_template_versions;
CREATE TEMP TABLE refactor_0070_catalogue ON COMMIT DROP AS
SELECT c.service_template_version_id version_id,c.provider_record_count,
 c.metadata_observed_at,c.metadata_checksum FROM app.catalog_candidates c
JOIN app.service_template_versions v ON v.id=c.service_template_version_id
JOIN app.service_templates t ON t.id=v.service_template_id
WHERE c.review_state='approved' AND t.product_family='marketplace_dataset'
 AND ((t.slug='linkedin-posts' AND c.resource_code='linkedin.posts')
 OR (t.slug='linkedin-people' AND c.resource_code='linkedin.people.standard'));
CREATE TEMP TABLE refactor_0070_contacts ON COMMIT DROP AS
SELECT p.service_template_version_id version_id,p.id packet_id,
 coalesce(jsonb_agg(jsonb_build_object('code',m.mode,'display_order',m.display_order,
 'customer_meaning',m.customer_meaning,'preview_state',m.preview_state,
 'fulfillment_state',m.fulfillment_state) ORDER BY m.display_order)
 FILTER(WHERE m.packet_id IS NOT NULL),'[]'::jsonb) contact_modes
FROM app.marketplace_contact_contract_packets p
LEFT JOIN app.marketplace_contact_mode_contracts m ON m.packet_id=p.id
WHERE p.contract_version=1 AND p.governance_state='fulfillment_evidence_pending'
 AND p.fulfillment_state='not_enabled' AND p.provider_calls=0
GROUP BY p.service_template_version_id,p.id;
DO $presentation_preconditions$
BEGIN
 IF EXISTS(SELECT 1 FROM refactor_0070_catalogue GROUP BY version_id HAVING count(*)<>1)
 OR EXISTS(SELECT 1 FROM refactor_0070_contacts GROUP BY version_id HAVING count(*)<>1) THEN
  RAISE EXCEPTION 'Ambiguous catalogue/contact facts; no arbitrary latest row';
 END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions
 WHERE presentation_metadata ?| ARRAY['provider_record_count',
 'provider_record_count_as_of','contact_modes','sample_metadata_checksum']) THEN
  RAISE EXCEPTION 'Destination keys already exist; reconcile instead of overwrite';
 END IF;
END
$presentation_preconditions$;
CREATE TEMP TABLE refactor_0070_preview_before ON COMMIT DROP AS
SELECT to_jsonb(p)-'presentation_metadata' value
FROM app.resolve_marketplace_sample_preview(NULL,transaction_timestamp()) p;
CREATE TEMP TABLE refactor_0070_contact_before ON COMMIT DROP AS
SELECT v.id version_id,to_jsonb(m) value FROM app.service_template_versions v
CROSS JOIN LATERAL app.resolve_marketplace_contact_modes(v.service_template_id,v.version) m;

-- Extend the exact source whitelist, preserving every required key/type rule.
ALTER TABLE app.service_template_versions
 DROP CONSTRAINT service_template_versions_presentation_object_check,
 ADD CONSTRAINT service_template_versions_presentation_object_check
 CHECK (jsonb_typeof(presentation_metadata) = 'object'::text AND (presentation_metadata - ARRAY['domain_slug'::text, 'domain_name'::text, 'category'::text, 'icon_key'::text, 'operation_group'::text, 'operation_name'::text, 'display_priority'::text, 'provider_record_count'::text, 'provider_record_count_as_of'::text, 'contact_modes'::text, 'sample_metadata_checksum'::text]) = '{}'::jsonb AND presentation_metadata ?& ARRAY['domain_slug'::text, 'domain_name'::text, 'category'::text, 'icon_key'::text, 'operation_group'::text, 'operation_name'::text, 'display_priority'::text] AND jsonb_typeof(presentation_metadata -> 'domain_slug'::text) = 'string'::text AND (presentation_metadata ->> 'domain_slug'::text) ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text AND jsonb_typeof(presentation_metadata -> 'domain_name'::text) = 'string'::text AND char_length(presentation_metadata ->> 'domain_name'::text) >= 1 AND char_length(presentation_metadata ->> 'domain_name'::text) <= 120 AND jsonb_typeof(presentation_metadata -> 'category'::text) = 'string'::text AND char_length(presentation_metadata ->> 'category'::text) >= 1 AND char_length(presentation_metadata ->> 'category'::text) <= 80 AND jsonb_typeof(presentation_metadata -> 'icon_key'::text) = 'string'::text AND (presentation_metadata ->> 'icon_key'::text) ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text AND jsonb_typeof(presentation_metadata -> 'operation_group'::text) = 'string'::text AND char_length(presentation_metadata ->> 'operation_group'::text) >= 1 AND char_length(presentation_metadata ->> 'operation_group'::text) <= 120 AND jsonb_typeof(presentation_metadata -> 'operation_name'::text) = 'string'::text AND char_length(presentation_metadata ->> 'operation_name'::text) >= 1 AND char_length(presentation_metadata ->> 'operation_name'::text) <= 120 AND jsonb_typeof(presentation_metadata -> 'display_priority'::text) = 'number'::text AND (presentation_metadata ->> 'display_priority'::text) ~ '^[0-9]+$'::text AND ((presentation_metadata ->> 'display_priority'::text)::numeric) <= 1000000::numeric);
ALTER TABLE app.service_template_versions
 ADD CONSTRAINT service_template_versions_marketplace_presentation_check CHECK(
 (NOT presentation_metadata ? 'provider_record_count'
 OR presentation_metadata->'provider_record_count'='null'::jsonb
 OR (jsonb_typeof(presentation_metadata->'provider_record_count')='number'
 AND presentation_metadata->>'provider_record_count' ~ '^[0-9]+$'))
 AND (NOT presentation_metadata ? 'provider_record_count_as_of'
 OR presentation_metadata->'provider_record_count_as_of'='null'::jsonb
 OR jsonb_typeof(presentation_metadata->'provider_record_count_as_of')='string')
 AND (NOT presentation_metadata ? 'contact_modes'
 OR jsonb_typeof(presentation_metadata->'contact_modes')='array')
 AND (NOT presentation_metadata ? 'sample_metadata_checksum'
 OR presentation_metadata->'sample_metadata_checksum'='null'::jsonb
 OR (jsonb_typeof(presentation_metadata->'sample_metadata_checksum')='string'
 AND presentation_metadata->>'sample_metadata_checksum' ~ '^[0-9a-f]{64}$'))
 );
ALTER TABLE app.service_template_versions DISABLE TRIGGER service_template_versions_immutable;
UPDATE app.service_template_versions v SET presentation_metadata=v.presentation_metadata||
 jsonb_build_object('provider_record_count',s.provider_record_count,
 'provider_record_count_as_of',s.metadata_observed_at,
 'sample_metadata_checksum',encode(s.metadata_checksum,'hex'))
FROM refactor_0070_catalogue s WHERE v.id=s.version_id;
UPDATE app.service_template_versions v SET presentation_metadata=v.presentation_metadata||
 jsonb_build_object('contact_modes',s.contact_modes)
FROM refactor_0070_contacts s WHERE v.id=s.version_id;
ALTER TABLE app.service_template_versions ENABLE TRIGGER service_template_versions_immutable;
DO $presentation_values$
BEGIN
 IF EXISTS(SELECT 1 FROM refactor_0070_presentation b
 JOIN app.service_template_versions v ON v.id=b.id
 WHERE (v.presentation_metadata-ARRAY['provider_record_count',
 'provider_record_count_as_of','contact_modes','sample_metadata_checksum'])
 IS DISTINCT FROM b.presentation_metadata)
 OR EXISTS(SELECT 1 FROM refactor_0070_catalogue s
 JOIN app.service_template_versions v ON v.id=s.version_id
 WHERE (v.presentation_metadata->>'provider_record_count')::bigint
 IS DISTINCT FROM s.provider_record_count
 OR (v.presentation_metadata->>'provider_record_count_as_of')::timestamptz
 IS DISTINCT FROM s.metadata_observed_at
 OR decode(v.presentation_metadata->>'sample_metadata_checksum','hex')
 IS DISTINCT FROM s.metadata_checksum)
 OR EXISTS(SELECT 1 FROM refactor_0070_contacts s
 JOIN app.service_template_versions v ON v.id=s.version_id
 WHERE v.presentation_metadata->'contact_modes' IS DISTINCT FROM s.contact_modes) THEN
  RAISE EXCEPTION 'Original/moved presentation values differ';
 END IF;
END
$presentation_values$;

-- Compatibility helpers remain SECURITY DEFINER until their TypeScript phase.
-- Zero SECURITY DEFINER is a final 0075 requirement, not a 0070 assertion.
-- Browser-only optional API-key parameters stay in the old signatures but
-- reject non-NULL values; this is temporary contract compatibility, not a role.

-- Retained helper: resolve_marketplace_contact_modes
CREATE OR REPLACE FUNCTION app.resolve_marketplace_contact_modes(p_template_id uuid, p_template_version integer)
 RETURNS TABLE(code text, display_order integer, customer_meaning text, preview_state text, fulfillment_state text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
  SELECT m.code,m.display_order,m.customer_meaning,m.preview_state,m.fulfillment_state
  FROM app.service_template_versions v
  CROSS JOIN LATERAL jsonb_to_recordset(
    coalesce(v.presentation_metadata->'contact_modes','[]'::jsonb))
    AS m(code text,display_order integer,customer_meaning text,
      preview_state text,fulfillment_state text)
  WHERE v.service_template_id=p_template_id AND v.version=p_template_version
  ORDER BY m.display_order;
$function$;


-- Retained helper: resolve_marketplace_sample_preview
CREATE OR REPLACE FUNCTION app.resolve_marketplace_sample_preview(p_template_slug text, p_as_of timestamp with time zone)
 RETURNS TABLE(template_id uuid, template_slug text, template_version integer, public_name text, public_description text, presentation_metadata jsonb, configuration_schema jsonb, input_schema jsonb, provider_record_count bigint, provider_record_count_as_of timestamp with time zone, sample_version integer, sample_record_count integer, sample_byte_count bigint, sample_checksum_hex text, sample_object_key text, collected_at timestamp with time zone, expires_at timestamp with time zone, fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
  SELECT
    template.id,
    template.slug,
    version.version,
    version.public_name,
    CASE template.slug
      WHEN 'linkedin-posts' THEN
        'Preview a governed LinkedIn Posts sample before purchase.'
      ELSE 'Preview a governed LinkedIn People sample before purchase.'
    END,
    version.presentation_metadata - 'sample_metadata_checksum',
    version.configuration_schema,
    version.input_schema,
    (version.presentation_metadata->>'provider_record_count')::bigint,
    (version.presentation_metadata->>'provider_record_count_as_of')::timestamptz,
    sample.sample_version,
    sample.record_count,
    sample.byte_count,
    encode(sample.checksum, 'hex'),
    sample.object_key,
    sample.collected_at,
    sample.expires_at,
    (
      SELECT jsonb_agg(field - 'post_purchase_visibility' ORDER BY ordinal)
      FROM jsonb_array_elements(sample.field_dictionary)
        WITH ORDINALITY AS item(field, ordinal)
    )
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  JOIN LATERAL (
    SELECT stored.*
    FROM app.marketplace_sample_versions AS stored
    WHERE stored.service_template_version_id = version.id
      AND stored.collected_at <= p_as_of
      AND stored.expires_at > p_as_of
      AND NOT EXISTS (
        SELECT 1 FROM app.marketplace_sample_deletions AS deletion
        WHERE deletion.sample_version_id = stored.id
      )
      AND (
        (
          template.slug = 'linkedin-posts'
          AND stored.retention_policy_version = 'linkedin-posts-sample-30d-v1'
          AND (
            (
              stored.source_kind = 'provider_qualification'
              AND stored.state = 'validated_provider_sample'
              AND stored.governance_state = 'formal_agreement_pending_local_demo'
              AND stored.interim_decision_reference =
                'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'
              AND stored.qualification_packet_id =
                '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'::uuid
              AND stored.published_at IS NOT NULL
            )
            OR
            (
              stored.source_kind = 'synthetic_fixture'
              AND stored.state = 'validated_fixture'
              AND stored.governance_state = 'synthetic_fixture'
              AND stored.qualification_packet_id IS NULL
              AND stored.rights_evidence_reference IS NULL
              AND stored.published_at IS NULL
            )
          )
        )
        OR
        (
          template.slug = 'linkedin-people'
          AND stored.sample_version = 1
          AND stored.source_kind = 'synthetic_fixture'
          AND stored.state = 'validated_fixture'
          AND stored.governance_state = 'synthetic_fixture'
          AND stored.qualification_packet_id IS NULL
          AND stored.rights_evidence_reference IS NULL
          AND stored.published_at IS NULL
          AND stored.masking_policy_version =
            'linkedin-people-provider-metadata-pii-mask-v1'
          AND stored.retention_policy_version = 'linkedin-people-sample-30d-v1'
          AND stored.source_metadata_checksum = decode(
            '9b3b7be895b1e063363e46e205c1f9e46864011e6ee76e666ac8a27e0d7a86eb',
            'hex'
          )
          AND jsonb_array_length(stored.field_dictionary) = 42
        )
      )
    ORDER BY
      (stored.source_kind = 'provider_qualification') DESC,
      stored.sample_version DESC,
      stored.id ASC
    LIMIT 1
  ) AS sample ON true
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE p_as_of IS NOT NULL
    AND (p_template_slug IS NULL OR template.slug = p_template_slug)
    AND template.slug IN ('linkedin-posts', 'linkedin-people')
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND version.presentation_metadata ? 'provider_record_count'
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled'
  ORDER BY template.slug;
$function$;


-- Retained helper: resolve_marketplace_sample_ingestion_target
CREATE OR REPLACE FUNCTION app.resolve_marketplace_sample_ingestion_target(p_template_slug text, p_template_version integer)
 RETURNS TABLE(template_version_id uuid, template_slug text, template_version integer, metadata_checksum bytea)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
  SELECT
    version.id,
    template.slug,
    version.version,
    decode(version.presentation_metadata->>'sample_metadata_checksum','hex')
  FROM app.service_templates AS template
  JOIN app.service_template_versions AS version
    ON version.service_template_id = template.id
  JOIN app.adapter_versions AS adapter
    ON adapter.id = version.adapter_version_id
  JOIN app.adapter_definitions AS definition
    ON definition.id = adapter.adapter_definition_id
  WHERE p_template_slug = 'linkedin-posts'
    AND p_template_version = 1
    AND template.slug = p_template_slug
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = p_template_version
    AND version.availability_state = 'coming_soon'
    AND version.effective_at IS NULL
    AND version.published_at IS NULL
    AND version.presentation_metadata->>'sample_metadata_checksum' ~ '^[0-9a-f]{64}$'
    AND definition.code = 'bright_data.marketplace.catalogue'
    AND adapter.semantic_version = '1.0.0-m2'
    AND adapter.state = 'disabled';
$function$;


-- Retained helper: complete_marketplace_sample_download
CREATE OR REPLACE FUNCTION app.complete_marketplace_sample_download(p_authorization_id uuid, p_download_expires_at timestamp with time zone, p_request_id uuid, p_ip_fingerprint bytea)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
DECLARE
  tenant uuid := app.current_tenant_id();
  authorization_row app.marketplace_sample_download_authorizations%ROWTYPE;
BEGIN
  SELECT candidate.* INTO authorization_row
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = tenant AND candidate.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND OR authorization_row.state <> 'reserved'
     OR p_download_expires_at IS NULL OR p_download_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_STALE' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.resolve_marketplace_sample_preview(
      authorization_row.template_slug, statement_timestamp()
    ) AS preview
    WHERE preview.sample_version = authorization_row.sample_version
      AND preview.template_version = authorization_row.template_version
  ) THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_STALE' USING ERRCODE = '55000';
  END IF;

  UPDATE app.marketplace_sample_download_authorizations
  SET state = 'authorized', authorized_at = clock_timestamp(),
      download_expires_at = p_download_expires_at,
      request_id = p_request_id, ip_fingerprint = p_ip_fingerprint
  WHERE tenant_id = tenant AND id = p_authorization_id;

  INSERT INTO app.audit_events (
    tenant_id, actor_user_id, action, target_type,
    target_id, outcome, request_id, ip_fingerprint, safe_diff
  ) VALUES (
    tenant, authorization_row.actor_user_id,
    'marketplace.sample_download_authorize', 'marketplace_sample_download',
    authorization_row.id, 'authorized', p_request_id, p_ip_fingerprint,
    jsonb_build_object(
      'template_slug', authorization_row.template_slug,
      'template_version', authorization_row.template_version,
      'sample_version', authorization_row.sample_version,
      'format', authorization_row.format,
      'selected_fields', authorization_row.selected_fields,
      'record_limit', authorization_row.record_limit,
      'record_count', authorization_row.record_count,
      'byte_count', authorization_row.byte_count,
      'checksum', encode(authorization_row.checksum, 'hex'),
      'projection_fingerprint', encode(authorization_row.projection_fingerprint, 'hex'),
      'delivery_method', 'signed_object_url',
      'provider_calls', 0
    )
  );
END;
$function$;


-- Retained helper: create_marketplace_expert_enquiry
CREATE OR REPLACE FUNCTION app.create_marketplace_expert_enquiry(p_enquiry_id uuid, p_actor_user_id uuid, p_actor_api_key_id uuid, p_actor_fingerprint bytea, p_idempotency_key text, p_request_hash bytea, p_template_slug text, p_expected_template_version integer, p_request_id uuid, p_ip_fingerprint bytea)
 RETURNS TABLE(disposition text, enquiry_id uuid, template_slug text, template_version integer, enquiry_state text, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
DECLARE
  tenant uuid := app.current_tenant_id();
  preview record;
  resolved_template_version_id uuid;
  existing app.marketplace_expert_enquiries%ROWTYPE;
BEGIN
  IF tenant IS NULL
     OR p_enquiry_id IS NULL
     OR p_actor_user_id IS NULL OR p_actor_api_key_id IS NOT NULL
     OR p_actor_fingerprint IS NULL OR octet_length(p_actor_fingerprint) <> 32
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32
     OR p_template_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     OR p_expected_template_version IS NULL OR p_expected_template_version < 1
     OR (p_ip_fingerprint IS NOT NULL AND octet_length(p_ip_fingerprint) <> 32) THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO preview
  FROM app.resolve_marketplace_sample_preview(
    p_template_slug,
    statement_timestamp()
  ) AS candidate;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  IF preview.template_version <> p_expected_template_version THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_STALE'
      USING ERRCODE = '55000';
  END IF;

  SELECT version.id INTO resolved_template_version_id
  FROM app.service_template_versions AS version
  WHERE version.service_template_id = preview.template_id
    AND version.version = preview.template_version;

  IF resolved_template_version_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_EXPERT_ENQUIRY_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 0));

  SELECT candidate.* INTO existing
  FROM app.marketplace_expert_enquiries AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing.actor_fingerprint <> p_actor_fingerprint
       OR existing.request_hash <> p_request_hash THEN
      RETURN QUERY SELECT
        'conflict'::text,
        existing.id,
        existing.template_slug,
        existing.template_version,
        existing.state,
        existing.created_at;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      'replay'::text,
      existing.id,
      existing.template_slug,
      existing.template_version,
      existing.state,
      existing.created_at;
    RETURN;
  END IF;

  SELECT candidate.* INTO existing
  FROM app.marketplace_expert_enquiries AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.service_template_version_id = resolved_template_version_id
    AND candidate.state IN ('received', 'in_review', 'contacted')
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT
      'existing'::text,
      existing.id,
      existing.template_slug,
      existing.template_version,
      existing.state,
      existing.created_at;
    RETURN;
  END IF;

  INSERT INTO app.marketplace_expert_enquiries (
    id,
    tenant_id,
    service_template_version_id,
    actor_user_id,
    actor_fingerprint,
    idempotency_key,
    request_hash,
    template_slug,
    template_version,
    state,
    request_id,
    ip_fingerprint
  ) VALUES (
    p_enquiry_id,
    tenant,
    resolved_template_version_id,
    p_actor_user_id,
    p_actor_fingerprint,
    p_idempotency_key,
    p_request_hash,
    p_template_slug,
    preview.template_version,
    'received',
    p_request_id,
    p_ip_fingerprint
  )
  RETURNING * INTO existing;

  INSERT INTO app.audit_events (
    tenant_id,
    actor_user_id,
    action,
    target_type,
    target_id,
    outcome,
    request_id,
    ip_fingerprint,
    safe_diff
  ) VALUES (
    tenant,
    p_actor_user_id,
    'marketplace.expert_enquiry.create',
    'marketplace_expert_enquiry',
    p_enquiry_id,
    'received',
    p_request_id,
    p_ip_fingerprint,
    jsonb_build_object(
      'template_slug', p_template_slug,
      'template_version', preview.template_version,
      'provider_calls', 0,
      'payment_created', false,
      'entitlement_created', false,
      'service_created', false,
      'run_created', false,
      'outbox_event_created', false
    )
  );

  RETURN QUERY SELECT
    'created'::text,
    existing.id,
    existing.template_slug,
    existing.template_version,
    existing.state,
    existing.created_at;
END;
$function$;


-- Retained helper: reserve_marketplace_sample_download
CREATE OR REPLACE FUNCTION app.reserve_marketplace_sample_download(p_authorization_id uuid, p_actor_user_id uuid, p_actor_api_key_id uuid, p_actor_fingerprint bytea, p_idempotency_key text, p_request_hash bytea, p_template_slug text, p_expected_sample_version integer, p_format text, p_selected_fields jsonb, p_projection_fingerprint bytea, p_record_limit integer, p_record_count integer, p_object_key text, p_content_type text, p_file_name text, p_byte_count bigint, p_checksum bytea, p_rate_limit_max integer, p_rate_window_seconds integer)
 RETURNS TABLE(disposition text, authorization_id uuid, stored_state text, stored_object_key text, stored_content_type text, stored_file_name text, stored_byte_count bigint, stored_checksum bytea, stored_record_count integer, stored_download_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
DECLARE
  tenant uuid := app.current_tenant_id();
  manifest record;
  sample_id uuid;
  existing app.marketplace_sample_download_authorizations%ROWTYPE;
BEGIN
  IF tenant IS NULL
     OR p_authorization_id IS NULL
     OR p_actor_user_id IS NULL OR p_actor_api_key_id IS NOT NULL
     OR p_actor_fingerprint IS NULL OR octet_length(p_actor_fingerprint) <> 32
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_request_hash IS NULL OR octet_length(p_request_hash) <> 32
     OR p_projection_fingerprint IS NULL OR octet_length(p_projection_fingerprint) <> 32
     OR p_expected_sample_version IS NULL OR p_expected_sample_version < 1
     OR p_format NOT IN ('json', 'csv')
     OR jsonb_typeof(p_selected_fields) <> 'array' OR jsonb_array_length(p_selected_fields) < 1
     OR p_record_limit IS NULL OR p_record_limit NOT BETWEEN 1 AND 100
     OR p_record_count IS NULL OR p_record_count NOT BETWEEN 0 AND p_record_limit
     OR p_byte_count IS NULL OR p_byte_count < 1
     OR p_checksum IS NULL OR octet_length(p_checksum) <> 32
     OR p_rate_limit_max IS NULL OR p_rate_limit_max NOT BETWEEN 1 AND 10000
     OR p_rate_window_seconds IS NULL OR p_rate_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT preview.* INTO manifest
  FROM app.resolve_marketplace_sample_preview(p_template_slug, statement_timestamp()) AS preview
  WHERE preview.sample_version = p_expected_sample_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- resolve_marketplace_sample_preview exposes the public Service Template ID,
  -- so resolve the immutable version identity explicitly before authorizing
  -- bytes from the private sample object.
  SELECT sample.id INTO sample_id
  FROM app.marketplace_sample_versions AS sample
  JOIN app.service_template_versions AS version
    ON version.id = sample.service_template_version_id
  WHERE version.service_template_id = manifest.template_id
    AND version.version = manifest.template_version
    AND sample.sample_version = manifest.sample_version
    AND sample.object_key = manifest.sample_object_key;

  IF sample_id IS NULL THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 0));

  SELECT candidate.* INTO existing
  FROM app.marketplace_sample_download_authorizations AS candidate
  WHERE candidate.tenant_id = tenant
    AND candidate.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing.actor_fingerprint <> p_actor_fingerprint
       OR existing.request_hash <> p_request_hash THEN
      RETURN QUERY SELECT 'conflict'::text, existing.id, existing.state,
        existing.object_key, existing.content_type, existing.file_name,
        existing.byte_count, existing.checksum, existing.record_count,
        existing.download_expires_at;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'replay'::text, existing.id, existing.state,
      existing.object_key, existing.content_type, existing.file_name,
      existing.byte_count, existing.checksum, existing.record_count,
      existing.download_expires_at;
    RETURN;
  END IF;

  IF (
    SELECT count(*)
    FROM app.marketplace_sample_download_authorizations AS recent
    WHERE recent.tenant_id = tenant
      AND recent.state IN ('reserved', 'authorized')
      AND recent.created_at >= clock_timestamp() - make_interval(secs => p_rate_window_seconds)
  ) >= p_rate_limit_max THEN
    RAISE EXCEPTION 'MARKETPLACE_SAMPLE_DOWNLOAD_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.marketplace_sample_download_authorizations (
    id, tenant_id, sample_version_id, actor_user_id,
    actor_fingerprint, idempotency_key, request_hash, template_slug,
    template_version, sample_version, format, selected_fields,
    projection_fingerprint, record_limit, record_count, object_key,
    content_type, file_name, byte_count, checksum, state, request_id,
    ip_fingerprint
  ) VALUES (
    p_authorization_id, tenant, sample_id, p_actor_user_id,
    p_actor_fingerprint, p_idempotency_key, p_request_hash, p_template_slug,
    manifest.template_version, manifest.sample_version, p_format,
    p_selected_fields, p_projection_fingerprint, p_record_limit,
    p_record_count, p_object_key, p_content_type, p_file_name, p_byte_count,
    p_checksum, 'reserved', NULL, NULL
  );

  RETURN QUERY SELECT 'created'::text, p_authorization_id, 'reserved'::text,
    p_object_key, p_content_type, p_file_name, p_byte_count, p_checksum,
    p_record_count, NULL::timestamptz;
END;
$function$;

DO $helper_equivalence$
BEGIN
 IF EXISTS(
 (SELECT value FROM refactor_0070_preview_before EXCEPT ALL
 SELECT to_jsonb(p)-'presentation_metadata'
 FROM app.resolve_marketplace_sample_preview(NULL,transaction_timestamp()) p)
 UNION ALL
 (SELECT to_jsonb(p)-'presentation_metadata'
 FROM app.resolve_marketplace_sample_preview(NULL,transaction_timestamp()) p EXCEPT ALL
 SELECT value FROM refactor_0070_preview_before))
 OR EXISTS(
 (SELECT version_id,value FROM refactor_0070_contact_before EXCEPT ALL
 SELECT v.id,to_jsonb(m) FROM app.service_template_versions v CROSS JOIN LATERAL
 app.resolve_marketplace_contact_modes(v.service_template_id,v.version) m)
 UNION ALL
 (SELECT v.id,to_jsonb(m) FROM app.service_template_versions v CROSS JOIN LATERAL
 app.resolve_marketplace_contact_modes(v.service_template_id,v.version) m EXCEPT ALL
 SELECT version_id,value FROM refactor_0070_contact_before)) THEN
  RAISE EXCEPTION 'Preview/contact helper responses changed';
 END IF;
END
$helper_equivalence$;

-- 3. Retire only the enumerated archive routines, including old qualification/
-- metadata-based sample-creation callers. Existing stored-sample retention and
-- cleanup helpers survive. Their replacement creation path requires matched
-- operator code; the launcher refuses remaining runtime references.
DROP FUNCTION
 app.accept_amazon_provider_qualification(p_qualification_id uuid, p_mapping_id uuid, p_mapping_ciphertext bytea, p_mapping_fingerprint bytea, p_output_policy jsonb, p_commercial_config_version text, p_config_version text, p_restricted_reference text, p_evidence_hash bytea, p_reviewer text, p_expires_at timestamp with time zone),
 app.accept_amazon_provider_qualification_v2(p_qualification_id uuid, p_mapping_id uuid, p_mapping_ciphertext bytea, p_mapping_fingerprint bytea, p_output_policy jsonb, p_commercial_config_version text, p_config_version text, p_restricted_reference text, p_evidence_hash bytea, p_reviewer text, p_expires_at timestamp with time zone),
 app.accept_amazon_provider_qualification_v3(p_qualification_id uuid, p_mapping_id uuid, p_mapping_ciphertext bytea, p_mapping_fingerprint bytea, p_output_policy jsonb, p_commercial_config_version text, p_config_version text, p_restricted_reference text, p_evidence_hash bytea, p_reviewer text, p_expires_at timestamp with time zone),
 app.authorize_marketplace_qualification_packet(p_packet_id uuid, p_request_fingerprint bytea, p_records_limit bigint, p_maximum_estimated_cost_micros bigint, p_currency_code text, p_maximum_provider_submissions integer, p_automatic_submission_retries integer, p_authorization_reference text, p_authorization_hash bytea, p_issuer text, p_effective_at timestamp with time zone, p_expires_at timestamp with time zone),
 app.begin_amazon_provider_qualification(p_qualification_id uuid, p_candidate_id uuid, p_operation_code text, p_environment text, p_request_object_key text, p_request_checksum bytea, p_actor text),
 app.begin_amazon_provider_qualification_v2(p_qualification_id uuid, p_candidate_id uuid, p_operation_code text, p_environment text, p_provider_execution_mode text, p_request_object_key text, p_request_checksum bytea, p_actor text),
 app.begin_amazon_provider_qualification_v3(p_qualification_id uuid, p_candidate_id uuid, p_operation_code text, p_environment text, p_provider_execution_mode text, p_request_object_key text, p_request_checksum bytea, p_actor text),
 app.begin_amazon_scraper_catalog_import(p_import_id uuid, p_environment text, p_actor text, p_restricted_reference text),
 app.begin_amazon_scraper_catalog_import_v2(p_import_id uuid, p_environment text, p_actor text, p_restricted_reference text),
 app.begin_marketplace_catalog_import(p_import_id uuid, p_environment text, p_actor text, p_restricted_reference text),
 app.claim_marketplace_qualification_submission(p_packet_id uuid, p_request_fingerprint bytea, p_actor text),
 app.complete_amazon_provider_qualification(p_qualification_id uuid, p_state text, p_submission_mode text, p_response_object_key text, p_response_checksum bytea, p_response_content_type text, p_response_byte_count bigint, p_record_count integer, p_snapshot_ciphertext bytea, p_snapshot_fingerprint bytea, p_safe_error_code text, p_actor text),
 app.complete_amazon_scraper_catalog_import(p_import_id uuid, p_candidates jsonb, p_evidence_object_key text, p_evidence_checksum bytea, p_actor text),
 app.complete_marketplace_catalog_import(p_import_id uuid, p_candidates jsonb, p_evidence_object_key text, p_evidence_checksum bytea, p_actor text),
 app.complete_marketplace_qualification_failure(p_packet_id uuid, p_execution_state text, p_safe_error_code text, p_observed_cost_micros bigint, p_currency_code text, p_actor text),
 app.complete_marketplace_qualification_success(p_packet_id uuid, p_raw_object_key text, p_raw_checksum bytea, p_raw_content_type text, p_raw_byte_count bigint, p_raw_record_count integer, p_normalized_object_key text, p_normalized_checksum bytea, p_normalized_content_type text, p_normalized_byte_count bigint, p_normalized_record_count integer, p_observed_cost_micros bigint, p_currency_code text, p_actor text, p_outcome_class text),
 app.destroy_due_response_envelopes(p_limit integer),
 app.fail_amazon_scraper_catalog_import(p_import_id uuid, p_safe_error_code text, p_actor text),
 app.fail_marketplace_catalog_import(p_import_id uuid, p_safe_error_code text, p_actor text),
 app.prepare_marketplace_qualification_packet(p_packet_id uuid, p_candidate_id uuid, p_template_version_id uuid, p_filter_adapter_version_id uuid, p_environment text, p_provider_resource_fingerprint bytea, p_exact_request jsonb, p_maximum_estimated_cost_micros bigint, p_currency_code text, p_maximum_provider_submissions integer, p_automatic_submission_retries integer, p_poll_deadline_ms integer, p_expected_evidence text[], p_actor text),
 app.publish_qualified_amazon_operation_v1(p_expected_environment text, p_qualification_id uuid, p_restricted_reference text, p_evidence_hash bytea, p_reviewer text, p_reason text, p_expires_at timestamp with time zone),
 app.record_linkedin_people_contact_contract(p_packet_id uuid, p_candidate_id uuid, p_template_version_id uuid, p_contract_version integer, p_evidence_object_key text, p_evidence_checksum bytea, p_evidence_byte_count bigint, p_faq_evidence_object_key text, p_search_evidence_object_key text, p_provider_resource_ciphertext bytea, p_provider_resource_fingerprint bytea, p_faq_source_uri text, p_faq_checksum bytea, p_search_source_uri text, p_search_checksum bytea, p_source_observed_on date, p_restricted_reference text, p_contact_modes jsonb, p_provider_calls integer, p_actor text),
 app.record_linkedin_people_metadata_observation(p_observation_id uuid, p_candidate_id uuid, p_evidence_object_key text, p_metadata_checksum bytea, p_byte_count bigint, p_field_count integer, p_content_type text, p_restricted_reference text, p_actor text),
 app.record_linkedin_people_synthetic_sample_v1(p_sample_id uuid, p_observation_id uuid, p_template_version_id uuid, p_sample_version integer, p_object_key text, p_record_count integer, p_byte_count bigint, p_checksum bytea, p_metadata_checksum bytea, p_field_dictionary jsonb, p_collected_at timestamp with time zone, p_expires_at timestamp with time zone, p_actor text),
 app.record_linkedin_people_synthetic_sample_v2(p_sample_id uuid, p_observation_id uuid, p_template_version_id uuid, p_sample_version integer, p_object_key text, p_record_count integer, p_byte_count bigint, p_checksum bytea, p_metadata_checksum bytea, p_field_dictionary jsonb, p_actor text),
 app.record_marketplace_provider_sample_v1(p_sample_id uuid, p_packet_id uuid, p_template_version_id uuid, p_sample_version integer, p_object_key text, p_record_count integer, p_byte_count bigint, p_checksum bytea, p_metadata_checksum bytea, p_field_dictionary jsonb, p_interim_decision_reference text, p_collected_at timestamp with time zone, p_expires_at timestamp with time zone, p_actor text),
 app.record_marketplace_provider_sample_v2(p_sample_id uuid, p_packet_id uuid, p_template_version_id uuid, p_sample_version integer, p_object_key text, p_record_count integer, p_byte_count bigint, p_checksum bytea, p_metadata_checksum bytea, p_field_dictionary jsonb, p_interim_decision_reference text, p_actor text),
 app.record_marketplace_qualification_poll_checkpoint(p_packet_id uuid, p_provider_status text, p_safe_error_code text, p_actor text),
 app.record_marketplace_qualification_snapshot_reference(p_packet_id uuid, p_snapshot_ciphertext bytea, p_snapshot_fingerprint bytea, p_actor text),
 app.record_marketplace_qualification_submission_start(p_packet_id uuid, p_request_object_key text, p_request_checksum bytea, p_request_content_type text, p_request_byte_count bigint, p_actor text),
 app.register_marketplace_export_candidate_v1(p_packet_id uuid, p_mapping_id uuid, p_provider_resource_ciphertext bytea, p_provider_resource_fingerprint bytea, p_actor text, p_evidence_reference text, p_reason text),
 app.reject_amazon_provider_qualification(p_qualification_id uuid, p_reason text, p_reviewer text),
 app.resolve_amazon_qualification_acceptance_plan(p_qualification_id uuid),
 app.resolve_amazon_qualification_acceptance_plan_v2(p_qualification_id uuid),
 app.resolve_amazon_qualification_acceptance_plan_v3(p_qualification_id uuid),
 app.resolve_amazon_qualification_candidate(p_candidate_id uuid, p_operation_code text, p_environment text),
 app.resolve_amazon_qualification_candidate_v2(p_candidate_id uuid, p_operation_code text, p_environment text),
 app.resolve_linkedin_people_contact_contract_candidate(p_candidate_id uuid),
 app.resolve_linkedin_people_metadata_candidate(p_candidate_id uuid),
 app.resolve_linkedin_people_synthetic_sample_source(),
 app.resolve_marketplace_export_candidate_source(p_packet_id uuid, p_mapping_id uuid),
 app.resolve_marketplace_provider_sample_source(p_packet_id uuid),
 app.resolve_marketplace_qualification_context(p_candidate_id uuid, p_environment text),
 app.review_amazon_scraper_catalog_candidate(p_candidate_id uuid, p_decision text, p_actor text),
 app.review_marketplace_catalog_candidate(p_candidate_id uuid, p_decision text, p_actor text)
RESTRICT;
DROP VIEW app.due_response_envelopes RESTRICT;
DROP POLICY idempotency_records_envelope_owner_select ON app.idempotency_records;
DROP POLICY idempotency_records_envelope_owner_update ON app.idempotency_records;
DROP INDEX app.idempotency_records_live_envelope_deadline_idx;
-- Target section 9 retires the janitor grants in this database in 0070.
-- Object ACLs disappear with the drops; revoke its remaining schema grant.
-- The cluster-wide role/login and password remain unchanged.
REVOKE USAGE ON SCHEMA app FROM dhumi_envelope_janitor;
-- Preserve all replay/completion rules except the obsolete envelope-null tests.
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_cancel_semantics_check,
 ADD CONSTRAINT idempotency_records_run_cancel_semantics_check CHECK (operation_code <> 'runs.cancel'::text OR scope_kind = 'tenant'::text AND (state = 'in_progress'::text AND response_status IS NULL AND resource_type IS NULL AND resource_id IS NULL AND related_resource_id IS NULL AND response_body_reference IS NULL AND response_body IS NULL AND completed_at IS NULL OR state = 'completed'::text AND response_status = 202 AND resource_type = 'run'::text AND resource_id IS NOT NULL AND related_resource_id IS NULL AND response_body_reference = 'inline_json_v1'::text AND response_body IS NOT NULL AND response_body ?& ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text] AND (response_body - ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text]) = '{}'::jsonb AND (response_body ->> 'id'::text) = resource_id::text AND jsonb_typeof(response_body -> 'service_id'::text) = 'string'::text AND (response_body ->> 'status'::text) = 'queued'::text AND (response_body -> 'error_code'::text) = 'null'::jsonb AND (response_body -> 'retryable'::text) = 'false'::jsonb AND jsonb_typeof(response_body -> 'created_at'::text) = 'string'::text AND jsonb_typeof(response_body -> 'updated_at'::text) = 'string'::text AND (response_body -> 'completed_at'::text) = 'null'::jsonb AND completed_at IS NOT NULL));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_create_semantics_check,
 ADD CONSTRAINT idempotency_records_run_create_semantics_check CHECK (operation_code <> 'runs.create'::text OR scope_kind = 'tenant'::text AND (state = 'in_progress'::text AND response_status IS NULL AND resource_type IS NULL AND resource_id IS NULL AND related_resource_id IS NULL AND response_body_reference IS NULL AND response_body IS NULL AND completed_at IS NULL OR state = 'completed'::text AND response_status = 202 AND resource_type = 'run'::text AND resource_id IS NOT NULL AND related_resource_id IS NULL AND response_body_reference = 'inline_json_v1'::text AND response_body IS NOT NULL AND (response_body - ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text]) = '{}'::jsonb AND (response_body ->> 'run_id'::text) = resource_id::text AND (response_body ->> 'status'::text) = 'queued'::text AND jsonb_typeof(response_body -> 'accepted_at'::text) = 'string'::text AND completed_at IS NOT NULL));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_retry_semantics_check,
 ADD CONSTRAINT idempotency_records_run_retry_semantics_check CHECK (operation_code <> 'runs.retry'::text OR scope_kind = 'tenant'::text AND (state = 'in_progress'::text AND response_status IS NULL AND resource_type IS NULL AND resource_id IS NULL AND related_resource_id IS NULL AND response_body_reference IS NULL AND response_body IS NULL AND completed_at IS NULL OR state = 'completed'::text AND response_status = 202 AND resource_type = 'run'::text AND resource_id IS NOT NULL AND related_resource_id IS NOT NULL AND resource_id <> related_resource_id AND response_body_reference = 'inline_json_v1'::text AND response_body IS NOT NULL AND response_body ?& ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text] AND (response_body - ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text]) = '{}'::jsonb AND (response_body ->> 'run_id'::text) = resource_id::text AND (response_body ->> 'status'::text) = 'queued'::text AND jsonb_typeof(response_body -> 'accepted_at'::text) = 'string'::text AND completed_at IS NOT NULL));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_service_create_semantics_check,
 ADD CONSTRAINT idempotency_records_service_create_semantics_check CHECK (operation_code <> 'services.create'::text OR scope_kind = 'tenant'::text AND (state = 'in_progress'::text AND response_status IS NULL AND resource_type IS NULL AND resource_id IS NULL AND related_resource_id IS NULL AND response_body_reference IS NULL AND response_body IS NULL AND completed_at IS NULL OR state = 'completed'::text AND response_status = 201 AND resource_type = 'service'::text AND resource_id IS NOT NULL AND related_resource_id IS NULL AND response_body_reference = 'inline_json_v1'::text AND response_body IS NOT NULL AND response_body ? 'id'::text AND (response_body ->> 'id'::text) = resource_id::text AND completed_at IS NOT NULL));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_response_envelope_semantics_check;
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_response_envelope_state_check;

-- Preserve retained RLS predicates; remove retired-feature insert policies.
ALTER POLICY audit_events_amazon_input_v4_definer_insert ON app.audit_events WITH CHECK ((tenant_id IS NULL) AND (actor_user_id IS NULL) AND (request_id IS NULL) AND (ip_fingerprint IS NULL) AND (action = 'provider.operation.input_contract.publish'::text) AND (target_type = 'service_template_version'::text) AND (target_id IS NOT NULL));
DROP POLICY audit_events_amazon_qualification_definer_insert ON app.audit_events;
DROP POLICY audit_events_amazon_release_definer_insert ON app.audit_events;
DROP POLICY audit_events_linkedin_people_metadata_observation_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_contact_contract_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_export_candidate_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_provider_sample_definer_insert ON app.audit_events;
ALTER POLICY audit_events_marketplace_provider_sample_expiry_definer_insert ON app.audit_events WITH CHECK ((tenant_id IS NULL) AND (actor_user_id IS NULL) AND (request_id IS NULL) AND (ip_fingerprint IS NULL) AND (action = 'marketplace.provider_sample.expire'::text) AND (target_type = 'marketplace_sample_version'::text) AND (target_id IS NOT NULL));
DROP POLICY audit_events_marketplace_qualification_preflight_insert ON app.audit_events;
ALTER POLICY audit_events_marketplace_sample_expiry_definer_insert ON app.audit_events WITH CHECK ((tenant_id IS NULL) AND (actor_user_id IS NULL) AND (request_id IS NULL) AND (ip_fingerprint IS NULL) AND (action = 'marketplace.sample_fixture.expire'::text) AND (target_type = 'marketplace_sample_version'::text) AND (target_id IS NOT NULL));
ALTER POLICY audit_events_marketplace_sample_fixture_definer_insert ON app.audit_events WITH CHECK ((tenant_id IS NULL) AND (actor_user_id IS NULL) AND (request_id IS NULL) AND (ip_fingerprint IS NULL) AND (action = 'marketplace.sample_fixture.ingest'::text) AND (target_type = 'marketplace_sample_version'::text) AND (target_id IS NOT NULL));
ALTER POLICY audit_events_shared_scraper_draft_insert ON app.audit_events WITH CHECK ((tenant_id IS NULL) AND (actor_user_id IS NULL) AND (request_id IS NULL) AND (ip_fingerprint IS NULL) AND (action = 'scraper.operation.stage'::text) AND (target_type = 'service_template_version'::text) AND (target_id IS NOT NULL));

ALTER TABLE app.audit_events
 DROP CONSTRAINT audit_events_actor_api_key_tenant_fk,
 DROP CONSTRAINT audit_events_at_most_one_actor_check,
 DROP COLUMN actor_api_key_id RESTRICT;
ALTER TABLE app.service_versions
 DROP CONSTRAINT service_versions_creator_api_key_tenant_fk,
 DROP CONSTRAINT service_versions_exactly_one_creator_check,
 ADD CONSTRAINT service_versions_browser_creator_check CHECK(created_by_user_id IS NOT NULL),
 DROP COLUMN created_by_api_key_id RESTRICT;
ALTER TABLE app.marketplace_sample_download_authorizations
 DROP CONSTRAINT marketplace_sample_download_actor_api_key_tenant_fk,
 DROP CONSTRAINT marketplace_sample_download_actor_check,
 ADD CONSTRAINT marketplace_sample_download_browser_actor_check CHECK(actor_user_id IS NOT NULL),
 DROP COLUMN actor_api_key_id RESTRICT;
ALTER TABLE app.marketplace_expert_enquiries
 DROP CONSTRAINT marketplace_expert_enquiry_actor_api_key_tenant_fk,
 DROP CONSTRAINT marketplace_expert_enquiry_actor_check,
 ADD CONSTRAINT marketplace_expert_enquiry_browser_actor_check CHECK(actor_user_id IS NOT NULL),
 DROP COLUMN actor_api_key_id RESTRICT;
ALTER TABLE app.idempotency_records
 DROP COLUMN response_envelope_ciphertext RESTRICT,
 DROP COLUMN response_envelope_key_reference RESTRICT,
 DROP COLUMN response_envelope_recoverable_until RESTRICT,
 DROP COLUMN response_envelope_destroyed_at RESTRICT;
-- Historical source UUID remains unchanged on retained samples until 0074.
ALTER TABLE app.marketplace_sample_versions
 DROP CONSTRAINT marketplace_sample_versions_qualification_packet_id_fkey;
DROP TABLE app.marketplace_export_candidates RESTRICT;
DROP TABLE app.marketplace_qualification_poll_checkpoints RESTRICT;
DROP TABLE app.marketplace_qualification_packets RESTRICT;
DROP TABLE app.marketplace_contact_mode_contracts RESTRICT;
DROP TABLE app.marketplace_contact_contract_packets RESTRICT;
DROP TABLE app.marketplace_catalog_metadata_observations RESTRICT;
DROP TABLE app.catalog_import_candidate_observations RESTRICT;
DROP TABLE app.provider_qualification_attempts RESTRICT;
DROP TABLE app.catalog_candidates RESTRICT;
DROP TABLE app.catalog_imports RESTRICT;
DROP TABLE app.platform_api_keys RESTRICT;

-- 4. Refuse surviving references to dropped objects/columns/helper names.
DO $dependencies$
DECLARE pattern text:='\m(marketplace_export_candidates|marketplace_qualification_poll_checkpoints|marketplace_qualification_packets|marketplace_contact_mode_contracts|marketplace_contact_contract_packets|marketplace_catalog_metadata_observations|catalog_import_candidate_observations|provider_qualification_attempts|catalog_candidates|catalog_imports|platform_api_keys|actor_api_key_id|created_by_api_key_id|response_envelope_ciphertext|response_envelope_key_reference|response_envelope_recoverable_until|response_envelope_destroyed_at|accept_amazon_provider_qualification|accept_amazon_provider_qualification_v2|accept_amazon_provider_qualification_v3|authorize_marketplace_qualification_packet|begin_amazon_provider_qualification|begin_amazon_provider_qualification_v2|begin_amazon_provider_qualification_v3|begin_amazon_scraper_catalog_import|begin_amazon_scraper_catalog_import_v2|begin_marketplace_catalog_import|claim_marketplace_qualification_submission|complete_amazon_provider_qualification|complete_amazon_scraper_catalog_import|complete_marketplace_catalog_import|complete_marketplace_qualification_failure|complete_marketplace_qualification_success|destroy_due_response_envelopes|fail_amazon_scraper_catalog_import|fail_marketplace_catalog_import|prepare_marketplace_qualification_packet|publish_qualified_amazon_operation_v1|record_linkedin_people_contact_contract|record_linkedin_people_metadata_observation|record_linkedin_people_synthetic_sample_v1|record_linkedin_people_synthetic_sample_v2|record_marketplace_provider_sample_v1|record_marketplace_provider_sample_v2|record_marketplace_qualification_poll_checkpoint|record_marketplace_qualification_snapshot_reference|record_marketplace_qualification_submission_start|register_marketplace_export_candidate_v1|reject_amazon_provider_qualification|resolve_amazon_qualification_acceptance_plan|resolve_amazon_qualification_acceptance_plan_v2|resolve_amazon_qualification_acceptance_plan_v3|resolve_amazon_qualification_candidate|resolve_amazon_qualification_candidate_v2|resolve_linkedin_people_contact_contract_candidate|resolve_linkedin_people_metadata_candidate|resolve_linkedin_people_synthetic_sample_source|resolve_marketplace_export_candidate_source|resolve_marketplace_provider_sample_source|resolve_marketplace_qualification_context|review_amazon_scraper_catalog_candidate|review_marketplace_catalog_candidate)\M';
BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app' AND p.prosrc ~ pattern)
 OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='app'
 AND (coalesce(qual,'')||coalesce(with_check,'')) ~ pattern) THEN
  RAISE EXCEPTION 'A surviving function/policy still names an archived dependency';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app' AND c.relname IN('marketplace_export_candidates','marketplace_qualification_poll_checkpoints','marketplace_qualification_packets','marketplace_contact_mode_contracts','marketplace_contact_contract_packets','marketplace_catalog_metadata_observations','catalog_import_candidate_observations','provider_qualification_attempts','catalog_candidates','catalog_imports','platform_api_keys'))
 OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='app' AND c.relkind='r')<>32 THEN
  RAISE EXCEPTION '0070 expected exactly 32 surviving app tables';
 END IF;
END
$dependencies$;

DO $reconcile$
DECLARE r record; total bigint; value_hash text;
BEGIN
 FOR r IN SELECT * FROM refactor_0070_retained ORDER BY table_name LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),''''))
   FROM (SELECT md5((to_jsonb(t)-$1)::text) d FROM app.%I t) s',r.table_name)
   INTO total,value_hash USING r.excluded_columns;
  IF total<>r.row_count OR value_hash IS DISTINCT FROM r.digest THEN
   RAISE EXCEPTION 'Retained row/value reconciliation failed: %',r.table_name;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM refactor_0070_tables WHERE force_rls ORDER BY table_name LOOP
  IF to_regclass(format('app.%I',r.table_name)) IS NOT NULL THEN
   EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',r.table_name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM refactor_0070_tables b JOIN pg_namespace n ON n.nspname='app'
 JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=b.table_name
 WHERE c.relrowsecurity IS DISTINCT FROM b.rls
 OR c.relforcerowsecurity IS DISTINCT FROM b.force_rls) THEN
  RAISE EXCEPTION 'A surviving store changed RLS/FORCE state';
 END IF;
END
$reconcile$;
-- migrate.ps1 inserts the exact reviewed file checksum LAST in the same transaction.
-- Later table phases and identity consolidation remain pending.
