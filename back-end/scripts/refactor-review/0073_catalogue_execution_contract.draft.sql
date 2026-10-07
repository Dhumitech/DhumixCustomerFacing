-- 0073 review draft: catalogue/execution contraction, existing identities retained.
-- Main application is NOT authorized. Whole body runs inside the gated runner's transaction.
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $gate$
BEGIN
 IF current_database()<>'dhumi_test' OR host(inet_server_addr())<>'127.0.0.1' OR inet_server_port() NOT IN (5432,65472)
   OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN RAISE EXCEPTION '0073_TEST_ADMIN_ONLY'; END IF;
 IF inet_server_port()=5432 AND (current_setting('dhumi.refactor_apply',true) IS DISTINCT FROM '0073'
   OR current_setting('dhumi.owner_approved',true) IS DISTINCT FROM 'yes'
   OR current_setting('dhumi.backend_qualified',true) IS DISTINCT FROM 'yes'
   OR current_setting('dhumi.backup_restore_verified',true) IS DISTINCT FROM 'yes') THEN RAISE EXCEPTION '0073_REVIEW_GATES_REQUIRED'; END IF;
 IF inet_server_port()=65472 AND current_setting('dhumi.qualification',true) IS DISTINCT FROM '0073' THEN RAISE EXCEPTION '0073_ISOLATED_QUALIFICATION_ONLY'; END IF;
 IF (SELECT count(*) FROM app.schema_migrations)<>72 OR NOT EXISTS(SELECT 1 FROM app.schema_migrations WHERE version='0072_catalogue_execution_expand' AND checksum='7b2e41928d37dd94c53023917d890138b8fd4dae17bddbfe69accfa2171c118b') THEN RAISE EXCEPTION '0073_EXACT_0072_BASELINE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES ('0001_bootstrap_roles_and_schema','f3bb8b9318b74413ba4cb570262046df2b7cbaeedfcbad2bc8ffc6fba61fa9ea'),('0002_core_tables','7747ed1b26b990e20de30fa19478914fa02ab69c742d78b585784d78cf4e10bf'),('0003_rls_transitions_and_transaction_functions','23b1073746a3dacc145ecd4c3454e5938d1a9d9e530e4fe778ef21bccd9f9bc2'),('0004_database_integrity_corrections','34710ca15692ee3319fcf1cbbcb1db52f06a149f13c4405a3f067a8f36c6cc91'),('0005_tenant_workspace_state_alignment','7780b5fd3fb6c9126df449249fa6f096f679bdf63ed6db1f61070e92d6131831'),('0006_refresh_token_rotation','af3c6101c956bda36ef313efff2f1d678397af3842a94db415e2e05c4ed2faa4'),('0007_api_key_schema_foundation','cb2dd9b4ace666d2b1c6a5edba9dd437f15daaca199929c1413edfb0246bbde0'),('0008_core_integrity_constraints','08b8ab9db3fad43aec23ebad44f268e3007d81e977ff911fa142cf5b740a6529'),('0009_envelope_destruction','29f5e7e80e4b92215549e4c225221ef30e505f152e7688af2581297697f4cbbf'),('0010_api_key_list_read_surface','b299e93840b05495298b941e8fc497d3c44730629b44a90cb4f57d1e2fe06913'),('0011_api_key_revocation','f80d48efbffef4c8ded2a5f4054a87a2a315c8ae7c840ed2ec11a86edd4d4750'),('0012_api_key_revocation_event_v2','da57b06c2121afec6dc756fe5e9c6b3903982ac91cc241d525ced19140b0d0e9'),('0013_catalogue_public_read_surface','869451d73d6507278329a0490b3d863986029ca5e4bdf00e676dc20bdcb88812'),('0014_catalogue_slug_integrity','a23db772d09350684e9d08da7f9ab022fe049527beb64974e75d36b5e2572f79'),('0015_service_list_read_surface','25cfbd8c387f2b9311ec29b2f453cf5cb6ed5c44c5aa76055e64345290d94571'),('0016_service_creation','8c967f523485214a11b7b9b6b233cf79d028545c1076e9d5656ef3100dec5da4'),('0017_service_detail_read_surface','8d9b859b0540ee3e3c07384d496418d3db6cb360ac97e62c37830e709d172bbd'),('0018_run_admission','94ae9d7adb9ffece2e7424219945f6e77e15c04dd5a20b0ce2943d3d4063077b'),('0019_run_service_lock','cdde64eff8757e0b0999db64fe34bc440724365b12108bc62f0f8828ed157688'),('0020_run_list_read_surface','6c0f87c6f2c47adc88bb2af5a41ee3740cb325e5a9e44b0e236c05af96b43fd3'),('0021_run_cancellation','abe0895839780783fb32c141e91cf82474cc442739602bace868f85340ea2dfe'),('0022_run_retry','96f89ccca5dfb35081857054af170e4e40ba1595c4cc8072d503bd166ec4212d'),('0023_run_retry_owner_rls','ed87bac9e51d05128276a82622440cb291a6cc8a6e053fb93355138bc1013971'),('0024_run_retry_idempotency_lineage','92bed8d95e91d30330db4ecd9762237ab462ad81105084d4f7268ea3e250a140'),('0025_run_event_list_read_surface','88ad8cf9ccc7206685dd028b59a52323e11a55dd4686a1cc844890385974c448'),('0026_template_presentation_and_configuration_schema','5c1442740fa41ddd2a51443e990cfb2ea141cd20ec06d86a56fe500fba956db3'),('0027_run_list_service_filter','5e538b6f30540716b2d776fb0e28d6e037aec718ffdc5fee7ef6b53a1cd72030'),('0028_run_result_read_surface','08c122231cf9bb74971f770c707f77ce7c09d9bf12bffc2c58e48ff258722093'),('0029_durable_execution_fencing','b935672cc78820410ab93d5c09c4d4511a32c270c1fea36352418b8ba95d0977'),('0030_durable_execution_reconciliation','b8bcd4a6e1cc72f1d60e16a545c3a4478f9fab46f65ebd09d19c58bf17fc7651'),('0031_provider_execution_boundary','61c19bb9dfac565db1ccf8f473f5c397b9d8d65c645963337a6ae01ffbfa2bc6'),('0032_amazon_operation_definitions','92a60d577d0fa84a47fe03b4ca0aab70e8783c1d258cba888ea43ce99ea281b7'),('0033_amazon_live_qualification_foundation','a08ed607df2231a408043628592b322f6a996ae1e396c36e314f0e396dfc7db5'),('0034_amazon_qualification_audit_rls','a5c9eba29d6df6bc4894372a6e6daa5035c1690a3e9767c993ad5bf36a5ec857'),('0035_amazon_qualification_template_version_rls','d7b3c67edf88a4f277ae736f5728339fc80e12ef9c8a7e6d40c464896c39d7e2'),('0036_amazon_qualification_execution_mode','cee070da327c40ac779b4577f64833846b8ff3ad2dc6ad52229ff207c183e48b'),('0037_usage_finalization','09829dc1f9637f4bbe00bf32f4250f1ae07824800cc4bf4d16b542115d6aacf3'),('0038_usage_read_surface','050aab6e5903dd4513c621d3acd372dcc23eb0b4a9845d6e5e551845d2bb4e23'),('0039_platform_status_projection','5db6faed19a73e30ae568dd822658d8f52a4faa9270233019c7f1a48650061fb'),('0040_amazon_precise_output_contracts','1733b72ccb31d00065735f99ae96ef2d7e380d4a5c6c648ac99dc25c395e87c2'),('0041_amazon_controlled_publication','6d1c813a275e172c537cd49f260269a0592ba94bb81cac10901c90d07bb3972c'),('0042_provider_mapping_aad_lineage','0e258efec49c1e3745441cd242f9a9359e667fefc2987ac7e2053fae7d839442'),('0043_amazon_products_input_contract_v4','56f00965f10d1abcb13ec4165a5914e6f85098201d12a4ccfaa83c5b238100ae'),('0044_provider_poll_checkpoint','6144ea86ba338f2c51edd69d6c42c113b0b0a3ff40e2639a52c603849ba697f2'),('0045_marketplace_catalogue_import','5a3602bb0125bb587cfe1ac7394745d29b73f4256e81f6015a89242b3c6a5d5a'),('0046_marketplace_sample_ingestion','e6e0c12509d574ded99deb23cfddc15b8e25b880f67533b9a3d4e250f3d233f5'),('0047_marketplace_sample_retention_policy','d372502c00bfbd240f619a55f104f7cfcf121c2edd59832a112a71a7f7315478'),('0048_marketplace_sample_fixture_lifecycle','5cc2ca451dc3d6edf25a0ffedc6311fbc6d98933fb487016d7119889ce28def9'),('0049_marketplace_sample_preview_read','93c7a4b612a03ce765e50d5545143842703fb0022e73300e4bb0770e512b5eb7'),('0050_marketplace_sample_download_authorization','526b488ea947cf3bd75b0741f446d4290f81465500a3eae1616ba52f38345a78'),('0051_marketplace_expert_enquiries','b96c2a55ead67f2492355ebdfccf6cc770f93db27c58f90eb88630cc07ba00c8'),('0052_marketplace_filter_adapter_fixture','e78ab7338aa7eee7ce9980ac6e5b0af6ce54ead2c32e3cc5b5f44cd8b18b5c60'),('0053_marketplace_filter_execution_rls','5e4b98e1745f8b176f317dffa7f8f0994bf1ceb6d0a781d597dc3368f3285c6c'),('0054_marketplace_qualification_preflight','ada06465a57dc50a52967dd7fb1a8b519537a075a97c871dd5243f0704628ea9'),('0055_marketplace_qualification_execution','7393871036e47966764606a8c4cd7dd84759b8a06b9dfa0486a36d56021920ed'),('0056_marketplace_export_candidate','53eb18f59c2485c2456cb6966227d6395581c7caeec59baa54ec004c4cc9ab1e'),('0057_linkedin_posts_provider_sample','535860e803d7b811614b76b583672d55a0a4a7495ffa44782fdb09138f224286'),('0058_marketplace_provider_sample_timestamp_authority','c1160595d9fdc7385becf02ea584963870b75b1a1c2674bdf668960caf357014'),('0059_linkedin_posts_provider_sample_version_3','b32eda2ff7e7484e2361b5147c72343db74dde62c71c4a935acdd9e5f2848f9e'),('0060_linkedin_people_metadata_observation','e5a1877abd766cb5f3c24a88865009ef23436d36b10f3d2b7cd29c5354eb922b'),('0061_linkedin_people_synthetic_preview','12b41e3887642a7d4da6d1bade8c10f363c34a0dad0849e0a9631aa9ac3c330e'),('0062_linkedin_people_sample_timestamp_authority','077b8abbbd9d56ad8c5cd5f2fbc05ac0edea20a748081ed359abcf1b78b0dcbb'),('0063_linkedin_people_contact_contract','af1a9b8900adc369d20e1dbb8193fa68dfb478769b24bd3b2e9443a80b8afe83'),('0064_marketplace_sample_download_cleanup','eefa25c1aac1bd5a9527624a2e860a7f2da6b71307f49577fe2e5c6b427ba422'),('0065_marketplace_fixture_current_schema','a555b737e3dfd73fd835a271c9ac562ec5203bbb87bff8616dc738c8a065f894'),('0066_shared_scraper_processing','65da95f341d63abc8a7861d0f08936e111af69fb8b4a2abd0b50359c0b443a60'),('0067_shared_scraper_draft_registration','c79b9dcd42fb0fb5261905f7ebd9cf0dff3fc8400ecdfaecaeb5b3842cc573fb'),('0068_shared_scraper_release_identity','0fac582eef7e19bcfa969bf4b45482d8e9c6312e7ebc7c5821e6a2058bd379c7'),('0069_shared_scraper_commercial_capacity','6b729ac9d99717371fe1354c3efa296625b492f07dc008f4706aea8796e9efe5'),('0070_archive','0804b5d0716f47f3e826e9aa4c67e38b8d34e2d83ae284eb7cd2a6b1bfdc297a'),('0071_organizations','af85bea48d8bb0e4c77ba9d301a23977ecfc33b5fe77ded0469c207e13e17bd9'),('0072_catalogue_execution_expand','7b2e41928d37dd94c53023917d890138b8fd4dae17bddbfe69accfa2171c118b')) expected(version,checksum) LEFT JOIN app.schema_migrations actual USING(version) WHERE actual.checksum IS DISTINCT FROM expected.checksum)
 THEN RAISE EXCEPTION '0073_ALL_APPLIED_CHECKSUMS_REQUIRED'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='app')<>450 THEN RAISE EXCEPTION '0073_EXPECTED_450_COLUMNS'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename LIKE 'dhumi_test_%_login') THEN RAISE EXCEPTION '0073_STOP_RUNTIME_FIRST'; END IF;
