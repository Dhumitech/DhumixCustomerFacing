-- REVIEW DRAFT ONLY: 0071 organizations, based on read-only dhumi_test inspection.
-- 2026-10-07. NOT APPLIED; matching source implemented offline; PostgreSQL
-- privilege/write qualification, backup/restore and runner remain pending.
-- Actual code stays in root back-end/front-end. After holds context records only.
-- Body is plain SQL: no psql commands, transaction BEGIN/COMMIT, or ledger INSERT.
-- A future bounded reviewed runner owns the transaction, SHA check and ledger.
-- Owner scope: loopback:5432/dhumi_test only. Keep all eight existing logins and
-- passwords; NO new/altered/dropped cluster roles. Naming cleanup is 0075.
-- Current migration owner is dhumi_owner; the existing admin session must be
-- superuser for full-population migration inspection under FORCE RLS. Its
-- privilege is local to this migration, never assigned to application pools.
-- No RLS/FK/history guard is disabled. No table, user, session or token is deleted.
-- 32 -> 35 tables. Existing rows preserved; 259 token-history + 208 suspension
-- audit facts inserted. No OTP, member, template grant or internal org is seeded.
-- Actual timestamps differ. Preserve source fields in a freshly qualified dump.
-- New session/token checks use a recorded cutover for historical exceptions;
-- runtime INSERT/UPDATE grants exclude created_at, preventing backdated bypass.
-- Four token end times map by STATE, never by a blind COALESCE.

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL idle_in_transaction_session_timeout='60s';
SET LOCAL TimeZone='UTC';
DO $execution_gate$
BEGIN
 IF current_database()<>'dhumi_test' OR inet_server_port() IS DISTINCT FROM 5432
  OR inet_server_addr() IS NULL OR inet_server_addr() NOT IN('127.0.0.1'::inet,'::1'::inet)
  OR current_setting('server_version_num')::int<180000 THEN
  RAISE EXCEPTION '0071 is restricted to local dhumi_test PostgreSQL 18+' USING ERRCODE='55000';
 END IF;
 IF coalesce(current_setting('dhumi.refactor_apply',true),'')<>'0071'
  OR coalesce(current_setting('dhumi.owner_approved',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.backup_restore_verified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.matching_backend_ready',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.organization_privileges_qualified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.write_path_qualified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.processes_stopped',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.queue_compatibility_verified',true),'')<>'yes'
  OR coalesce(current_setting('dhumi.reviewed_sql_sha256',true),'')!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION '0071 draft is blocked: owner, backup, matching code, privilege/write and stopped-process proofs required' USING ERRCODE='55000';
 END IF;
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
  RAISE EXCEPTION '0071 needs the owner-authorized existing migration administrator' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='dhumi_test' AND pid<>pg_backend_pid()
  AND usename LIKE 'dhumi_test_%_login') THEN RAISE EXCEPTION 'Test runtime connections remain'; END IF;
END $execution_gate$;
SET LOCAL ROLE NONE;
SET LOCAL row_security=off;
SELECT pg_advisory_xact_lock(hashtextextended('dhumi_test.refactor.0071',0));
DO $table_locks$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE app.%I IN ACCESS EXCLUSIVE MODE',r.relname);
 END LOOP;
END $table_locks$;
-- Read-only catalog fingerprint; called before preview and after approved cleanup.
SELECT set_config('dhumi.fixture_cleanup_schema', md5(jsonb_build_object(
  'columns', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.table_name,s.attnum) FROM (
    SELECT c.relname table_name,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) data_type,
      a.attnotnull,a.attisdropped,a.attacl,pg_get_expr(d.adbin,d.adrelid) default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='app' AND a.attnum>0) s),
  'relations', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name) FROM (
    SELECT c.relname name,c.relkind,pg_get_userbyid(c.relowner) owner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app') s),
  'constraints', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.table_name,s.name) FROM (
    SELECT c.relname table_name,con.conname name,con.contype,con.convalidated,pg_get_constraintdef(con.oid) definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='app') s),
  'indexes', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.tablename,s.indexname) FROM (
    SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='app') s),
  'policies', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.tablename,s.policyname) FROM (
    SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='app') s),
  'triggers', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.table_name,s.name) FROM (
    SELECT c.relname table_name,t.tgname name,t.tgenabled,pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='app' AND NOT t.tgisinternal) s),
  'functions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name,s.signature) FROM (
    SELECT p.proname name,pg_get_function_identity_arguments(p.oid) signature,
      pg_get_userbyid(p.proowner) owner,p.proacl,md5(pg_get_functiondef(p.oid)) definition_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app') s),
  'schema_acl', (SELECT jsonb_agg(to_jsonb(s)) FROM (
    SELECT pg_get_userbyid(nspowner) owner,nspacl FROM pg_namespace WHERE nspname='app') s)
)::text),true) AS schema_fingerprint;