END $gate$;
-- Read-only catalog fingerprint; called before preview and after approved cleanup.
SELECT set_config('dhumi.fixture_cleanup_schema', md5(jsonb_build_object(
  'columns', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.table_name,s.attname) FROM (
    SELECT c.relname table_name,a.attname,format_type(a.atttypid,a.atttypmod) data_type,
      a.attnotnull,a.attisdropped,a.attacl,pg_get_expr(d.adbin,d.adrelid) default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='app' AND a.attnum>0 AND NOT a.attisdropped) s),
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

DO $schema_gate$
BEGIN
 IF current_setting('dhumi.fixture_cleanup_schema') IS DISTINCT FROM (CASE WHEN inet_server_port()=5432 THEN '25492e3bbef369e1cdab700672b7d58f' ELSE '1206fc6a87e37d9ae65bdd6a5d699635' END)
 THEN RAISE EXCEPTION '0073_SCHEMA_PRIVILEGE_POLICY_BASELINE_DRIFT'; END IF;
END $schema_gate$;
LOCK TABLE app.adapter_definitions,app.adapter_versions,app.artifacts,app.audit_events,app.auth_refresh_tokens,app.auth_sessions,app.dead_letter_recovery_intents,app.email_verifications,app.feature_flags,app.idempotency_records,app.launch_evidence,app.legal_acceptances,app.marketplace_expert_enquiries,app.marketplace_sample_deletions,app.marketplace_sample_download_authorizations,app.marketplace_sample_versions,app.organization_invites,app.organization_templates,app.outbox_events,app.provider_calls,app.provider_cost_holds,app.provider_credentials,app.provider_mappings,app.run_attempts,app.run_events,app.run_status_transitions,app.runs,app.schema_migrations,app.service_template_versions,app.service_templates,app.service_versions,app.services,app.tenant_user_access,app.tenants,app.usage_events,app.users IN ACCESS EXCLUSIVE MODE;
-- Main must still match the verified backup. Isolated populated fixtures are separate.
DO $backup_rows$
DECLARE receipt record;actual_n bigint;actual_digest text;
BEGIN
 IF inet_server_port()=5432 THEN
  FOR receipt IN SELECT * FROM (VALUES ('adapter_definitions',4::bigint,'04aa97e9c7d58af72bc0afb198e7c041'),
('adapter_versions',7::bigint,'953d355709b7bd018543fef572310a7c'),
('artifacts',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('audit_events',19298::bigint,'1dccfc72ade2684c9c62e55ff4ed8b0f'),
('auth_refresh_tokens',3357::bigint,'c130ab8b32ad4dfe87ad0fbae2d6341f'),
('auth_sessions',2967::bigint,'6e72e0078069f7c39fcb8f21263b3579'),
('dead_letter_recovery_intents',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('email_verifications',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('feature_flags',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('idempotency_records',11008::bigint,'369f45982e8bace45c00b2f1e37baa4f'),
('launch_evidence',26::bigint,'62c6f63d2f9ec8e47ca034de22c97832'),
('legal_acceptances',10192::bigint,'d67975b714febfabdf8338695bd87e65'),
('marketplace_expert_enquiries',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_deletions',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_download_authorizations',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_versions',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_invites',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_templates',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('outbox_events',10823::bigint,'c1acb8874ab02acf84469eb5fbcfc704'),
('provider_calls',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('provider_cost_holds',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('provider_credentials',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('provider_mappings',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('run_attempts',4::bigint,'8021c2177ad8cab5a2a52fad4b6b6482'),
('run_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('run_status_transitions',10::bigint,'1e1b865cb1b9207fcd9fad62b9b13839'),
('runs',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('schema_migrations',72::bigint,'0c6a58ec680fb932ea17f55ea780e069'),
('service_template_versions',26::bigint,'d9da81f3ac02c41ae0eb135c5e65ab76'),
('service_templates',13::bigint,'553549a2edc97bb12b8667374d54c501'),
('service_versions',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('services',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('tenant_user_access',10192::bigint,'08356bed633fb03fddcaca2236821f73'),
('tenants',10192::bigint,'2c2add83470feeb9612e0e41932f34ee'),
('usage_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('users',10962::bigint,'55607d7c26a8b298afba9a0046a37e44')) expected(table_name,n,digest) LOOP
   EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,receipt.table_name) INTO actual_n,actual_digest;
   IF actual_n<>receipt.n OR actual_digest<>receipt.digest THEN RAISE EXCEPTION '0073_VERIFIED_BACKUP_DATA_DRIFT %',receipt.table_name; END IF;
  END LOOP;
 END IF;
END $backup_rows$;
CREATE TEMP TABLE refactor73_retained_rows(table_name text PRIMARY KEY,n bigint,digest text) ON COMMIT DROP;
-- Preserve historical reasons and legacy UUID traces without inventing unknown traces.
DO $audit_fold$
BEGIN
 IF EXISTS(SELECT 1 FROM app.audit_events WHERE reason IS NOT NULL AND safe_diff ? 'reason' AND safe_diff->>'reason' IS DISTINCT FROM reason)
 THEN RAISE EXCEPTION '0073_AUDIT_REASON_CONFLICT'; END IF;
END $audit_fold$;
ALTER TABLE app.audit_events DISABLE TRIGGER audit_events_immutable;
UPDATE app.audit_events SET safe_diff=safe_diff||jsonb_build_object('reason',reason) WHERE reason IS NOT NULL AND NOT(safe_diff ? 'reason');
UPDATE app.audit_events SET trace_id=request_id WHERE trace_id IS NULL AND request_id IS NOT NULL;
ALTER TABLE app.audit_events ENABLE TRIGGER audit_events_immutable;
-- The retired recovery function wrote intent reasons, but no audit fact.
-- Preserve source operator text/time without guessing a user or a request trace.
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff,occurred_at)
 SELECT original.tenant_id,NULL,'run.dead_letter_recover','outbox_event',i.recovery_event_id,'scheduled',NULL,
   jsonb_build_object('reason',i.reason_code,'legacy_requested_by',i.requested_by,'original_event_id',i.original_event_id),i.created_at
 FROM app.dead_letter_recovery_intents i JOIN app.outbox_events original ON original.id=i.original_event_id
 WHERE NOT EXISTS(SELECT 1 FROM app.audit_events a WHERE a.action='run.dead_letter_recover' AND a.target_type='outbox_event' AND a.target_id=i.recovery_event_id);
INSERT INTO refactor73_retained_rows SELECT 'artifacts',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,run_id,attempt_id,kind,artifact_version,object_key,content_type,content_encoding,byte_count,checksum,schema_version,state,created_at,expires_at,deleted_at,record_count FROM app.artifacts)t)s;
INSERT INTO refactor73_retained_rows SELECT 'audit_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,actor_user_id,action,target_type,target_id,outcome,ip_fingerprint,safe_diff,occurred_at,trace_id FROM app.audit_events)t)s;
INSERT INTO refactor73_retained_rows SELECT 'auth_refresh_tokens',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,session_id,token_hash,generation,state,created_at,ended_at FROM app.auth_refresh_tokens)t)s;
INSERT INTO refactor73_retained_rows SELECT 'auth_sessions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,user_id,token_family_hash,state,expires_at,revoked_at,created_at,revoked_reason FROM app.auth_sessions)t)s;
INSERT INTO refactor73_retained_rows SELECT 'email_verifications',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,user_id,purpose,code_hash,payload,attempt_count,expires_at,consumed_at,trace_id,created_at FROM app.email_verifications)t)s;
INSERT INTO refactor73_retained_rows SELECT 'idempotency_records',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,scope_kind,actor_fingerprint,operation_code,idempotency_key,request_hash,state,response_status,resource_type,resource_id,related_resource_id,response_body_reference,created_at,expires_at,completed_at,updated_at,response_body FROM app.idempotency_records)t)s;
INSERT INTO refactor73_retained_rows SELECT 'legal_acceptances',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,user_id,document_type,document_version,document_hash,disclosure_version,accepted_at,trace_id FROM app.legal_acceptances)t)s;
INSERT INTO refactor73_retained_rows SELECT 'marketplace_expert_enquiries',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,service_template_version_id,actor_user_id,actor_fingerprint,idempotency_key,request_hash,template_slug,template_version,state,request_id,ip_fingerprint,created_at,updated_at,contacted_at,closed_at FROM app.marketplace_expert_enquiries)t)s;
INSERT INTO refactor73_retained_rows SELECT 'marketplace_sample_deletions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT sample_version_id,deleted_at,storage_disposition,actor,created_at FROM app.marketplace_sample_deletions)t)s;
INSERT INTO refactor73_retained_rows SELECT 'marketplace_sample_download_authorizations',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,sample_version_id,actor_user_id,actor_fingerprint,idempotency_key,request_hash,template_slug,template_version,sample_version,format,selected_fields,projection_fingerprint,record_limit,record_count,object_key,content_type,file_name,byte_count,checksum,state,download_expires_at,request_id,ip_fingerprint,created_at,authorized_at,failed_at FROM app.marketplace_sample_download_authorizations)t)s;
INSERT INTO refactor73_retained_rows SELECT 'marketplace_sample_versions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,service_template_version_id,sample_version,source_kind,object_key,content_type,record_count,byte_count,checksum,source_metadata_checksum,schema_version,masking_policy_version,retention_policy_version,provenance_evidence_reference,rights_evidence_reference,collected_at,published_at,expires_at,state,created_at,qualification_packet_id,field_dictionary,governance_state,interim_decision_reference FROM app.marketplace_sample_versions)t)s;
INSERT INTO refactor73_retained_rows SELECT 'organization_invites',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,organization_id,email,token_hash,role,max_uses,use_count,expires_at,revoked_at,created_by_user_id,created_at FROM app.organization_invites)t)s;
INSERT INTO refactor73_retained_rows SELECT 'organization_templates',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT organization_id,service_template_id FROM app.organization_templates)t)s;
INSERT INTO refactor73_retained_rows SELECT 'provider_calls',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,organization_id,run_id,initiated_by_user_id,attempt_id,purpose,endpoint,state,http_status,safe_error_code,response_bytes,prepared_at,finished_at FROM app.provider_calls)t)s;
INSERT INTO refactor73_retained_rows SELECT 'run_attempts',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,run_id,attempt_number,kind,state,outcome_class,fence_token,worker_lease_expires_at,provider_reference_ciphertext,provider_reference_fingerprint,started_at,finished_at,provider_poll_deadline,provider_next_poll_at,provider_last_status,provider_consecutive_failures,provider_cost_micros FROM app.run_attempts)t)s;
INSERT INTO refactor73_retained_rows SELECT 'run_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,run_id,sequence,event_type,event_idempotency_key,safe_payload,occurred_at FROM app.run_events)t)s;
INSERT INTO refactor73_retained_rows SELECT 'schema_migrations',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT version,applied_at,checksum FROM app.schema_migrations)t)s;
INSERT INTO refactor73_retained_rows SELECT 'service_template_versions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,service_template_id,version,public_name,public_description,input_schema,output_schema,availability_copy,published_at,created_at,availability_state,configuration_schema,presentation_metadata,engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint,published_by,evidence_ref FROM app.service_template_versions)t)s;
INSERT INTO refactor73_retained_rows SELECT 'service_templates',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,slug,product_family,state,created_at,current_public_version_id,access FROM app.service_templates)t)s;
INSERT INTO refactor73_retained_rows SELECT 'tenant_user_access',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT tenant_id,user_id,access_role,state,created_at,invite_id FROM app.tenant_user_access)t)s;
INSERT INTO refactor73_retained_rows SELECT 'tenants',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,display_name,state,created_at,is_internal,created_by_user_id FROM app.tenants)t)s;
INSERT INTO refactor73_retained_rows SELECT 'usage_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,run_id,attempt_id,meter_code,quantity,unit,outcome,source,reconciliation_state,observed_at FROM app.usage_events)t)s;
INSERT INTO refactor73_retained_rows SELECT 'users',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,email_normalized,password_hash,state,email_verified_at,failed_auth_count,last_failed_auth_at,created_at FROM app.users)t)s;
DO $preconditions$
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r')<>36 THEN RAISE EXCEPTION '0073_EXPECTED_36_TABLES'; END IF;
 IF EXISTS(SELECT 1 FROM app.services s WHERE s.current_version<>1 OR (SELECT count(*) FROM app.service_versions v WHERE v.tenant_id=s.tenant_id AND v.service_id=s.id)<>1)
   OR EXISTS(SELECT 1 FROM app.service_versions WHERE version<>1) THEN RAISE EXCEPTION '0073_SINGLE_SERVICE_VERSION_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_mappings WHERE state='enabled' AND environment NOT IN ('local','test'))
   OR EXISTS(SELECT service_template_version_id FROM app.provider_mappings WHERE state='enabled' GROUP BY service_template_version_id HAVING count(*)>1) THEN RAISE EXCEPTION '0073_ONE_TEST_BINDING_PER_VERSION_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM app.services s JOIN app.service_versions v ON v.tenant_id=s.tenant_id AND v.service_id=s.id WHERE
   (s.template_version_id IS NOT NULL AND s.template_version_id<>v.service_template_version_id) OR
   (s.configuration IS NOT NULL AND s.configuration<>v.validated_configuration) OR
   (s.created_by_user_id IS NOT NULL AND s.created_by_user_id IS DISTINCT FROM v.created_by_user_id)) THEN RAISE EXCEPTION '0073_SERVICE_EXPANSION_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r JOIN app.service_versions v ON v.tenant_id=r.tenant_id AND v.id=r.service_version_id WHERE r.service_id IS NOT NULL AND r.service_id<>v.service_id)
 THEN RAISE EXCEPTION '0073_RUN_EXPANSION_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_cost_holds WHERE currency_code<>'USD') OR EXISTS(SELECT 1 FROM app.run_attempts WHERE provider_cost_currency IS NOT NULL AND provider_cost_currency<>'USD')
   OR EXISTS(SELECT 1 FROM app.provider_mappings WHERE output_policy->'scraper_spending'->>'currencyCode' IS NOT NULL AND output_policy->'scraper_spending'->>'currencyCode'<>'USD') THEN RAISE EXCEPTION '0073_USD_ONLY_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_mappings m JOIN app.service_template_versions v ON v.id=m.service_template_version_id WHERE m.state='enabled'
   AND (m.adapter_version_id<>v.adapter_version_id OR v.execution_definition IS NULL OR v.definition_sha256 IS NULL OR v.provider_dataset_ciphertext IS NULL OR v.provider_dataset_fingerprint IS NULL
     OR v.execution_definition<>jsonb_build_object('capability_metadata',(SELECT capability_metadata FROM app.adapter_versions WHERE id=m.adapter_version_id),'request_schema',(SELECT request_schema FROM app.adapter_versions WHERE id=m.adapter_version_id),
       'result_schema',(SELECT result_schema FROM app.adapter_versions WHERE id=m.adapter_version_id),'error_schema',(SELECT error_schema FROM app.adapter_versions WHERE id=m.adapter_version_id),
       'operation_code',m.operation_code,'output_policy',m.output_policy,'commercial_config_version',m.commercial_config_version,'config_version',m.config_version))) THEN RAISE EXCEPTION '0073_VERIFIED_BINDING_CATCHUP_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions v JOIN app.service_templates t ON t.id=v.service_template_id WHERE t.product_family='scraper_library'
    AND v.published_at IS NOT NULL AND (v.engine IS NULL OR v.execution_definition IS NULL OR v.definition_sha256 IS NULL OR v.provider_dataset_ciphertext IS NULL OR v.published_by IS NULL OR v.evidence_ref IS NULL)) THEN RAISE EXCEPTION '0073_PUBLISHED_EXECUTION_INCOMPLETE'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions v JOIN app.service_templates t ON t.id=v.service_template_id WHERE t.product_family='marketplace_dataset'
    AND (v.engine IS NOT NULL OR v.execution_definition IS NOT NULL OR v.definition_sha256 IS NOT NULL OR v.provider_dataset_ciphertext IS NOT NULL OR v.provider_dataset_fingerprint IS NOT NULL)) THEN RAISE EXCEPTION '0073_SAMPLE_ONLY_EXECUTION_FIELDS'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions v JOIN app.adapter_versions a ON a.id=v.adapter_version_id JOIN app.adapter_definitions d ON d.id=a.adapter_definition_id
    WHERE d.code='bright_data.scraper_library.shared' AND (v.published_at IS NOT NULL OR EXISTS(SELECT 1 FROM app.runs r WHERE r.service_template_version_id=v.id AND r.internal_status NOT IN ('UPSTREAM_REJECTED','UPSTREAM_FAILED','CANCELLED','COMPLETED','PROCESSING_FAILED','EXPIRED')))) THEN RAISE EXCEPTION '0073_LEGACY_SHARED_ENGINE_PIN_REQUIRES_SEPARATE_VERSION'; END IF;
 IF EXISTS(SELECT recovery_event_id FROM app.dead_letter_recovery_intents GROUP BY recovery_event_id HAVING count(*)>1) THEN RAISE EXCEPTION '0073_AMBIGUOUS_RECOVERY_LINEAGE'; END IF;
 IF EXISTS(SELECT 1 FROM app.dead_letter_recovery_intents i LEFT JOIN app.outbox_events a ON a.id=i.original_event_id LEFT JOIN app.outbox_events b ON b.id=i.recovery_event_id
   WHERE a.id IS NULL OR b.id IS NULL OR a.aggregate_id<>b.aggregate_id OR a.tenant_id IS DISTINCT FROM b.tenant_id) THEN RAISE EXCEPTION '0073_RECOVERY_LINEAGE_MISMATCH'; END IF;
END $preconditions$;
-- Catch up old writers since 0072 without changing clocks or inventing history.
ALTER TABLE app.services DISABLE TRIGGER services_touch_updated_at;
ALTER TABLE app.runs DISABLE TRIGGER runs_touch_updated_at;
UPDATE app.services s SET template_version_id=v.service_template_version_id,configuration=v.validated_configuration,created_by_user_id=v.created_by_user_id
  FROM app.service_versions v WHERE v.tenant_id=s.tenant_id AND v.service_id=s.id AND v.version=1;
UPDATE app.runs r SET service_id=v.service_id FROM app.service_versions v WHERE v.tenant_id=r.tenant_id AND v.id=r.service_version_id;
UPDATE app.runs r SET cost_state=h.state,estimated_cost_micros=h.estimated_amount_micros,final_cost_micros=h.finalized_amount_micros
  FROM app.provider_cost_holds h WHERE h.tenant_id=r.tenant_id AND h.run_id=r.id;
ALTER TABLE app.services ENABLE TRIGGER services_touch_updated_at;
ALTER TABLE app.runs ENABLE TRIGGER runs_touch_updated_at;
DO $catchup$
BEGIN
 IF EXISTS(SELECT 1 FROM app.services s JOIN app.service_versions v ON v.tenant_id=s.tenant_id AND v.service_id=s.id WHERE
    (s.template_version_id,s.configuration,s.created_by_user_id) IS DISTINCT FROM (v.service_template_version_id,v.validated_configuration,v.created_by_user_id)) THEN RAISE EXCEPTION '0073_SERVICE_VALUE_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r LEFT JOIN app.service_versions v ON v.tenant_id=r.tenant_id AND v.id=r.service_version_id
    WHERE v.id IS NULL OR r.service_id IS DISTINCT FROM v.service_id OR r.service_template_version_id<>v.service_template_version_id) THEN RAISE EXCEPTION '0073_RUN_SERVICE_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r LEFT JOIN app.provider_cost_holds h ON h.tenant_id=r.tenant_id AND h.run_id=r.id WHERE h.id IS NULL OR
    (r.cost_state,r.estimated_cost_micros,r.final_cost_micros) IS DISTINCT FROM(h.state,h.estimated_amount_micros,h.finalized_amount_micros)) THEN RAISE EXCEPTION '0073_RUN_COST_MISMATCH'; END IF;