CREATE TEMP TABLE refactor_0071_source_rows(table_name text PRIMARY KEY,n bigint,digest text) ON COMMIT DROP;
INSERT INTO refactor_0071_source_rows VALUES
 ('adapter_definitions',4,'04aa97e9c7d58af72bc0afb198e7c041'),
 ('adapter_versions',7,'953d355709b7bd018543fef572310a7c'),
 ('artifacts',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('audit_events',18831,'bacb24d2f28aad763d83065ffba86e19'),
 ('auth_refresh_tokens',3357,'6d5f8855be97d1b669e357fb3cf3bfc7'),
 ('auth_sessions',2967,'72fbc6592669d8758c355eac291d7d8f'),
 ('dead_letter_recovery_intents',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('feature_flags',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('idempotency_records',11008,'369f45982e8bace45c00b2f1e37baa4f'),
 ('launch_evidence',26,'62c6f63d2f9ec8e47ca034de22c97832'),
 ('legal_acceptances',10192,'1a13ea2be2487333440c487a453116e2'),
 ('marketplace_expert_enquiries',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('marketplace_sample_deletions',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('marketplace_sample_download_authorizations',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('marketplace_sample_versions',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('outbox_events',10823,'c1acb8874ab02acf84469eb5fbcfc704'),
 ('provider_cost_holds',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('provider_credentials',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('provider_mappings',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('run_attempts',4,'8021c2177ad8cab5a2a52fad4b6b6482'),
 ('run_events',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('run_status_transitions',10,'1e1b865cb1b9207fcd9fad62b9b13839'),
 ('runs',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('schema_migrations',70,'f30d66e4298167c77f5d3ff2bc912b0a'),
 ('service_template_versions',26,'7c4ea72b9d7cb3e91def5380e418377e'),
 ('service_templates',13,'dff7eff4302ee75ef6942c3a41648d36'),
 ('service_versions',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('services',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('tenant_user_access',10192,'b273740cc3e32fe399936d4c4aa83079'),
 ('tenants',10192,'92ed0ea8cd532b862aaf2fb41d36b4a2'),
 ('usage_events',0,'d41d8cd98f00b204e9800998ecf8427e'),
 ('users',10962,'8559b89eda4c85aeac24fbccb2e16cf0');
CREATE TEMP TABLE refactor_0071_source_ledger(version text PRIMARY KEY,checksum text) ON COMMIT DROP;
INSERT INTO refactor_0071_source_ledger VALUES
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
 ('0069_shared_scraper_commercial_capacity','6b729ac9d99717371fe1354c3efa296625b492f07dc008f4706aea8796e9efe5'),
 ('0070_archive','0804b5d0716f47f3e826e9aa4c67e38b8d34e2d83ae284eb7cd2a6b1bfdc297a');
CREATE TEMP TABLE refactor_0071_projection(table_name text PRIMARY KEY,drop_keys text[],new_keys text[]) ON COMMIT DROP;
INSERT INTO refactor_0071_projection VALUES
 ('adapter_definitions',ARRAY[]::text[],ARRAY[]::text[]),
 ('adapter_versions',ARRAY[]::text[],ARRAY[]::text[]),
 ('artifacts',ARRAY[]::text[],ARRAY[]::text[]),
 ('audit_events',ARRAY[]::text[],ARRAY[]::text[]),
 ('auth_refresh_tokens',ARRAY['issued_at','rotated_at','reused_at','revoked_at','expired_at']::text[],ARRAY['ended_at']::text[]),
 ('auth_sessions',ARRAY['issued_at','last_used_at','device_metadata','security_metadata','updated_at']::text[],ARRAY['revoked_reason']::text[]),
 ('dead_letter_recovery_intents',ARRAY[]::text[],ARRAY[]::text[]),
 ('feature_flags',ARRAY[]::text[],ARRAY[]::text[]),
 ('idempotency_records',ARRAY[]::text[],ARRAY[]::text[]),
 ('launch_evidence',ARRAY[]::text[],ARRAY[]::text[]),
 ('legal_acceptances',ARRAY['tenant_id','locale','ip_fingerprint','acceptance_method','created_at']::text[],ARRAY[]::text[]),
 ('marketplace_expert_enquiries',ARRAY[]::text[],ARRAY[]::text[]),
 ('marketplace_sample_deletions',ARRAY[]::text[],ARRAY[]::text[]),
 ('marketplace_sample_download_authorizations',ARRAY[]::text[],ARRAY[]::text[]),
 ('marketplace_sample_versions',ARRAY[]::text[],ARRAY[]::text[]),
 ('outbox_events',ARRAY[]::text[],ARRAY[]::text[]),
 ('provider_cost_holds',ARRAY[]::text[],ARRAY[]::text[]),
 ('provider_credentials',ARRAY[]::text[],ARRAY[]::text[]),
 ('provider_mappings',ARRAY[]::text[],ARRAY[]::text[]),
 ('run_attempts',ARRAY[]::text[],ARRAY[]::text[]),
 ('run_events',ARRAY[]::text[],ARRAY[]::text[]),
 ('run_status_transitions',ARRAY[]::text[],ARRAY[]::text[]),
 ('runs',ARRAY[]::text[],ARRAY[]::text[]),
 ('schema_migrations',ARRAY[]::text[],ARRAY[]::text[]),
 ('service_template_versions',ARRAY[]::text[],ARRAY[]::text[]),
 ('service_templates',ARRAY[]::text[],ARRAY['access']::text[]),
 ('service_versions',ARRAY[]::text[],ARRAY[]::text[]),
 ('services',ARRAY[]::text[],ARRAY[]::text[]),
 ('tenant_user_access',ARRAY['updated_at']::text[],ARRAY['invite_id']::text[]),
 ('tenants',ARRAY['suspension_reason_code','suspension_reference','updated_at']::text[],ARRAY['is_internal','created_by_user_id']::text[]),
 ('usage_events',ARRAY[]::text[],ARRAY[]::text[]),
 ('users',ARRAY['updated_at']::text[],ARRAY[]::text[]);
CREATE TEMP TABLE refactor_0071_retained(table_name text PRIMARY KEY,n bigint,digest text) ON COMMIT DROP;
DO $baseline_gate$ DECLARE r record;n bigint;d text; BEGIN
 IF current_setting('dhumi.fixture_cleanup_schema')<>'3a2b31b1d9d744510fe2544493657d30' THEN
  RAISE EXCEPTION 'Schema/constraints/triggers/privileges drifted from 0071 review'; END IF;
 IF EXISTS((SELECT version,checksum FROM app.schema_migrations EXCEPT SELECT * FROM pg_temp.refactor_0071_source_ledger)
  UNION ALL (SELECT * FROM pg_temp.refactor_0071_source_ledger EXCEPT SELECT version,checksum FROM app.schema_migrations)) THEN
  RAISE EXCEPTION 'Exact 70-entry applied ledger differs'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND c.relkind='r')<>32 THEN RAISE EXCEPTION 'Expected 32 baseline tables'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND t.tgisinternal AND t.tgenabled NOT IN('O','A')) THEN RAISE EXCEPTION 'A baseline constraint trigger is disabled'; END IF;
 IF EXISTS(SELECT 1 FROM app.audit_events WHERE action IN('refactor.0071.refresh_token_history','refactor.0071.suspension_history')) THEN RAISE EXCEPTION '0071 history facts already exist'; END IF;
 FOR r IN SELECT * FROM pg_temp.refactor_0071_source_rows ORDER BY table_name LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),'''')) FROM (SELECT md5(to_jsonb(t)::text) d FROM app.%I t)s',r.table_name) INTO n,d;
  IF n<>r.n OR d<>r.digest THEN RAISE EXCEPTION 'Reviewed source rows changed in %',r.table_name; END IF;
 END LOOP;
END $baseline_gate$;
-- Normalize only planned field removal/rename and membership role/state mapping.
DO $retained_projection$ DECLARE r record;n bigint;d text;e text; BEGIN
 FOR r IN SELECT * FROM pg_temp.refactor_0071_projection ORDER BY table_name LOOP
  e:='to_jsonb(t)-$1';
  IF r.table_name='tenant_user_access' THEN e:='(to_jsonb(t)-$1)||jsonb_build_object(''access_role'',CASE access_role WHEN ''owner'' THEN ''admin'' ELSE access_role END,''state'',CASE state WHEN ''revoked'' THEN ''removed'' ELSE state END)'; END IF;
  IF r.table_name='legal_acceptances' THEN e:='(to_jsonb(t)-$1-''request_id'')||jsonb_build_object(''trace_id'',request_id)'; END IF;
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),'''')) FROM (SELECT md5((%s)::text) d FROM app.%I t)s',e,r.table_name) INTO n,d USING r.drop_keys;
  INSERT INTO pg_temp.refactor_0071_retained VALUES(r.table_name,n,d);
 END LOOP;
END $retained_projection$;
CREATE TEMP TABLE refactor_0071_cutover ON COMMIT DROP AS SELECT clock_timestamp() at;
CREATE TEMP TABLE refactor_0071_creators ON COMMIT DROP AS
WITH a AS(SELECT tenant_id,count(DISTINCT actor_user_id) actors,min(actor_user_id::text)::uuid actor,
 count(*) FILTER(WHERE actor_user_id IS NULL OR target_type<>'tenant' OR target_id IS DISTINCT FROM tenant_id) invalid
 FROM app.audit_events WHERE action='tenant.signup' AND outcome='accepted' GROUP BY tenant_id)
SELECT t.id,a.actor FROM app.tenants t LEFT JOIN a ON a.tenant_id=t.id
WHERE a.actors=1 AND a.invalid=0 AND EXISTS(SELECT 1 FROM app.users u WHERE u.id=a.actor)
 AND EXISTS(SELECT 1 FROM app.tenant_user_access m WHERE m.tenant_id=t.id AND m.user_id=a.actor)
 AND NOT EXISTS(SELECT 1 FROM app.idempotency_records i WHERE i.operation_code='auth.signup' AND i.state='completed'
  AND i.resource_type='tenant' AND i.resource_id=t.id AND (i.related_resource_id IS DISTINCT FROM a.actor
   OR i.scope_kind<>'signup' OR i.tenant_id IS NOT NULL OR i.response_status IS DISTINCT FROM 202 OR i.completed_at IS NULL));
DO $provenance$ BEGIN
 IF EXISTS(SELECT 1 FROM app.tenants t LEFT JOIN pg_temp.refactor_0071_creators c ON c.id=t.id
  WHERE t.state='active' AND (c.actor IS NULL OR NOT EXISTS(SELECT 1 FROM app.tenant_user_access m WHERE m.tenant_id=t.id AND m.state='active' AND m.access_role='owner'))) THEN
  RAISE EXCEPTION 'Active organization creator/admin provenance unresolved'; END IF;
 IF (SELECT count(*) FROM pg_temp.refactor_0071_creators)<>10192 THEN RAISE EXCEPTION 'Reviewed creator reconciliation count changed'; END IF;
END $provenance$;
CREATE TEMP TABLE refactor_0071_token_expected ON COMMIT DROP AS
SELECT id,state,CASE state WHEN 'rotated' THEN rotated_at WHEN 'reused' THEN reused_at
 WHEN 'revoked' THEN revoked_at WHEN 'expired' THEN expired_at END ended_at,
 jsonb_build_object('state',state,'rotated_at',rotated_at,'reused_at',reused_at,'revoked_at',revoked_at,'expired_at',expired_at) history,
 num_nonnulls(rotated_at,reused_at,revoked_at,expired_at)>1 archive_extra FROM app.auth_refresh_tokens;
CREATE TEMP TABLE refactor_0071_session_expected ON COMMIT DROP AS SELECT id,security_metadata->>'revoked_by' revoked_reason FROM app.auth_sessions;
CREATE TEMP TABLE refactor_0071_suspension_expected ON COMMIT DROP AS
SELECT id,jsonb_build_object('suspension_reason_code',suspension_reason_code,'suspension_reference',suspension_reference) history
FROM app.tenants WHERE suspension_reason_code IS NOT NULL OR suspension_reference IS NOT NULL;
DO $value_gates$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_temp.refactor_0071_token_expected WHERE state<>'active' AND ended_at IS NULL) THEN RAISE EXCEPTION 'Terminal token has no state-specific end time'; END IF;
 IF (SELECT count(*) FROM pg_temp.refactor_0071_token_expected WHERE archive_extra)<>259 OR (SELECT count(*) FROM pg_temp.refactor_0071_suspension_expected)<>208 THEN RAISE EXCEPTION 'Historical fact counts differ from review'; END IF;
 IF EXISTS(SELECT 1 FROM app.tenant_user_access WHERE access_role<>'owner' OR state NOT IN('active','revoked')) THEN RAISE EXCEPTION 'Unexpected legacy membership shape'; END IF;
END $value_gates$;

-- Add/backfill before any contraction. Existing touch triggers remain until
-- their last source-column dependency is removed below.
ALTER TABLE app.tenants ADD COLUMN is_internal boolean NOT NULL DEFAULT false,
 ADD COLUMN created_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT;
UPDATE app.tenants t SET created_by_user_id=c.actor FROM pg_temp.refactor_0071_creators c WHERE t.id=c.id;
ALTER TABLE app.auth_sessions ADD COLUMN revoked_reason text;
UPDATE app.auth_sessions s SET revoked_reason=e.revoked_reason FROM pg_temp.refactor_0071_session_expected e WHERE s.id=e.id;
ALTER TABLE app.auth_refresh_tokens ADD COLUMN ended_at timestamptz;
UPDATE app.auth_refresh_tokens t SET ended_at=e.ended_at FROM pg_temp.refactor_0071_token_expected e WHERE t.id=e.id;
ALTER TABLE app.service_templates ADD COLUMN access text NOT NULL DEFAULT 'all'
 CONSTRAINT service_templates_access_check CHECK(access IN('all','selected'));
-- Historical actor remains unknown. Do not attribute suspension to its creator.
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,safe_diff)
SELECT NULL,NULL,'refactor.0071.refresh_token_history','auth_refresh_token',id,'preserved',history
FROM pg_temp.refactor_0071_token_expected WHERE archive_extra;
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,safe_diff)
SELECT id,NULL,'refactor.0071.suspension_history','tenant',id,'preserved',history FROM pg_temp.refactor_0071_suspension_expected;

CREATE TABLE app.organization_invites(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
 email text CHECK(email IS NULL OR(email=lower(btrim(email)) AND length(email)>0)),
 token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 role text NOT NULL DEFAULT 'member' CHECK(role IN('admin','member')),
 max_uses integer CHECK(max_uses IS NULL OR max_uses>0),
 use_count integer NOT NULL DEFAULT 0 CHECK(use_count>=0),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id),CHECK(email IS NULL OR(max_uses IS NOT NULL AND max_uses=1)),
 CHECK(max_uses IS NULL OR use_count<=max_uses),
 CHECK(expires_at>created_at),CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX organization_invites_org_time_idx ON app.organization_invites(organization_id,created_at,id);
CREATE TABLE app.email_verifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 purpose text NOT NULL CHECK(purpose IN('join_organization','create_organization','password_reset')),
 code_hash bytea NOT NULL CHECK(octet_length(code_hash)=32),
 payload jsonb CHECK(payload IS NULL OR(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192)),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,consumed_at timestamptz,trace_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 CHECK(consumed_at IS NULL OR(consumed_at>=created_at AND payload IS NULL))
);
CREATE INDEX email_verifications_user_issuance_idx ON app.email_verifications(user_id,created_at DESC);
CREATE INDEX email_verifications_expiry_idx ON app.email_verifications(expires_at,id);
CREATE TABLE app.organization_templates(
 organization_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
 service_template_id uuid NOT NULL REFERENCES app.service_templates(id) ON DELETE RESTRICT,
 PRIMARY KEY(organization_id,service_template_id)
);
ALTER TABLE app.organization_invites OWNER TO dhumi_owner;
ALTER TABLE app.email_verifications OWNER TO dhumi_owner;
ALTER TABLE app.organization_templates OWNER TO dhumi_owner;
ALTER TABLE app.tenant_user_access ADD COLUMN invite_id uuid,
 ADD CONSTRAINT tenant_user_access_invite_same_org_fk FOREIGN KEY(tenant_id,invite_id)
 REFERENCES app.organization_invites(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE app.tenant_user_access DROP CONSTRAINT tenant_user_access_access_role_check,
 DROP CONSTRAINT tenant_user_access_state_check;
UPDATE app.tenant_user_access SET access_role='admin',state=CASE state WHEN 'revoked' THEN 'removed' ELSE state END;
ALTER TABLE app.tenant_user_access ALTER COLUMN access_role SET DEFAULT 'member',
 ADD CONSTRAINT tenant_user_access_access_role_check CHECK(access_role IN('admin','member')),
 ADD CONSTRAINT tenant_user_access_state_check CHECK(state IN('active','removed'));

-- Only the source signup function references contracted identity columns.
-- Remaining durable Run/sample/catalogue functions are preserved for later phases.
DROP FUNCTION app.create_signup(text,text,text,jsonb,text,bytea,bytea,uuid) RESTRICT;
DROP TRIGGER users_touch_updated_at ON app.users;
DROP TRIGGER tenants_touch_updated_at ON app.tenants;
DROP TRIGGER tenant_user_access_touch_updated_at ON app.tenant_user_access;
DROP TRIGGER auth_sessions_touch_updated_at ON app.auth_sessions;
ALTER TABLE app.users DROP CONSTRAINT users_time_order_check,
 ADD CONSTRAINT users_time_order_check CHECK(email_verified_at IS NULL OR email_verified_at>=created_at);
ALTER TABLE app.tenants DROP CONSTRAINT tenants_time_order_check,DROP CONSTRAINT tenants_suspension_state_check;
ALTER TABLE app.tenant_user_access DROP CONSTRAINT tenant_user_access_time_order_check;
ALTER TABLE app.auth_sessions DROP CONSTRAINT auth_sessions_check,DROP CONSTRAINT auth_sessions_time_order_check;
ALTER TABLE app.auth_refresh_tokens DROP CONSTRAINT auth_refresh_tokens_check,
 ADD CONSTRAINT auth_refresh_tokens_ended_state_check CHECK((state='active' AND ended_at IS NULL) OR(state<>'active' AND ended_at IS NOT NULL));
-- Preserve historical expired/revoked timestamps. Checks become canonical only
-- for newly issued rows. API grants below cannot set/change created_at.
DO $canonical_new_times$ DECLARE cutover timestamptz; BEGIN
 SELECT at INTO cutover FROM pg_temp.refactor_0071_cutover;
 EXECUTE format('ALTER TABLE app.auth_sessions ADD CONSTRAINT auth_sessions_new_time_order_check CHECK(created_at<%L::timestamptz OR(expires_at>created_at AND(revoked_at IS NULL OR revoked_at>=created_at)))',cutover);
 EXECUTE format('ALTER TABLE app.auth_refresh_tokens ADD CONSTRAINT auth_refresh_tokens_new_time_order_check CHECK(created_at<%L::timestamptz OR ended_at IS NULL OR ended_at>=created_at)',cutover);
 EXECUTE format('ALTER TABLE app.tenants ADD CONSTRAINT tenants_new_creator_check CHECK(created_at<%L::timestamptz OR created_by_user_id IS NOT NULL)',cutover);
END $canonical_new_times$;
-- Remove tenant-dependent legal policy/key explicitly, retaining every legal row.
DROP POLICY legal_acceptances_tenant_isolation ON app.legal_acceptances;
ALTER TABLE app.legal_acceptances DROP CONSTRAINT legal_acceptances_user_id_tenant_id_document_type_document__key,
 DROP CONSTRAINT legal_acceptances_tenant_id_fkey;
ALTER TABLE app.legal_acceptances RENAME COLUMN request_id TO trace_id;
ALTER TABLE app.users DROP COLUMN updated_at RESTRICT;
ALTER TABLE app.tenants DROP COLUMN suspension_reason_code RESTRICT,DROP COLUMN suspension_reference RESTRICT,DROP COLUMN updated_at RESTRICT;
ALTER TABLE app.tenant_user_access DROP COLUMN updated_at RESTRICT;
ALTER TABLE app.auth_sessions DROP COLUMN issued_at RESTRICT,DROP COLUMN last_used_at RESTRICT,DROP COLUMN device_metadata RESTRICT,DROP COLUMN security_metadata RESTRICT,DROP COLUMN updated_at RESTRICT;
ALTER TABLE app.auth_refresh_tokens DROP COLUMN issued_at RESTRICT,DROP COLUMN rotated_at RESTRICT,DROP COLUMN reused_at RESTRICT,DROP COLUMN revoked_at RESTRICT,DROP COLUMN expired_at RESTRICT;
ALTER TABLE app.legal_acceptances DROP COLUMN tenant_id RESTRICT,DROP COLUMN locale RESTRICT,DROP COLUMN ip_fingerprint RESTRICT,DROP COLUMN acceptance_method RESTRICT,DROP COLUMN created_at RESTRICT;

CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
 SET search_path=pg_catalog AS $function$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $function$;
ALTER FUNCTION app.current_user_id() OWNER TO dhumi_owner;
REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO dhumi_identity,dhumi_customer_api,dhumi_admission,dhumi_job_manager,dhumi_result_recorder,dhumi_operator,dhumi_owner;
CREATE FUNCTION app.reject_organization_creator_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog AS $function$ BEGIN
 IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN RAISE EXCEPTION 'Organization creator is immutable' USING ERRCODE='55000'; END IF;
 -- UPDATE USING admits an ordinary member's locking SELECT. Only an active
 -- admin may perform an actual customer UPDATE. No SELECT/lock fires a trigger.
 IF current_user='dhumi_customer_api' AND NOT EXISTS(
  SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=OLD.id
   AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active') THEN
  RAISE EXCEPTION 'Organization administrator required' USING ERRCODE='42501';
 END IF;
 RETURN NEW; END $function$;
ALTER FUNCTION app.reject_organization_creator_mutation() OWNER TO dhumi_owner;
REVOKE ALL ON FUNCTION app.reject_organization_creator_mutation() FROM PUBLIC;
CREATE TRIGGER tenants_creator_immutable BEFORE UPDATE ON app.tenants FOR EACH ROW EXECUTE FUNCTION app.reject_organization_creator_mutation();
CREATE FUNCTION app.guard_organization_membership_update() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog AS $function$ BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Membership identity/history is immutable' USING ERRCODE='55000';
 END IF;
 IF current_user='dhumi_identity' AND (OLD.state<>'removed' OR NEW.state<>'active') THEN
  -- Fresh proof permits reactivation only. An active join is a locking read,
  -- never an UPDATE; its role, invitation and original time stay unchanged.
  RAISE EXCEPTION 'Only removed memberships may be reactivated' USING ERRCODE='42501';
 END IF;
 IF current_user='dhumi_customer_api' AND NOT EXISTS(
  SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=OLD.tenant_id
   AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active') THEN
  RAISE EXCEPTION 'Organization administrator required' USING ERRCODE='42501';
 END IF;
 -- This check runs BEFORE the change, so an authorized admin may step down
 -- and still complete audit/idempotency. Creator/last-admin checks and the
 -- organization-first lock order remain in the TypeScript repository.
 RETURN NEW; END $function$;
ALTER FUNCTION app.guard_organization_membership_update() OWNER TO dhumi_owner;
REVOKE ALL ON FUNCTION app.guard_organization_membership_update() FROM PUBLIC;
CREATE TRIGGER tenant_user_access_guard_update BEFORE UPDATE ON app.tenant_user_access
 FOR EACH ROW EXECUTE FUNCTION app.guard_organization_membership_update();

-- Keep legacy capability/login identities. User context is trusted backend state,
-- set transaction-locally after browser validation, never from a request body.
-- Account lookup by email stays in the identity capability. Customer profiles
-- expose only id/email/state and are limited to own/selected-organization users.
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_identity_access ON app.users FOR ALL TO dhumi_identity USING(true) WITH CHECK(true);
CREATE POLICY users_migration_read ON app.users FOR SELECT TO dhumi_owner USING(true);
CREATE POLICY users_customer_profiles ON app.users FOR SELECT TO dhumi_customer_api
 USING(app.current_user_id() IS NOT NULL AND(id=app.current_user_id() OR EXISTS(
  SELECT 1 FROM app.tenant_user_access m WHERE m.user_id=users.id AND m.tenant_id=app.current_tenant_id())));
GRANT SELECT(id,email_normalized,state) ON app.users TO dhumi_customer_api;
CREATE POLICY users_admission_own_read ON app.users FOR SELECT TO dhumi_admission
 USING(id=app.current_user_id());
GRANT SELECT(id,state) ON app.users TO dhumi_admission;
DROP POLICY tenant_user_access_identity_access ON app.tenant_user_access;
CREATE POLICY membership_identity_own_read ON app.tenant_user_access FOR SELECT TO dhumi_identity USING(user_id=app.current_user_id());
DROP POLICY tenants_identity_access ON app.tenants;
-- New tables are always FORCE RLS. No broad temporary runtime bypass.
ALTER TABLE app.organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_templates FORCE ROW LEVEL SECURITY;
-- Public reset confirmation has no browser user yet. Permit one bound reset
-- challenge lookup only; after lookup the trusted repository binds its user,
-- locks/compares the proof, then performs an own-user UPDATE atomically.
CREATE POLICY verification_identity_read ON app.email_verifications FOR SELECT TO dhumi_identity
 USING(user_id=app.current_user_id() OR(app.current_user_id() IS NULL
  AND purpose='password_reset' AND id=nullif(current_setting('app.verification_id',true),'')::uuid));
CREATE POLICY verification_identity_insert ON app.email_verifications FOR INSERT TO dhumi_identity
 WITH CHECK(user_id=app.current_user_id());
CREATE POLICY verification_identity_update ON app.email_verifications FOR UPDATE TO dhumi_identity
 USING(user_id=app.current_user_id()) WITH CHECK(user_id=app.current_user_id());
CREATE POLICY verification_cleanup_read ON app.email_verifications FOR SELECT TO dhumi_job_manager USING(expires_at<statement_timestamp()-interval '24 hours');
CREATE POLICY verification_cleanup_delete ON app.email_verifications FOR DELETE TO dhumi_job_manager USING(expires_at<statement_timestamp()-interval '24 hours');
CREATE POLICY invite_identity_read ON app.organization_invites FOR SELECT TO dhumi_identity USING(
 app.current_user_id() IS NOT NULL AND token_hash=decode(nullif(current_setting('app.invite_token_hash',true),''),'hex')
 AND revoked_at IS NULL AND expires_at>statement_timestamp()
 AND(email IS NULL OR email=(SELECT u.email_normalized FROM app.users u WHERE u.id=app.current_user_id())));
CREATE POLICY invite_identity_use ON app.organization_invites FOR UPDATE TO dhumi_identity USING(
 app.current_user_id() IS NOT NULL AND token_hash=decode(nullif(current_setting('app.invite_token_hash',true),''),'hex')
 AND revoked_at IS NULL AND expires_at>statement_timestamp()
 AND(email IS NULL OR email=(SELECT u.email_normalized FROM app.users u WHERE u.id=app.current_user_id())))
 WITH CHECK(revoked_at IS NULL AND expires_at>statement_timestamp() AND(max_uses IS NULL OR use_count<=max_uses));
CREATE POLICY tenant_identity_read ON app.tenants FOR SELECT TO dhumi_identity USING(
 app.current_user_id() IS NOT NULL AND(created_by_user_id=app.current_user_id()
 OR EXISTS(SELECT 1 FROM app.tenant_user_access m WHERE m.tenant_id=tenants.id AND m.user_id=app.current_user_id())
 OR EXISTS(SELECT 1 FROM app.organization_invites i WHERE i.organization_id=tenants.id)));
CREATE POLICY tenant_identity_create ON app.tenants FOR INSERT TO dhumi_identity WITH CHECK(
 created_by_user_id=app.current_user_id() AND NOT is_internal AND state='active' AND EXISTS(
 SELECT 1 FROM app.email_verifications v WHERE v.id=nullif(current_setting('app.verification_id',true),'')::uuid
 AND v.user_id=app.current_user_id() AND v.purpose='create_organization' AND v.consumed_at IS NULL
 AND v.attempt_count<5 AND v.expires_at>statement_timestamp() AND v.payload->>'organization_name'=display_name));
-- Joining locks its selected organization under the same pending proof and
-- hash/email-authorized invite. WITH CHECK false denies every actual UPDATE,
-- including id=id; PostgreSQL locking SELECT uses USING, not WITH CHECK.
CREATE POLICY tenant_identity_join_lock ON app.tenants FOR UPDATE TO dhumi_identity
 USING(id=app.current_tenant_id() AND state='active' AND app.current_user_id() IS NOT NULL AND EXISTS(
  SELECT 1 FROM app.email_verifications v JOIN app.organization_invites i
   ON i.organization_id=tenants.id AND i.id::text=v.payload->>'invite_id'
  WHERE v.id=nullif(current_setting('app.verification_id',true),'')::uuid
   AND v.user_id=app.current_user_id() AND v.purpose='join_organization'
   AND v.consumed_at IS NULL AND v.attempt_count<5 AND v.expires_at>statement_timestamp()
   AND v.payload->>'organization_id'=tenants.id::text
   AND encode(i.token_hash,'hex')=v.payload->>'invite_token_hash')) WITH CHECK(false);
-- Own membership creation/reactivation requires a bound pending proof and its
-- matching invitation. OTP/HMAC comparison, lock order, use limits and atomic
-- consume remain TypeScript transaction responsibilities; never network here.
CREATE POLICY membership_identity_insert ON app.tenant_user_access FOR INSERT TO dhumi_identity WITH CHECK(
 user_id=app.current_user_id() AND state='active' AND EXISTS(
 SELECT 1 FROM app.email_verifications v WHERE v.id=nullif(current_setting('app.verification_id',true),'')::uuid
 AND v.user_id=app.current_user_id() AND v.consumed_at IS NULL AND v.attempt_count<5 AND v.expires_at>statement_timestamp()
 AND((v.purpose='create_organization' AND invite_id IS NULL AND access_role='admin' AND EXISTS(
  SELECT 1 FROM app.tenants t WHERE t.id=tenant_id AND t.created_by_user_id=app.current_user_id() AND t.state='active' AND v.payload->>'organization_name'=t.display_name))
 OR(v.purpose='join_organization' AND EXISTS(SELECT 1 FROM app.organization_invites i WHERE i.id=invite_id
  AND i.organization_id=tenant_id AND i.role=access_role AND i.id::text=v.payload->>'invite_id'
  AND encode(i.token_hash,'hex')=v.payload->>'invite_token_hash' AND(i.max_uses IS NULL OR i.use_count<i.max_uses))))));
CREATE POLICY membership_identity_rejoin ON app.tenant_user_access FOR UPDATE TO dhumi_identity
 USING(user_id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND state IN('active','removed')) WITH CHECK(
 user_id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND state='active' AND EXISTS(
 SELECT 1 FROM app.email_verifications v JOIN app.organization_invites i ON i.id=invite_id AND i.organization_id=tenant_id
 WHERE v.id=nullif(current_setting('app.verification_id',true),'')::uuid AND v.user_id=app.current_user_id()
 AND v.purpose='join_organization' AND v.consumed_at IS NULL AND v.attempt_count<5 AND v.expires_at>statement_timestamp()
 AND i.role=access_role AND i.id::text=v.payload->>'invite_id' AND encode(i.token_hash,'hex')=v.payload->>'invite_token_hash'
 AND(i.max_uses IS NULL OR i.use_count<i.max_uses)));
-- Separate locking visibility from mutation authorization. Member SELECT is
-- a simple trusted-context predicate; admin subqueries read it without a
-- recursive membership policy. The invoker BEFORE guards authorize real
-- customer UPDATEs, including before a permitted admin self-step-down.
DROP POLICY tenant_user_access_tenant_isolation ON app.tenant_user_access;
CREATE POLICY tenant_user_access_tenant_isolation ON app.tenant_user_access FOR ALL TO dhumi_job_manager,dhumi_result_recorder
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY membership_admission_read ON app.tenant_user_access FOR SELECT TO dhumi_admission
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
CREATE POLICY membership_admission_lock ON app.tenant_user_access FOR UPDATE TO dhumi_admission
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state='active') WITH CHECK(false);
CREATE POLICY membership_customer_read ON app.tenant_user_access FOR SELECT TO dhumi_customer_api
 USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE POLICY membership_admin_update ON app.tenant_user_access FOR UPDATE TO dhumi_customer_api USING(
 tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND
 ((user_id=app.current_user_id() AND state='active') OR EXISTS(
 SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active')))
 WITH CHECK(tenant_id=app.current_tenant_id());
DROP POLICY tenants_tenant_isolation ON app.tenants;
CREATE POLICY tenants_tenant_isolation ON app.tenants FOR ALL TO dhumi_job_manager,dhumi_result_recorder USING(id=app.current_tenant_id()) WITH CHECK(id=app.current_tenant_id());
CREATE POLICY tenant_admission_read ON app.tenants FOR SELECT TO dhumi_admission
 USING(id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE POLICY tenant_admission_lock ON app.tenants FOR UPDATE TO dhumi_admission
 USING(id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL) WITH CHECK(false);
CREATE POLICY tenant_customer_read ON app.tenants FOR SELECT TO dhumi_customer_api
 USING(id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE POLICY tenant_admin_update ON app.tenants FOR UPDATE TO dhumi_customer_api USING(
 id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND EXISTS(
 SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=tenants.id AND a.user_id=app.current_user_id() AND a.state='active'))
 WITH CHECK(id=app.current_tenant_id() AND(state<>'active' OR created_by_user_id IS NOT NULL));
CREATE POLICY invite_admin_read ON app.organization_invites FOR SELECT TO dhumi_customer_api USING(
 organization_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=organization_id AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active'));
CREATE POLICY invite_admin_update ON app.organization_invites FOR UPDATE TO dhumi_customer_api USING(
 organization_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=organization_id AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active'))
 WITH CHECK(organization_id=app.current_tenant_id() AND EXISTS(
 SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=organization_id AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active'));
CREATE POLICY invite_admin_insert ON app.organization_invites FOR INSERT TO dhumi_customer_api
 WITH CHECK(organization_id=app.current_tenant_id() AND created_by_user_id=app.current_user_id() AND EXISTS(
 SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=organization_id AND a.user_id=app.current_user_id() AND a.access_role='admin' AND a.state='active'));
CREATE POLICY organization_templates_scoped_read ON app.organization_templates FOR SELECT TO dhumi_identity,dhumi_customer_api,dhumi_admission,dhumi_job_manager,dhumi_result_recorder,dhumi_owner USING(organization_id=app.current_tenant_id());
CREATE POLICY organization_templates_operator ON app.organization_templates FOR ALL TO dhumi_operator USING(true) WITH CHECK(true);

-- Global catalogue keeps publication/evidence/linked-service clauses from the
-- exact source policies. Remove only the mandatory tenant context; apply access.
DROP POLICY service_templates_customer_read ON app.service_templates;
CREATE POLICY service_templates_customer_read ON app.service_templates FOR SELECT TO dhumi_customer_api USING((((app.current_user_id() IS NOT NULL) AND (((state = ANY (ARRAY['published'::text, 'disabled'::text])) AND (current_public_version_id IS NOT NULL)) OR (EXISTS ( SELECT 1
   FROM app.services service
  WHERE ((service.tenant_id = app.current_tenant_id()) AND (service.service_template_id = service_templates.id))))))) AND (access='all' OR EXISTS(SELECT 1 FROM app.organization_templates ot WHERE ot.organization_id=app.current_tenant_id() AND ot.service_template_id=service_templates.id)));
DROP POLICY service_template_versions_customer_read ON app.service_template_versions;
CREATE POLICY service_template_versions_customer_read ON app.service_template_versions FOR SELECT TO dhumi_customer_api USING((((app.current_user_id() IS NOT NULL) AND (((published_at IS NOT NULL) AND (published_at <= statement_timestamp()) AND (effective_at IS NOT NULL) AND (effective_at <= statement_timestamp()) AND (EXISTS ( SELECT 1
   FROM app.service_templates template
  WHERE ((template.id = service_template_versions.service_template_id) AND (template.current_public_version_id = service_template_versions.id) AND (template.state = ANY (ARRAY['published'::text, 'disabled'::text]))))) AND (EXISTS ( SELECT 1
   FROM app.launch_evidence evidence
  WHERE ((evidence.id = service_template_versions.launch_evidence_id) AND (evidence.state = 'approved'::text) AND (evidence.effective_at IS NOT NULL) AND (evidence.effective_at <= statement_timestamp()) AND ((evidence.expires_at IS NULL) OR (evidence.expires_at > statement_timestamp())))))) OR (EXISTS ( SELECT 1
   FROM (app.service_versions service_version
     JOIN app.services service ON (((service.tenant_id = service_version.tenant_id) AND (service.id = service_version.service_id))))
  WHERE ((service_version.tenant_id = app.current_tenant_id()) AND (service_version.service_template_version_id = service_template_versions.id) AND (service.service_template_id = service_template_versions.service_template_id))))))) AND EXISTS(SELECT 1 FROM app.service_templates st WHERE st.id=service_template_versions.service_template_id));
GRANT SELECT(access) ON app.service_templates TO dhumi_customer_api;
-- Source sample helpers stay governed and may use no organization for all-access
-- templates. Restrict their owner SELECT so selected templates cannot leak.
CREATE POLICY service_templates_owner_selected_read ON app.service_templates AS RESTRICTIVE FOR SELECT TO dhumi_owner
 USING(access='all' OR EXISTS(SELECT 1 FROM app.organization_templates ot WHERE ot.organization_id=app.current_tenant_id() AND ot.service_template_id=service_templates.id));
CREATE POLICY service_templates_admission_selected_read ON app.service_templates AS RESTRICTIVE FOR SELECT TO dhumi_admission
 USING(access='all' OR EXISTS(SELECT 1 FROM app.organization_templates ot WHERE ot.organization_id=app.current_tenant_id() AND ot.service_template_id=service_templates.id));
GRANT SELECT(access) ON app.service_templates TO dhumi_admission;

REVOKE INSERT,UPDATE ON app.users,app.auth_sessions,app.auth_refresh_tokens,app.tenants,app.tenant_user_access FROM dhumi_identity;
GRANT INSERT(id,email_normalized,password_hash) ON app.users TO dhumi_identity;
GRANT UPDATE(password_hash,state,email_verified_at,failed_auth_count,last_failed_auth_at) ON app.users TO dhumi_identity;
GRANT INSERT(id,user_id,token_family_hash,expires_at) ON app.auth_sessions TO dhumi_identity;
GRANT UPDATE(token_family_hash,state,revoked_at,revoked_reason) ON app.auth_sessions TO dhumi_identity;
GRANT INSERT(id,session_id,token_hash,generation) ON app.auth_refresh_tokens TO dhumi_identity;
GRANT UPDATE(state,ended_at) ON app.auth_refresh_tokens TO dhumi_identity;
GRANT INSERT(id,display_name,created_by_user_id) ON app.tenants TO dhumi_identity;
GRANT UPDATE(id) ON app.tenants TO dhumi_identity;
GRANT INSERT(tenant_id,user_id,access_role,invite_id) ON app.tenant_user_access TO dhumi_identity;
GRANT UPDATE(access_role,state,invite_id) ON app.tenant_user_access TO dhumi_identity;
GRANT UPDATE(display_name,state) ON app.tenants TO dhumi_customer_api;
GRANT UPDATE(access_role,state) ON app.tenant_user_access TO dhumi_customer_api;
GRANT SELECT(id,state) ON app.tenants TO dhumi_admission;
GRANT SELECT(tenant_id,user_id,state) ON app.tenant_user_access TO dhumi_admission;
-- UPDATE on one column satisfies row-lock ACLs. False UPDATE WITH CHECK
-- policies prevent admission/identity lock grants from becoming mutations.
GRANT UPDATE(id) ON app.tenants TO dhumi_admission;
GRANT UPDATE(user_id) ON app.tenant_user_access TO dhumi_admission;
GRANT UPDATE(response_body) ON app.idempotency_records TO dhumi_customer_api;
REVOKE UPDATE,DELETE ON app.audit_events,app.legal_acceptances FROM dhumi_identity;
GRANT SELECT ON app.email_verifications TO dhumi_identity;
GRANT INSERT(id,user_id,purpose,code_hash,payload,expires_at,trace_id) ON app.email_verifications TO dhumi_identity;
GRANT UPDATE(attempt_count,consumed_at,payload) ON app.email_verifications TO dhumi_identity;
GRANT SELECT(id,expires_at) ON app.email_verifications TO dhumi_job_manager;
GRANT DELETE ON app.email_verifications TO dhumi_job_manager;
GRANT SELECT ON app.organization_invites TO dhumi_identity,dhumi_customer_api;
GRANT INSERT(id,organization_id,email,token_hash,role,max_uses,expires_at,created_by_user_id) ON app.organization_invites TO dhumi_customer_api;
GRANT UPDATE(token_hash,role,max_uses,expires_at,revoked_at) ON app.organization_invites TO dhumi_customer_api;
GRANT UPDATE(use_count) ON app.organization_invites TO dhumi_identity;
GRANT SELECT ON app.organization_templates TO dhumi_identity,dhumi_customer_api,dhumi_admission,dhumi_job_manager,dhumi_result_recorder,dhumi_owner,dhumi_operator;
GRANT INSERT,DELETE ON app.organization_templates TO dhumi_operator;
REVOKE ALL ON app.organization_invites,app.email_verifications,app.organization_templates FROM PUBLIC;

-- Effective capability ACL checks are also gates in the eventual migration.
-- They do NOT prove row-policy/trigger/lock behavior or login isolation.
DO $privilege_alignment$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('dhumi_identity','auth_sessions','token_family_hash','UPDATE',true),
  ('dhumi_identity','tenants','id','UPDATE',true),
  ('dhumi_identity','tenants','display_name','UPDATE',false),
  ('dhumi_identity','tenants','state','UPDATE',false),
  ('dhumi_admission','users','id','SELECT',true),
  ('dhumi_admission','users','state','SELECT',true),
  ('dhumi_admission','users','password_hash','SELECT',false),
  ('dhumi_admission','tenants','id','SELECT',true),
  ('dhumi_admission','tenants','state','SELECT',true),
  ('dhumi_admission','tenants','id','UPDATE',true),
  ('dhumi_admission','tenants','state','UPDATE',false),
  ('dhumi_admission','tenant_user_access','tenant_id','SELECT',true),
  ('dhumi_admission','tenant_user_access','user_id','SELECT',true),
  ('dhumi_admission','tenant_user_access','state','SELECT',true),
  ('dhumi_admission','tenant_user_access','user_id','UPDATE',true),
  ('dhumi_admission','tenant_user_access','state','UPDATE',false),
  ('dhumi_admission','tenant_user_access','access_role','UPDATE',false),
  ('dhumi_admission','service_templates','access','SELECT',true),
  ('dhumi_admission','organization_templates','organization_id','SELECT',true),
  ('dhumi_admission','organization_templates','service_template_id','SELECT',true),
  ('dhumi_customer_api','idempotency_records','response_body','UPDATE',true),
  ('dhumi_customer_api','tenant_user_access','user_id','UPDATE',false),
  ('dhumi_customer_api','tenant_user_access','invite_id','UPDATE',false)
 ) AS required(role_name,table_name,column_name,privilege,expected) LOOP
  IF has_column_privilege(r.role_name,format('app.%I',r.table_name),r.column_name,r.privilege) IS DISTINCT FROM r.expected THEN
   RAISE EXCEPTION '0071 capability ACL mismatch: % %.% %',r.role_name,r.table_name,r.column_name,r.privilege;
  END IF;
 END LOOP;
END $privilege_alignment$;

-- Self-check projected source rows, new values and exact migration audit facts.
DO $preservation$ DECLARE r record;n bigint;d text;e text; BEGIN
 FOR r IN SELECT p.*,b.n expected_n,b.digest expected_digest FROM pg_temp.refactor_0071_projection p JOIN pg_temp.refactor_0071_retained b USING(table_name) ORDER BY table_name LOOP
  e:='to_jsonb(t)-$1';
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),'''')) FROM (SELECT md5((%s)::text) d FROM app.%I t %s)s',e,r.table_name,
   CASE WHEN r.table_name='audit_events' THEN 'WHERE action NOT IN(''refactor.0071.refresh_token_history'',''refactor.0071.suspension_history'')' ELSE '' END)
   INTO n,d USING r.new_keys;
  IF n<>r.expected_n OR d<>r.expected_digest THEN RAISE EXCEPTION 'Retained source values changed in %',r.table_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.tenants t JOIN pg_temp.refactor_0071_creators c ON c.id=t.id WHERE t.created_by_user_id IS DISTINCT FROM c.actor OR t.is_internal) THEN RAISE EXCEPTION 'Creator/internal backfill mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.tenants t WHERE t.state='active' AND(t.created_by_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.tenant_user_access m WHERE m.tenant_id=t.id AND m.access_role='admin' AND m.state='active'))) THEN RAISE EXCEPTION 'Remaining active creator/admin gate fails'; END IF;
 IF EXISTS(SELECT 1 FROM app.auth_sessions s JOIN pg_temp.refactor_0071_session_expected e USING(id) WHERE s.revoked_reason IS DISTINCT FROM e.revoked_reason) THEN RAISE EXCEPTION 'Session reason backfill mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.auth_refresh_tokens t JOIN pg_temp.refactor_0071_token_expected e USING(id) WHERE t.ended_at IS DISTINCT FROM e.ended_at) THEN RAISE EXCEPTION 'Token state-specific end mismatch'; END IF;
 IF (SELECT count(*) FROM app.audit_events WHERE action='refactor.0071.refresh_token_history')<>259 OR EXISTS(
  SELECT 1 FROM pg_temp.refactor_0071_token_expected e WHERE e.archive_extra AND NOT EXISTS(SELECT 1 FROM app.audit_events a WHERE a.action='refactor.0071.refresh_token_history' AND a.target_id=e.id AND a.safe_diff=e.history AND a.tenant_id IS NULL AND a.actor_user_id IS NULL)) THEN RAISE EXCEPTION 'Token history facts not preserved'; END IF;
 IF (SELECT count(*) FROM app.audit_events WHERE action='refactor.0071.suspension_history')<>208 OR EXISTS(
  SELECT 1 FROM pg_temp.refactor_0071_suspension_expected e WHERE NOT EXISTS(SELECT 1 FROM app.audit_events a WHERE a.action='refactor.0071.suspension_history' AND a.target_id=e.id AND a.safe_diff=e.history AND a.tenant_id=e.id AND a.actor_user_id IS NULL)) THEN RAISE EXCEPTION 'Suspension facts not preserved'; END IF;
 IF EXISTS(SELECT 1 FROM app.organization_invites) OR EXISTS(SELECT 1 FROM app.email_verifications) OR EXISTS(SELECT 1 FROM app.organization_templates) THEN RAISE EXCEPTION 'Unexpected seeded target data'; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND c.relkind='r')<>35 THEN RAISE EXCEPTION 'Expected 35 tables'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND t.tgenabled NOT IN('O','A')) OR current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'A trigger/FK enforcement changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND c.relname IN('tenants','tenant_user_access','users','organization_invites','email_verifications','organization_templates') AND(NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) THEN RAISE EXCEPTION 'Required FORCE RLS missing'; END IF;
 IF (SELECT count(*) FROM app.schema_migrations)<>70 OR EXISTS((SELECT version,checksum FROM app.schema_migrations EXCEPT SELECT * FROM pg_temp.refactor_0071_source_ledger) UNION ALL(SELECT * FROM pg_temp.refactor_0071_source_ledger EXCEPT SELECT version,checksum FROM app.schema_migrations)) THEN RAISE EXCEPTION 'Body changed applied migration history'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='app' AND p.proname='create_signup') THEN RAISE EXCEPTION 'Retired signup function remains'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='app' AND p.proname IN('current_user_id','reject_organization_creator_mutation','guard_organization_membership_update') AND p.prosecdef) THEN RAISE EXCEPTION 'New helper must be SECURITY INVOKER'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['dhumi_identity','dhumi_customer_api','dhumi_admission','dhumi_job_manager','dhumi_result_recorder','dhumi_operator']) AS runtime_role(role_name) WHERE has_column_privilege(role_name,'app.tenants','created_by_user_id','UPDATE')) THEN RAISE EXCEPTION 'Runtime can change creator provenance'; END IF;
 IF has_column_privilege('dhumi_identity','app.auth_sessions','created_at','INSERT') OR has_column_privilege('dhumi_identity','app.auth_sessions','created_at','UPDATE') OR has_column_privilege('dhumi_identity','app.auth_refresh_tokens','created_at','INSERT') OR has_column_privilege('dhumi_identity','app.auth_refresh_tokens','created_at','UPDATE') OR has_column_privilege('dhumi_identity','app.email_verifications','created_at','INSERT') OR has_column_privilege('dhumi_identity','app.email_verifications','created_at','UPDATE') THEN RAISE EXCEPTION 'Runtime can bypass historical cutover/issuance limits'; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='app')<>78 OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='app' AND p.prosecdef)<>54 THEN RAISE EXCEPTION 'Unexpected function/definer count'; END IF;
END $preservation$;
SET LOCAL ROLE dhumi_owner;
-- End of review body. Runner must insert exactly one checksum-bound 0071 ledger
-- row only after successful qualified body execution, then own final COMMIT.