END $catchup$;
ALTER TABLE app.outbox_events ADD COLUMN recovered_from_event_id uuid REFERENCES app.outbox_events(id) ON DELETE RESTRICT;
UPDATE app.outbox_events e SET recovered_from_event_id=i.original_event_id FROM app.dead_letter_recovery_intents i WHERE e.id=i.recovery_event_id;
CREATE UNIQUE INDEX outbox_events_recovered_from_unique ON app.outbox_events(recovered_from_event_id);
CREATE TEMP TABLE refactor73_source_projection AS SELECT 'services'::text table_name,count(*) n,md5(coalesce(string_agg(d,'' ORDER BY d),'')) digest FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,template_version_id,name,configuration,state,created_by_user_id,created_at FROM app.services)t)s
UNION ALL SELECT 'runs',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,tenant_id,service_id,service_template_version_id,created_by_user_id,trace_id,commercial_config_version,internal_status,state_version,retryable,retry_of_run_id,customer_error_code,completed_at,created_at,updated_at,validated_input,cost_state,estimated_cost_micros,final_cost_micros FROM app.runs)t)s
UNION ALL SELECT 'outbox_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM(SELECT id,aggregate_type,aggregate_id,tenant_id,topic,ordering_key,payload,schema_version,available_at,claimed_at,claim_token,published_at,delivery_attempts,created_at,recovered_from_event_id FROM app.outbox_events)t)s;
INSERT INTO refactor73_retained_rows SELECT * FROM refactor73_source_projection;
DROP POLICY artifacts_shared_scraper_owner_read ON app.artifacts;
DROP POLICY audit_events_amazon_input_v4_definer_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_provider_sample_expiry_definer_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_sample_expiry_definer_insert ON app.audit_events;
DROP POLICY audit_events_marketplace_sample_fixture_definer_insert ON app.audit_events;
DROP POLICY audit_events_shared_scraper_draft_insert ON app.audit_events;
DROP POLICY provider_cost_holds_marketplace_execution_definer ON app.provider_cost_holds;
DROP POLICY provider_cost_holds_tenant_isolation ON app.provider_cost_holds;
DROP POLICY service_template_versions_amazon_input_v4_definer_insert ON app.service_template_versions;
DROP POLICY service_template_versions_amazon_input_v4_definer_select ON app.service_template_versions;
DROP POLICY service_template_versions_amazon_qualification_definer_select ON app.service_template_versions;
DROP POLICY service_template_versions_amazon_release_definer_insert ON app.service_template_versions;
DROP POLICY service_template_versions_amazon_release_definer_select ON app.service_template_versions;
DROP POLICY service_template_versions_customer_read ON app.service_template_versions;
DROP POLICY service_template_versions_m8_fixture_owner_select ON app.service_template_versions;
DROP POLICY service_template_versions_marketplace_m10_owner_insert ON app.service_template_versions;
DROP POLICY service_template_versions_marketplace_m10_owner_select ON app.service_template_versions;
DROP POLICY service_template_versions_marketplace_m2_definer_insert ON app.service_template_versions;
DROP POLICY service_template_versions_marketplace_m2_definer_select ON app.service_template_versions;
DROP POLICY service_template_versions_shared_scraper_draft_insert ON app.service_template_versions;
DROP POLICY template_versions_shared_scraper_owner_read ON app.service_template_versions;
DROP POLICY service_versions_shared_scraper_owner_read ON app.service_versions;
DROP POLICY service_versions_tenant_isolation ON app.service_versions;
DROP TRIGGER outbox_events_touch_updated_at ON app.outbox_events;
DROP TRIGGER provider_mappings_assign_resource_aad_mapping_id ON app.provider_mappings;
DROP TRIGGER run_attempts_touch_updated_at ON app.run_attempts;
DROP TRIGGER run_attempts_validate_version_pins ON app.run_attempts;
DROP TRIGGER run_events_validate_attempt ON app.run_events;
DROP TRIGGER runs_guard_status_writer ON app.runs;
DROP TRIGGER runs_validate_version_pins ON app.runs;
DROP TRIGGER service_templates_touch_updated_at ON app.service_templates;
DROP TRIGGER service_versions_validate_template_pin ON app.service_versions;
DROP TRIGGER services_touch_updated_at ON app.services;
DROP FUNCTION app.assign_provider_resource_aad_mapping_id();
DROP FUNCTION app.checkpoint_provider_poll_fenced(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_source_attempt_id uuid, p_max_elapsed_ms integer, p_status text, p_failure boolean, p_delay_ms bigint);
DROP FUNCTION app.claim_job_outbox_events(p_consumer text, p_limit integer, p_claim_ttl interval);
DROP FUNCTION app.claim_outbox_events(p_consumer text, p_limit integer, p_claim_ttl interval);
DROP FUNCTION app.claim_run_attempt(p_run_id uuid, p_kind text, p_lease_ttl interval);
DROP FUNCTION app.complete_run_execution_with_usage(p_run_id uuid, p_expected_state_version bigint, p_event_idempotency_key text, p_attempt_id uuid, p_fence_token uuid, p_attempt_outcome_class text, p_normalized_artifact_id uuid, p_meter_code text, p_unit text, p_safe_payload jsonb);
DROP FUNCTION app.complete_run_reconciliation(p_run_id uuid, p_expected_state_version bigint, p_to_internal_status text, p_event_type text, p_event_idempotency_key text, p_reconciliation_attempt_id uuid, p_reconciliation_fence_token uuid, p_source_attempt_id uuid, p_source_attempt_state text, p_source_outcome_class text, p_reconciliation_outcome_class text, p_customer_error_code text, p_retryable boolean, p_safe_payload jsonb);
DROP FUNCTION app.complete_run_reconciliation_with_usage(p_run_id uuid, p_expected_state_version bigint, p_event_idempotency_key text, p_reconciliation_attempt_id uuid, p_reconciliation_fence_token uuid, p_source_attempt_id uuid, p_reconciliation_outcome_class text, p_normalized_artifact_id uuid, p_meter_code text, p_unit text, p_safe_payload jsonb);
DROP FUNCTION app.finish_run_attempt_claim(p_attempt_id uuid, p_fence_token uuid, p_state text, p_outcome_class text);
DROP FUNCTION app.get_platform_status(p_environment text);
DROP FUNCTION app.get_platform_status_v2(p_environment text);
DROP FUNCTION app.get_usage_summary(p_from timestamp with time zone, p_to timestamp with time zone);
DROP FUNCTION app.inspect_run_reconciliation(p_run_id uuid);
DROP FUNCTION app.is_run_cancellation_requested_fenced(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid);
DROP FUNCTION app.list_usage_events(p_from timestamp with time zone, p_to timestamp with time zone, p_before_observed_at timestamp with time zone, p_before_id uuid, p_fetch_limit integer);
DROP FUNCTION app.lock_run_for_cancellation(p_run_id uuid);
DROP FUNCTION app.lock_run_for_retry(p_run_id uuid);
DROP FUNCTION app.lock_service_for_run(p_service_id uuid);
DROP FUNCTION app.mark_outbox_event_published(p_event_id uuid, p_claim_token uuid);
DROP FUNCTION app.publish_amazon_products_input_contract_v4(p_expected_environment text, p_restricted_reference text, p_evidence_hash bytea, p_reviewer text, p_reason text, p_expires_at timestamp with time zone);
DROP FUNCTION app.record_marketplace_known_submission_outcome_fenced(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_outcome text);
DROP FUNCTION app.record_marketplace_snapshot_observation_fenced(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_source_attempt_id uuid, p_status text, p_dataset_size bigint, p_file_size bigint, p_cost_micros bigint, p_currency_code text);
DROP FUNCTION app.record_provider_reference_fenced(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_provider_reference_ciphertext bytea, p_provider_reference_fingerprint bytea);
DROP FUNCTION app.record_success_usage_observation(p_run_id uuid, p_attempt_id uuid, p_artifact_id uuid, p_meter_code text, p_unit text);
DROP FUNCTION app.recover_dead_lettered_run_command(p_original_event_id uuid, p_reason_code text);
DROP FUNCTION app.renew_run_attempt_claim(p_attempt_id uuid, p_fence_token uuid, p_lease_ttl interval);
DROP FUNCTION app.require_phase5_mock_run_capacity(p_environment text);
DROP FUNCTION app.require_shared_scraper_run_capacity(p_environment text, p_template_version_id uuid, p_mapping_id uuid, p_input_count integer);
DROP FUNCTION app.require_validated_normalized_artifact(p_run_id uuid, p_attempt_id uuid, p_artifact_id uuid);
DROP FUNCTION app.resolve_marketplace_execution_plan_fixture(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_reconciliation boolean, p_source_attempt_id uuid);
DROP FUNCTION app.resolve_provider_execution_plan(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid);
DROP FUNCTION app.resolve_provider_execution_plan_v2(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid);
DROP FUNCTION app.resolve_provider_executor_identity(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid);
DROP FUNCTION app.resolve_provider_executor_kind(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid);
DROP FUNCTION app.resolve_provider_normalization_plan(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_source_attempt_id uuid);
DROP FUNCTION app.resolve_provider_reconciliation_plan(p_run_id uuid, p_reconciliation_attempt_id uuid, p_reconciliation_fence_token uuid);
DROP FUNCTION app.resolve_provider_reconciliation_plan_v2(p_run_id uuid, p_reconciliation_attempt_id uuid, p_reconciliation_fence_token uuid);
DROP FUNCTION app.resolve_shared_scraper_admission_contract(p_template_version_id uuid, p_mapping_id uuid);
DROP FUNCTION app.resolve_shared_scraper_execution_plan(p_run_id uuid, p_attempt_id uuid, p_fence_token uuid, p_phase text, p_source_attempt_id uuid);
DROP FUNCTION app.schedule_run_reconciliation(p_run_id uuid, p_reason_code text);
DROP FUNCTION app.stage_shared_scraper_operation_v1(p_manifest jsonb, p_restricted_reference text, p_actor text, p_expected_database text);
DROP FUNCTION app.transition_run(p_run_id uuid, p_expected_state_version bigint, p_to_internal_status text, p_event_type text, p_event_idempotency_key text, p_attempt_id uuid, p_customer_error_code text, p_retryable boolean, p_safe_payload jsonb);
DROP FUNCTION app.transition_run_fenced(p_run_id uuid, p_expected_state_version bigint, p_to_internal_status text, p_event_type text, p_event_idempotency_key text, p_attempt_id uuid, p_fence_token uuid, p_customer_error_code text, p_retryable boolean, p_safe_payload jsonb);
DROP FUNCTION app.validate_attempt_version_pins();
DROP FUNCTION app.validate_event_attempt_belongs_to_run();
DROP FUNCTION app.validate_service_template_version_pin();
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
  WHERE p_template_slug = 'linkedin-posts'
    AND p_template_version = 1
    AND template.slug = p_template_slug
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = p_template_version
    AND version.availability_state = 'coming_soon'
    AND version.published_at IS NULL
    AND version.presentation_metadata->>'sample_metadata_checksum' ~ '^[0-9a-f]{64}$'
    AND version.engine IS NULL
    AND version.execution_definition IS NULL
    AND version.provider_dataset_ciphertext IS NULL;
$function$
;
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
  WHERE p_as_of IS NOT NULL
    AND (p_template_slug IS NULL OR template.slug = p_template_slug)
    AND template.slug IN ('linkedin-posts', 'linkedin-people')
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.published_at IS NULL
    AND version.presentation_metadata ? 'provider_record_count'
    AND version.engine IS NULL
    AND version.execution_definition IS NULL
    AND version.provider_dataset_ciphertext IS NULL
  ORDER BY template.slug;
$function$
;
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
    target_id, outcome, trace_id, ip_fingerprint, safe_diff
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
$function$
;
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
    trace_id,
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
$function$
;
-- Invoker integrity protection. Business lifecycle rules reside in TypeScript.
CREATE OR REPLACE FUNCTION app.guard_run_admission_fields() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.service_id,NEW.service_template_version_id,NEW.created_by_user_id,NEW.trace_id,
     NEW.commercial_config_version,NEW.validated_input,NEW.estimated_cost_micros,NEW.retry_of_run_id,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.service_id,OLD.service_template_version_id,OLD.created_by_user_id,OLD.trace_id,
     OLD.commercial_config_version,OLD.validated_input,OLD.estimated_cost_micros,OLD.retry_of_run_id,OLD.created_at)
 THEN RAISE EXCEPTION 'RUN_ADMISSION_FIELDS_ARE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE OR REPLACE FUNCTION app.guard_run_status_writer() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF (NEW.internal_status,NEW.state_version,NEW.retryable,NEW.customer_error_code,NEW.completed_at,NEW.cost_state,NEW.final_cost_micros)
 IS DISTINCT FROM(OLD.internal_status,OLD.state_version,OLD.retryable,OLD.customer_error_code,OLD.completed_at,OLD.cost_state,OLD.final_cost_micros)
 AND current_user<>'dhumi_job_manager' THEN RAISE EXCEPTION 'ONLY_WORKER_MAY_CHANGE_RUN_LIFECYCLE' USING ERRCODE='42501'; END IF;
 IF NEW.internal_status IS DISTINCT FROM OLD.internal_status AND NEW.state_version<>OLD.state_version+1
 THEN RAISE EXCEPTION 'RUN_LIFECYCLE_VERSION_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER runs_guard_status_writer BEFORE UPDATE ON app.runs FOR EACH ROW EXECUTE FUNCTION app.guard_run_status_writer();
CREATE OR REPLACE FUNCTION app.validate_run_version_pins() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.services s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.service_id AND s.template_version_id=NEW.service_template_version_id)
 THEN RAISE EXCEPTION 'RUN_SERVICE_TEMPLATE_PIN_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER runs_validate_version_pins BEFORE INSERT ON app.runs FOR EACH ROW EXECUTE FUNCTION app.validate_run_version_pins();
CREATE OR REPLACE FUNCTION app.validate_run_retry_lineage() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF NEW.retry_of_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.runs r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.retry_of_run_id AND r.service_id=NEW.service_id)
 THEN RAISE EXCEPTION 'RUN_RETRY_SERVICE_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE FUNCTION app.guard_service_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.template_version_id,NEW.configuration,NEW.created_by_user_id,NEW.created_at)
 IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.template_version_id,OLD.configuration,OLD.created_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'SERVICE_CONFIGURATION_AND_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER services_identity_immutable BEFORE UPDATE ON app.services FOR EACH ROW EXECUTE FUNCTION app.guard_service_identity();
REVOKE ALL ON FUNCTION app.guard_service_identity() FROM PUBLIC;
CREATE FUNCTION app.guard_template_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF (NEW.id,NEW.slug,NEW.product_family,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.slug,OLD.product_family,OLD.created_at)
 THEN RAISE EXCEPTION 'TEMPLATE_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;RETURN NEW;
END $body$;
CREATE TRIGGER templates_identity_immutable BEFORE UPDATE ON app.service_templates FOR EACH ROW EXECUTE FUNCTION app.guard_template_identity();
REVOKE ALL ON FUNCTION app.guard_template_identity() FROM PUBLIC;
DROP TRIGGER service_template_versions_immutable ON app.service_template_versions;
CREATE FUNCTION app.guard_template_version_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $body$
DECLARE family text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TEMPLATE_VERSION_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
 IF (OLD.published_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) OR
    (NEW.id,NEW.service_template_id,NEW.version,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.service_template_id,OLD.version,OLD.created_at)
 THEN RAISE EXCEPTION 'PUBLISHED_TEMPLATE_VERSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
 SELECT product_family INTO family FROM app.service_templates WHERE id=NEW.service_template_id;
 IF family='marketplace_dataset' AND (NEW.engine IS NOT NULL OR NEW.execution_definition IS NOT NULL OR NEW.definition_sha256 IS NOT NULL OR NEW.provider_dataset_ciphertext IS NOT NULL OR NEW.provider_dataset_fingerprint IS NOT NULL)
 THEN RAISE EXCEPTION 'SAMPLE_ONLY_VERSION_NOT_EXECUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.published_at IS NOT NULL AND family='scraper_library' AND
   (NEW.engine IS NULL OR NEW.execution_definition IS NULL OR NEW.definition_sha256 IS NULL OR NEW.provider_dataset_ciphertext IS NULL OR NEW.provider_dataset_fingerprint IS NULL OR NEW.published_by IS NULL OR NEW.evidence_ref IS NULL)
 THEN RAISE EXCEPTION 'PUBLISHED_SCRAPER_EXECUTION_INCOMPLETE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER service_template_versions_immutable BEFORE DELETE OR UPDATE ON app.service_template_versions FOR EACH ROW EXECUTE FUNCTION app.guard_template_version_identity();
REVOKE ALL ON FUNCTION app.guard_template_version_identity() FROM PUBLIC;
ALTER TABLE app.service_template_versions ADD CONSTRAINT template_execution_identity_pair CHECK((execution_definition IS NULL)=(definition_sha256 IS NULL));
ALTER TABLE app.service_template_versions ADD CONSTRAINT template_execution_engine_closed CHECK(engine IS NULL OR engine IN('amazon.v1','scraper.v1'));
ALTER TABLE app.service_template_versions ADD CONSTRAINT template_execution_hash_length CHECK(definition_sha256 IS NULL OR octet_length(definition_sha256)=32);
GRANT UPDATE(id,state,current_public_version_id) ON app.service_templates TO dhumi_operator;
GRANT UPDATE(id,engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint,published_at,published_by,evidence_ref,availability_state) ON app.service_template_versions TO dhumi_operator;
GRANT UPDATE(id) ON app.service_templates TO dhumi_admission,dhumi_job_manager;
CREATE POLICY templates_0073_admission_lock ON app.service_templates FOR UPDATE TO dhumi_admission USING(access='all' OR EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=app.current_tenant_id() AND a.service_template_id=id)) WITH CHECK(false);
CREATE POLICY templates_0073_worker_lock ON app.service_templates FOR UPDATE TO dhumi_job_manager USING(true) WITH CHECK(false);
GRANT SELECT ON app.service_templates,app.service_template_versions TO dhumi_operator;
GRANT INSERT(id,slug,product_family,state,access) ON app.service_templates TO dhumi_operator;
GRANT INSERT(id,service_template_id,version,public_name,public_description,input_schema,output_schema,availability_copy,published_at,availability_state,configuration_schema,presentation_metadata,engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint,published_by,evidence_ref)
 ON app.service_template_versions TO dhumi_operator;
ALTER TABLE app.services ALTER COLUMN template_version_id SET NOT NULL,ALTER COLUMN configuration SET NOT NULL;
ALTER TABLE app.runs ALTER COLUMN service_id SET NOT NULL,ALTER COLUMN estimated_cost_micros SET NOT NULL,
 ALTER COLUMN cost_state SET NOT NULL,ALTER COLUMN cost_state SET DEFAULT 'held',ALTER COLUMN state_version SET DEFAULT 1;
ALTER TABLE app.services ADD CONSTRAINT services_configuration_object CHECK(jsonb_typeof(configuration)='object');
ALTER TABLE app.runs ADD CONSTRAINT runs_cost_values CHECK((cost_state='finalized' AND final_cost_micros IS NOT NULL) OR (cost_state IN('held','released')));
DO $trace$
DECLARE cutover timestamptz:=clock_timestamp();
BEGIN
 EXECUTE format('ALTER TABLE app.runs ADD CONSTRAINT runs_trace_cutover_check CHECK(created_at<%L::timestamptz OR trace_id IS NOT NULL)',cutover);
END $trace$;

-- The worker-owned aggregate sees every organization's queued outbox under FORCE RLS.
-- Admission receives only the derived counts; it cannot assume the dispatcher's role.
ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_0073_scope ON app.outbox_events TO dhumi_admission,dhumi_job_manager USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY outbox_0073_identity ON app.outbox_events FOR INSERT TO dhumi_identity WITH CHECK(tenant_id IS NULL AND aggregate_type='auth_session');
CREATE POLICY outbox_0073_global_worker_read ON app.outbox_events FOR SELECT TO dhumi_outbox_dispatcher,dhumi_operator USING(true);
CREATE POLICY outbox_0073_global_dispatcher_update ON app.outbox_events FOR UPDATE TO dhumi_outbox_dispatcher USING(true) WITH CHECK(true);
CREATE POLICY outbox_0073_operator_insert ON app.outbox_events FOR INSERT TO dhumi_operator WITH CHECK(tenant_id=app.current_tenant_id() AND topic='jobs.recover');
CREATE POLICY outbox_0073_operator_lock ON app.outbox_events FOR UPDATE TO dhumi_operator USING(true) WITH CHECK(false);
CREATE POLICY runs_0073_operator_read ON app.runs FOR SELECT TO dhumi_operator USING(tenant_id=app.current_tenant_id());
CREATE POLICY runs_0073_operator_lock ON app.runs FOR UPDATE TO dhumi_operator USING(tenant_id=app.current_tenant_id()) WITH CHECK(false);
CREATE POLICY audit_0073_operator_insert ON app.audit_events FOR INSERT TO dhumi_operator WITH CHECK(tenant_id IS NULL OR tenant_id=app.current_tenant_id());
CREATE POLICY audit_0073_owner_fixture_insert ON app.audit_events FOR INSERT TO dhumi_owner WITH CHECK(action LIKE 'marketplace.%');
CREATE POLICY provider_calls_0073_customer_read ON app.provider_calls FOR SELECT TO dhumi_customer_api USING(organization_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE POLICY audit_0073_customer_read ON app.audit_events FOR SELECT TO dhumi_customer_api USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL);
CREATE VIEW app.admission_queue_health AS SELECT count(*) FILTER(WHERE topic='jobs.execute' AND published_at IS NULL)::bigint pending_jobs,
 min(created_at) FILTER(WHERE topic='jobs.execute' AND published_at IS NULL AND available_at<=statement_timestamp()) oldest_due_job FROM app.outbox_events;
GRANT CREATE ON SCHEMA app TO dhumi_outbox_dispatcher;
ALTER VIEW app.admission_queue_health OWNER TO dhumi_outbox_dispatcher;
REVOKE CREATE ON SCHEMA app FROM dhumi_outbox_dispatcher;
REVOKE ALL ON app.admission_queue_health FROM PUBLIC;
GRANT SELECT ON app.admission_queue_health TO dhumi_admission;

-- Replace policies tied to discarded Service pins/public status while retaining organization isolation.
DROP POLICY IF EXISTS service_templates_customer_read ON app.service_templates;
CREATE POLICY service_templates_0073_customer_read ON app.service_templates FOR SELECT TO dhumi_customer_api USING(
 access='all' AND state IN('published','disabled') AND current_public_version_id IS NOT NULL OR app.current_user_id() IS NOT NULL AND
 (access='all' OR EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=app.current_tenant_id() AND a.service_template_id=id)));
DROP POLICY IF EXISTS service_template_versions_customer_read ON app.service_template_versions;
CREATE POLICY service_template_versions_0073_customer_read ON app.service_template_versions FOR SELECT TO dhumi_customer_api USING(
 EXISTS(SELECT 1 FROM app.service_templates t WHERE t.id=service_template_versions.service_template_id AND t.current_public_version_id=service_template_versions.id AND t.state IN('published','disabled') AND
   (t.access='all' OR app.current_user_id() IS NOT NULL AND EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=app.current_tenant_id() AND a.service_template_id=t.id)))
 OR app.current_user_id() IS NOT NULL AND EXISTS(SELECT 1 FROM app.services s WHERE s.tenant_id=app.current_tenant_id() AND s.template_version_id=service_template_versions.id));
CREATE POLICY templates_0073_operator_all ON app.service_templates TO dhumi_operator USING(true) WITH CHECK(true);
CREATE POLICY template_versions_0073_operator_all ON app.service_template_versions TO dhumi_operator USING(true) WITH CHECK(true);
CREATE POLICY templates_0073_owner_all ON app.service_templates TO dhumi_owner USING(true) WITH CHECK(true);
CREATE POLICY template_versions_0073_owner_all ON app.service_template_versions TO dhumi_owner USING(true) WITH CHECK(true);

-- Explicitly revoke former column-level INSERT/UPDATE permissions as well as whole-table permissions.
DO $grants$
DECLARE item record;capability text;columns text;
BEGIN
 FOR item IN SELECT unnest(ARRAY['runs','services','run_attempts','run_events','usage_events','audit_events','outbox_events']) table_name LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid=('app.'||item.table_name)::regclass AND attnum>0 AND NOT attisdropped;
  FOREACH capability IN ARRAY ARRAY['dhumi_customer_api','dhumi_admission','dhumi_job_manager','dhumi_result_recorder','dhumi_outbox_dispatcher','dhumi_operator','dhumi_identity'] LOOP
   EXECUTE format('REVOKE INSERT(%s),UPDATE(%s) ON app.%I FROM %I',columns,columns,item.table_name,capability);
   EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON app.%I FROM %I',item.table_name,capability);
  END LOOP;
 END LOOP;
END $grants$;
GRANT INSERT(id,tenant_id,service_id,service_template_version_id,created_by_user_id,trace_id,commercial_config_version,validated_input,estimated_cost_micros,retry_of_run_id)
 ON app.runs TO dhumi_admission;
GRANT SELECT(id,tenant_id,service_id,service_template_version_id,created_by_user_id,trace_id,commercial_config_version,internal_status,state_version,retryable,retry_of_run_id,customer_error_code,completed_at,created_at,updated_at,validated_input)
 ON app.runs TO dhumi_admission;
-- UPDATE(id) is only the PostgreSQL row-lock permission; invoker immutable guards prohibit changing it.
GRANT UPDATE(id) ON app.runs TO dhumi_admission,dhumi_operator;
GRANT INSERT(id,tenant_id,template_version_id,name,configuration,state,created_by_user_id) ON app.services TO dhumi_admission;
GRANT SELECT(id,tenant_id,template_version_id,name,configuration,state,created_by_user_id,created_at) ON app.services TO dhumi_admission,dhumi_customer_api,dhumi_job_manager;
GRANT UPDATE(id) ON app.services TO dhumi_admission,dhumi_job_manager;
GRANT SELECT(id,tenant_id,service_id,service_template_version_id,created_by_user_id,internal_status,retryable,customer_error_code,created_at,updated_at,completed_at)
 ON app.runs TO dhumi_customer_api;
GRANT SELECT(retry_of_run_id) ON app.runs TO dhumi_customer_api;
GRANT SELECT ON app.schema_migrations TO dhumi_identity,dhumi_job_manager,dhumi_outbox_dispatcher;
GRANT SELECT ON app.schema_migrations TO dhumi_operator;
GRANT SELECT(id,email_normalized,state) ON app.users TO dhumi_operator;
CREATE POLICY users_0073_operator_lookup ON app.users FOR SELECT TO dhumi_operator USING(state='active');
GRANT SELECT(id,service_template_id,version,public_name,public_description,input_schema,output_schema,availability_copy,published_at,created_at,availability_state,configuration_schema,presentation_metadata,engine,published_by,evidence_ref)
 ON app.service_template_versions TO dhumi_customer_api;
GRANT SELECT(engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint,published_by,evidence_ref,configuration_schema)
 ON app.service_template_versions TO dhumi_admission;
GRANT SELECT(is_internal) ON app.tenants TO dhumi_admission,dhumi_customer_api,dhumi_job_manager;
GRANT SELECT(id,state,is_internal) ON app.tenants TO dhumi_job_manager;
GRANT SELECT ON app.run_attempts TO dhumi_admission,dhumi_job_manager;
GRANT UPDATE(id) ON app.run_attempts TO dhumi_admission;
GRANT INSERT(tenant_id,run_id,attempt_number,kind,state,worker_lease_expires_at) ON app.run_attempts TO dhumi_job_manager;
GRANT UPDATE(state,outcome_class,fence_token,worker_lease_expires_at,provider_reference_ciphertext,provider_reference_fingerprint,finished_at,provider_poll_deadline,provider_next_poll_at,provider_last_status,provider_consecutive_failures,provider_cost_micros) ON app.run_attempts TO dhumi_job_manager;
GRANT UPDATE(internal_status,state_version,retryable,customer_error_code,completed_at,cost_state,final_cost_micros) ON app.runs TO dhumi_job_manager;
GRANT SELECT ON app.runs,app.services,app.service_templates,app.service_template_versions,app.artifacts,app.usage_events,app.run_events,app.audit_events TO dhumi_job_manager;
GRANT SELECT(id,tenant_id,run_id,sequence,event_type,safe_payload) ON app.run_events TO dhumi_operator;
GRANT INSERT(id,tenant_id,run_id,sequence,event_type,event_idempotency_key,safe_payload) ON app.run_events TO dhumi_admission,dhumi_job_manager;
GRANT SELECT(id,tenant_id,run_id,sequence,event_type,event_idempotency_key,safe_payload,occurred_at) ON app.run_events TO dhumi_admission;
GRANT SELECT(id,tenant_id,run_id,started_at,finished_at) ON app.run_attempts TO dhumi_customer_api;
GRANT SELECT(tenant_id,run_id,sequence,event_type,occurred_at) ON app.run_events TO dhumi_customer_api;
GRANT SELECT(id,tenant_id,run_id,attempt_id,meter_code,quantity,unit,outcome,source,reconciliation_state,observed_at) ON app.usage_events TO dhumi_customer_api;
GRANT SELECT(id,organization_id,run_id,initiated_by_user_id,attempt_id,purpose,state,http_status,prepared_at,finished_at) ON app.provider_calls TO dhumi_customer_api;
GRANT SELECT(id,tenant_id,actor_user_id,action,target_type,target_id,outcome,occurred_at) ON app.audit_events TO dhumi_customer_api;
GRANT INSERT(tenant_id,run_id,attempt_id,meter_code,quantity,unit,outcome,source,reconciliation_state,observed_at) ON app.usage_events TO dhumi_job_manager;
GRANT INSERT(id,tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,ip_fingerprint,safe_diff) ON app.audit_events TO dhumi_admission,dhumi_customer_api,dhumi_identity,dhumi_job_manager,dhumi_operator;
GRANT INSERT(id,aggregate_type,aggregate_id,tenant_id,topic,ordering_key,payload,schema_version,recovered_from_event_id) ON app.outbox_events TO dhumi_admission,dhumi_job_manager,dhumi_operator;
GRANT SELECT ON app.outbox_events TO dhumi_outbox_dispatcher,dhumi_operator,dhumi_job_manager;
GRANT UPDATE(id) ON app.outbox_events TO dhumi_operator;
GRANT UPDATE(claimed_at,claim_token,published_at,delivery_attempts) ON app.outbox_events TO dhumi_outbox_dispatcher;
GRANT SELECT(tenant_id,run_id,sequence) ON app.run_events TO dhumi_admission;
GRANT SELECT(id,tenant_id,service_id,service_template_version_id,internal_status,state_version,cost_state) ON app.runs TO dhumi_operator;
GRANT INSERT(tenant_id,run_id,attempt_id,kind,artifact_version,object_key,content_type,content_encoding,byte_count,checksum,schema_version,record_count,state,expires_at) ON app.artifacts TO dhumi_result_recorder;
-- Existing identity session/revocation outbox remains authorized; no new login or credential.
GRANT INSERT(id,aggregate_type,aggregate_id,tenant_id,topic,ordering_key,payload,schema_version) ON app.outbox_events TO dhumi_identity;
CREATE FUNCTION app.guard_outbox_command_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $body$
BEGIN
 IF (NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.tenant_id,NEW.topic,NEW.ordering_key,NEW.payload,NEW.schema_version,NEW.created_at,NEW.recovered_from_event_id)
 IS DISTINCT FROM(OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.tenant_id,OLD.topic,OLD.ordering_key,OLD.payload,OLD.schema_version,OLD.created_at,OLD.recovered_from_event_id)
 THEN RAISE EXCEPTION 'OUTBOX_COMMAND_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $body$;
CREATE TRIGGER outbox_command_immutable BEFORE UPDATE ON app.outbox_events FOR EACH ROW EXECUTE FUNCTION app.guard_outbox_command_identity();
REVOKE ALL ON FUNCTION app.guard_outbox_command_identity() FROM PUBLIC;
CREATE UNIQUE INDEX provider_calls_one_submission_per_attempt ON app.provider_calls(attempt_id) WHERE purpose='run_submit';

ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_cancel_semantics_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_run_cancel_semantics_check CHECK (((operation_code <> 'runs.cancel'::text) OR ((scope_kind = 'tenant'::text) AND (((state = 'in_progress'::text) AND (response_status IS NULL) AND (resource_type IS NULL) AND (resource_id IS NULL) AND (related_resource_id IS NULL) AND (response_body_reference IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (response_status = 202) AND (resource_type = 'run'::text) AND (resource_id IS NOT NULL) AND (related_resource_id IS NULL) AND (response_body_reference = 'inline_json_v1'::text) AND (response_body IS NOT NULL) AND (response_body ?& ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text]) AND ((response_body - ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text]) = '{}'::jsonb) AND ((response_body ->> 'id'::text) = (resource_id)::text) AND (jsonb_typeof((response_body -> 'service_id'::text)) = 'string'::text) AND ((response_body ->> 'status'::text) IN ('queued','running')) AND ((response_body -> 'error_code'::text) = 'null'::jsonb) AND ((response_body -> 'retryable'::text) = 'false'::jsonb) AND (jsonb_typeof((response_body -> 'created_at'::text)) = 'string'::text) AND (jsonb_typeof((response_body -> 'updated_at'::text)) = 'string'::text) AND ((response_body -> 'completed_at'::text) = 'null'::jsonb) AND (completed_at IS NOT NULL))))));
ALTER TABLE app.run_events ADD CONSTRAINT run_events_cancel_actor_shape CHECK(event_type<>'cancellation_requested' OR
 (jsonb_typeof(safe_payload)='object' AND safe_payload ? 'status' AND coalesce(safe_payload->>'status' IN ('queued','running'),false) AND safe_payload-ARRAY['status','initiated_by_user_id']='{}'::jsonb AND
  (NOT(safe_payload ? 'initiated_by_user_id') OR coalesce(safe_payload->>'initiated_by_user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false))));
ALTER TABLE app.outbox_events DROP CONSTRAINT outbox_events_jobs_execute_shape_check;
ALTER TABLE app.outbox_events ADD CONSTRAINT outbox_events_jobs_execute_shape_check CHECK(topic<>'jobs.execute' OR
 (aggregate_type='run' AND tenant_id IS NOT NULL AND ordering_key=aggregate_id::text AND schema_version=1 AND jsonb_typeof(payload)='object' AND payload ? 'run_id' AND coalesce(payload->>'run_id'=aggregate_id::text,false) AND
  payload-ARRAY['run_id','initiated_by_user_id','trace_id']='{}'::jsonb AND (topic<>'jobs.execute' OR NOT(payload ? 'initiated_by_user_id')) AND
  (NOT(payload ? 'initiated_by_user_id') OR coalesce(payload->>'initiated_by_user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)) AND
  (NOT(payload ? 'trace_id') OR coalesce(payload->>'trace_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false))));
ALTER TABLE app.outbox_events DROP CONSTRAINT outbox_events_jobs_cancel_shape_check;
ALTER TABLE app.outbox_events ADD CONSTRAINT outbox_events_jobs_cancel_shape_check CHECK(topic<>'jobs.cancel' OR
 (aggregate_type='run' AND tenant_id IS NOT NULL AND ordering_key=aggregate_id::text AND schema_version=1 AND jsonb_typeof(payload)='object' AND payload ? 'run_id' AND coalesce(payload->>'run_id'=aggregate_id::text,false) AND
  payload-ARRAY['run_id','initiated_by_user_id','trace_id']='{}'::jsonb AND (topic<>'jobs.execute' OR NOT(payload ? 'initiated_by_user_id')) AND
  (NOT(payload ? 'initiated_by_user_id') OR coalesce(payload->>'initiated_by_user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)) AND
  (NOT(payload ? 'trace_id') OR coalesce(payload->>'trace_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false))));
ALTER TABLE app.outbox_events DROP CONSTRAINT outbox_events_jobs_reconcile_shape_check;
ALTER TABLE app.outbox_events ADD CONSTRAINT outbox_events_jobs_reconcile_shape_check CHECK(topic<>'jobs.reconcile' OR
 (aggregate_type='run' AND tenant_id IS NOT NULL AND ordering_key=aggregate_id::text AND schema_version=1 AND jsonb_typeof(payload)='object' AND payload ? 'run_id' AND coalesce(payload->>'run_id'=aggregate_id::text,false) AND
  payload-ARRAY['run_id','initiated_by_user_id','trace_id']='{}'::jsonb AND (topic<>'jobs.execute' OR NOT(payload ? 'initiated_by_user_id')) AND
  (NOT(payload ? 'initiated_by_user_id') OR coalesce(payload->>'initiated_by_user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)) AND
  (NOT(payload ? 'trace_id') OR coalesce(payload->>'trace_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false))));
ALTER TABLE app.outbox_events DROP CONSTRAINT outbox_events_jobs_recover_shape_check;
ALTER TABLE app.outbox_events ADD CONSTRAINT outbox_events_jobs_recover_shape_check CHECK(topic<>'jobs.recover' OR
 (aggregate_type='run' AND tenant_id IS NOT NULL AND ordering_key=aggregate_id::text AND schema_version=1 AND jsonb_typeof(payload)='object' AND payload ? 'run_id' AND coalesce(payload->>'run_id'=aggregate_id::text,false) AND
  payload-ARRAY['run_id','initiated_by_user_id','trace_id']='{}'::jsonb AND (topic<>'jobs.execute' OR NOT(payload ? 'initiated_by_user_id')) AND
  (NOT(payload ? 'initiated_by_user_id') OR coalesce(payload->>'initiated_by_user_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)) AND
  (NOT(payload ? 'trace_id') OR coalesce(payload->>'trace_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false))));
ALTER TABLE app.service_templates DROP COLUMN updated_at;
ALTER TABLE app.service_template_versions DROP COLUMN adapter_version_id;
ALTER TABLE app.service_template_versions DROP COLUMN launch_evidence_id;
ALTER TABLE app.service_template_versions DROP COLUMN effective_at;
ALTER TABLE app.services DROP COLUMN service_template_id;
ALTER TABLE app.services DROP COLUMN current_version;
ALTER TABLE app.services DROP COLUMN updated_at;
ALTER TABLE app.runs DROP COLUMN service_version_id;
ALTER TABLE app.runs DROP COLUMN adapter_version_id;
ALTER TABLE app.runs DROP COLUMN provider_mapping_id;
ALTER TABLE app.runs DROP COLUMN public_status;
ALTER TABLE app.runs DROP COLUMN accepted_at;
ALTER TABLE app.runs DROP COLUMN started_at;
ALTER TABLE app.runs DROP COLUMN expired_at;
ALTER TABLE app.runs DROP COLUMN next_action_at;
ALTER TABLE app.runs DROP COLUMN template_launch_evidence_id;
ALTER TABLE app.runs DROP COLUMN mapping_launch_evidence_id;
ALTER TABLE app.runs DROP COLUMN feature_flag_id;
ALTER TABLE app.runs DROP COLUMN feature_launch_evidence_id;
ALTER TABLE app.run_attempts DROP COLUMN adapter_version_id;
ALTER TABLE app.run_attempts DROP COLUMN provider_mapping_id;
ALTER TABLE app.run_attempts DROP COLUMN provider_credential_id;
ALTER TABLE app.run_attempts DROP COLUMN request_evidence_reference;
ALTER TABLE app.run_attempts DROP COLUMN response_evidence_reference;
ALTER TABLE app.run_attempts DROP COLUMN created_at;
ALTER TABLE app.run_attempts DROP COLUMN updated_at;
ALTER TABLE app.run_attempts DROP COLUMN provider_dataset_size;
ALTER TABLE app.run_attempts DROP COLUMN provider_file_size;
ALTER TABLE app.run_attempts DROP COLUMN provider_cost_currency;
ALTER TABLE app.run_attempts DROP COLUMN provider_metadata_observed_at;
ALTER TABLE app.run_events DROP COLUMN source;
ALTER TABLE app.run_events DROP COLUMN attempt_id;
ALTER TABLE app.run_events DROP COLUMN evidence_reference;
ALTER TABLE app.run_events DROP COLUMN recorded_at;
ALTER TABLE app.usage_events DROP COLUMN service_template_version_id;
ALTER TABLE app.usage_events DROP COLUMN adapter_version_id;
ALTER TABLE app.usage_events DROP COLUMN provider_reference_fingerprint;
ALTER TABLE app.usage_events DROP COLUMN evidence_reference;
ALTER TABLE app.usage_events DROP COLUMN recorded_at;
ALTER TABLE app.audit_events DROP COLUMN reason;
ALTER TABLE app.audit_events DROP COLUMN request_id;
ALTER TABLE app.audit_events DROP COLUMN created_at;
ALTER TABLE app.outbox_events DROP COLUMN claimed_by;
ALTER TABLE app.outbox_events DROP COLUMN last_safe_error_code;
ALTER TABLE app.outbox_events DROP COLUMN updated_at;
DROP TABLE app.service_versions;
DROP TABLE app.provider_mappings;
DROP TABLE app.adapter_versions;
DROP TABLE app.adapter_definitions;
DROP TABLE app.provider_credentials;
DROP TABLE app.feature_flags;
DROP TABLE app.launch_evidence;
DROP TABLE app.provider_cost_holds;
DROP TABLE app.run_status_transitions;
DROP TABLE app.dead_letter_recovery_intents;
DO $verify$
DECLARE receipt record;actual_n bigint;actual_digest text;
BEGIN
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r')<>26 THEN RAISE EXCEPTION '0073_EXPECTED_26_TABLES'; END IF;
 FOR receipt IN SELECT * FROM refactor73_retained_rows LOOP
   EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,receipt.table_name) INTO actual_n,actual_digest;
   IF actual_n<>receipt.n OR actual_digest<>receipt.digest THEN RAISE EXCEPTION '0073_RETAINED_VALUES_CHANGED %',receipt.table_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND CASE WHEN p.prokind='f' AND n.nspname='app' THEN pg_get_functiondef(p.oid) ELSE '' END ~ 'app[.](service_versions|provider_mappings|adapter_versions|adapter_definitions|provider_credentials|feature_flags|launch_evidence|provider_cost_holds|run_status_transitions|dead_letter_recovery_intents)') THEN RAISE EXCEPTION '0073_RETAINED_FUNCTION_DEPENDENCY'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND c.relname NOT IN ('schema_migrations','auth_sessions','auth_refresh_tokens') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) THEN RAISE EXCEPTION '0073_FORCE_RLS_REQUIRED'; END IF;
END $verify$;
