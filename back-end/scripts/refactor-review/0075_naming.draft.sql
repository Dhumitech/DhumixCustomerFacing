-- 0075 organization naming and final field contraction. D-10/D-13 retain existing identities.
-- Capability consolidation/legacy grant revocation is the separately authorized identity phase.
-- Run only through Review-0075.ps1. The runner owns the single body+ledger transaction.
SET LOCAL search_path=pg_catalog;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s';
DO $gate$ BEGIN
 IF current_database()<>'dhumi_test' OR host(inet_server_addr())<>'127.0.0.1' OR inet_server_port() NOT IN (5432,65475) OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN RAISE EXCEPTION '0075_LOCAL_TEST_ADMIN_ONLY'; END IF;
 IF inet_server_port()=5432 AND(current_setting('dhumi.refactor_apply',true) IS DISTINCT FROM '0075' OR current_setting('dhumi.owner_approved',true) IS DISTINCT FROM 'yes' OR current_setting('dhumi.backend_qualified',true) IS DISTINCT FROM 'yes' OR current_setting('dhumi.backup_restore_verified',true) IS DISTINCT FROM 'yes') THEN RAISE EXCEPTION '0075_REVIEW_GATES_REQUIRED'; END IF;
 IF inet_server_port()=65475 AND current_setting('dhumi.qualification',true) IS DISTINCT FROM '0075' THEN RAISE EXCEPTION '0075_ISOLATED_ONLY'; END IF;
 IF(SELECT count(*) FROM app.schema_migrations)<>74 OR EXISTS(SELECT 1 FROM(VALUES ('0001_bootstrap_roles_and_schema','f3bb8b9318b74413ba4cb570262046df2b7cbaeedfcbad2bc8ffc6fba61fa9ea'),('0002_core_tables','7747ed1b26b990e20de30fa19478914fa02ab69c742d78b585784d78cf4e10bf'),('0003_rls_transitions_and_transaction_functions','23b1073746a3dacc145ecd4c3454e5938d1a9d9e530e4fe778ef21bccd9f9bc2'),('0004_database_integrity_corrections','34710ca15692ee3319fcf1cbbcb1db52f06a149f13c4405a3f067a8f36c6cc91'),('0005_tenant_workspace_state_alignment','7780b5fd3fb6c9126df449249fa6f096f679bdf63ed6db1f61070e92d6131831'),('0006_refresh_token_rotation','af3c6101c956bda36ef313efff2f1d678397af3842a94db415e2e05c4ed2faa4'),('0007_api_key_schema_foundation','cb2dd9b4ace666d2b1c6a5edba9dd437f15daaca199929c1413edfb0246bbde0'),('0008_core_integrity_constraints','08b8ab9db3fad43aec23ebad44f268e3007d81e977ff911fa142cf5b740a6529'),('0009_envelope_destruction','29f5e7e80e4b92215549e4c225221ef30e505f152e7688af2581297697f4cbbf'),('0010_api_key_list_read_surface','b299e93840b05495298b941e8fc497d3c44730629b44a90cb4f57d1e2fe06913'),('0011_api_key_revocation','f80d48efbffef4c8ded2a5f4054a87a2a315c8ae7c840ed2ec11a86edd4d4750'),('0012_api_key_revocation_event_v2','da57b06c2121afec6dc756fe5e9c6b3903982ac91cc241d525ced19140b0d0e9'),('0013_catalogue_public_read_surface','869451d73d6507278329a0490b3d863986029ca5e4bdf00e676dc20bdcb88812'),('0014_catalogue_slug_integrity','a23db772d09350684e9d08da7f9ab022fe049527beb64974e75d36b5e2572f79'),('0015_service_list_read_surface','25cfbd8c387f2b9311ec29b2f453cf5cb6ed5c44c5aa76055e64345290d94571'),('0016_service_creation','8c967f523485214a11b7b9b6b233cf79d028545c1076e9d5656ef3100dec5da4'),('0017_service_detail_read_surface','8d9b859b0540ee3e3c07384d496418d3db6cb360ac97e62c37830e709d172bbd'),('0018_run_admission','94ae9d7adb9ffece2e7424219945f6e77e15c04dd5a20b0ce2943d3d4063077b'),('0019_run_service_lock','cdde64eff8757e0b0999db64fe34bc440724365b12108bc62f0f8828ed157688'),('0020_run_list_read_surface','6c0f87c6f2c47adc88bb2af5a41ee3740cb325e5a9e44b0e236c05af96b43fd3'),('0021_run_cancellation','abe0895839780783fb32c141e91cf82474cc442739602bace868f85340ea2dfe'),('0022_run_retry','96f89ccca5dfb35081857054af170e4e40ba1595c4cc8072d503bd166ec4212d'),('0023_run_retry_owner_rls','ed87bac9e51d05128276a82622440cb291a6cc8a6e053fb93355138bc1013971'),('0024_run_retry_idempotency_lineage','92bed8d95e91d30330db4ecd9762237ab462ad81105084d4f7268ea3e250a140'),('0025_run_event_list_read_surface','88ad8cf9ccc7206685dd028b59a52323e11a55dd4686a1cc844890385974c448'),('0026_template_presentation_and_configuration_schema','5c1442740fa41ddd2a51443e990cfb2ea141cd20ec06d86a56fe500fba956db3'),('0027_run_list_service_filter','5e538b6f30540716b2d776fb0e28d6e037aec718ffdc5fee7ef6b53a1cd72030'),('0028_run_result_read_surface','08c122231cf9bb74971f770c707f77ce7c09d9bf12bffc2c58e48ff258722093'),('0029_durable_execution_fencing','b935672cc78820410ab93d5c09c4d4511a32c270c1fea36352418b8ba95d0977'),('0030_durable_execution_reconciliation','b8bcd4a6e1cc72f1d60e16a545c3a4478f9fab46f65ebd09d19c58bf17fc7651'),('0031_provider_execution_boundary','61c19bb9dfac565db1ccf8f473f5c397b9d8d65c645963337a6ae01ffbfa2bc6'),('0032_amazon_operation_definitions','92a60d577d0fa84a47fe03b4ca0aab70e8783c1d258cba888ea43ce99ea281b7'),('0033_amazon_live_qualification_foundation','a08ed607df2231a408043628592b322f6a996ae1e396c36e314f0e396dfc7db5'),('0034_amazon_qualification_audit_rls','a5c9eba29d6df6bc4894372a6e6daa5035c1690a3e9767c993ad5bf36a5ec857'),('0035_amazon_qualification_template_version_rls','d7b3c67edf88a4f277ae736f5728339fc80e12ef9c8a7e6d40c464896c39d7e2'),('0036_amazon_qualification_execution_mode','cee070da327c40ac779b4577f64833846b8ff3ad2dc6ad52229ff207c183e48b'),('0037_usage_finalization','09829dc1f9637f4bbe00bf32f4250f1ae07824800cc4bf4d16b542115d6aacf3'),('0038_usage_read_surface','050aab6e5903dd4513c621d3acd372dcc23eb0b4a9845d6e5e551845d2bb4e23'),('0039_platform_status_projection','5db6faed19a73e30ae568dd822658d8f52a4faa9270233019c7f1a48650061fb'),('0040_amazon_precise_output_contracts','1733b72ccb31d00065735f99ae96ef2d7e380d4a5c6c648ac99dc25c395e87c2'),('0041_amazon_controlled_publication','6d1c813a275e172c537cd49f260269a0592ba94bb81cac10901c90d07bb3972c'),('0042_provider_mapping_aad_lineage','0e258efec49c1e3745441cd242f9a9359e667fefc2987ac7e2053fae7d839442'),('0043_amazon_products_input_contract_v4','56f00965f10d1abcb13ec4165a5914e6f85098201d12a4ccfaa83c5b238100ae'),('0044_provider_poll_checkpoint','6144ea86ba338f2c51edd69d6c42c113b0b0a3ff40e2639a52c603849ba697f2'),('0045_marketplace_catalogue_import','5a3602bb0125bb587cfe1ac7394745d29b73f4256e81f6015a89242b3c6a5d5a'),('0046_marketplace_sample_ingestion','e6e0c12509d574ded99deb23cfddc15b8e25b880f67533b9a3d4e250f3d233f5'),('0047_marketplace_sample_retention_policy','d372502c00bfbd240f619a55f104f7cfcf121c2edd59832a112a71a7f7315478'),('0048_marketplace_sample_fixture_lifecycle','5cc2ca451dc3d6edf25a0ffedc6311fbc6d98933fb487016d7119889ce28def9'),('0049_marketplace_sample_preview_read','93c7a4b612a03ce765e50d5545143842703fb0022e73300e4bb0770e512b5eb7'),('0050_marketplace_sample_download_authorization','526b488ea947cf3bd75b0741f446d4290f81465500a3eae1616ba52f38345a78'),('0051_marketplace_expert_enquiries','b96c2a55ead67f2492355ebdfccf6cc770f93db27c58f90eb88630cc07ba00c8'),('0052_marketplace_filter_adapter_fixture','e78ab7338aa7eee7ce9980ac6e5b0af6ce54ead2c32e3cc5b5f44cd8b18b5c60'),('0053_marketplace_filter_execution_rls','5e4b98e1745f8b176f317dffa7f8f0994bf1ceb6d0a781d597dc3368f3285c6c'),('0054_marketplace_qualification_preflight','ada06465a57dc50a52967dd7fb1a8b519537a075a97c871dd5243f0704628ea9'),('0055_marketplace_qualification_execution','7393871036e47966764606a8c4cd7dd84759b8a06b9dfa0486a36d56021920ed'),('0056_marketplace_export_candidate','53eb18f59c2485c2456cb6966227d6395581c7caeec59baa54ec004c4cc9ab1e'),('0057_linkedin_posts_provider_sample','535860e803d7b811614b76b583672d55a0a4a7495ffa44782fdb09138f224286'),('0058_marketplace_provider_sample_timestamp_authority','c1160595d9fdc7385becf02ea584963870b75b1a1c2674bdf668960caf357014'),('0059_linkedin_posts_provider_sample_version_3','b32eda2ff7e7484e2361b5147c72343db74dde62c71c4a935acdd9e5f2848f9e'),('0060_linkedin_people_metadata_observation','e5a1877abd766cb5f3c24a88865009ef23436d36b10f3d2b7cd29c5354eb922b'),('0061_linkedin_people_synthetic_preview','12b41e3887642a7d4da6d1bade8c10f363c34a0dad0849e0a9631aa9ac3c330e'),('0062_linkedin_people_sample_timestamp_authority','077b8abbbd9d56ad8c5cd5f2fbc05ac0edea20a748081ed359abcf1b78b0dcbb'),('0063_linkedin_people_contact_contract','af1a9b8900adc369d20e1dbb8193fa68dfb478769b24bd3b2e9443a80b8afe83'),('0064_marketplace_sample_download_cleanup','eefa25c1aac1bd5a9527624a2e860a7f2da6b71307f49577fe2e5c6b427ba422'),('0065_marketplace_fixture_current_schema','a555b737e3dfd73fd835a271c9ac562ec5203bbb87bff8616dc738c8a065f894'),('0066_shared_scraper_processing','65da95f341d63abc8a7861d0f08936e111af69fb8b4a2abd0b50359c0b443a60'),('0067_shared_scraper_draft_registration','c79b9dcd42fb0fb5261905f7ebd9cf0dff3fc8400ecdfaecaeb5b3842cc573fb'),('0068_shared_scraper_release_identity','0fac582eef7e19bcfa969bf4b45482d8e9c6312e7ebc7c5821e6a2058bd379c7'),('0069_shared_scraper_commercial_capacity','6b729ac9d99717371fe1354c3efa296625b492f07dc008f4706aea8796e9efe5'),('0070_archive','0804b5d0716f47f3e826e9aa4c67e38b8d34e2d83ae284eb7cd2a6b1bfdc297a'),('0071_organizations','af85bea48d8bb0e4c77ba9d301a23977ecfc33b5fe77ded0469c207e13e17bd9'),('0072_catalogue_execution_expand','7b2e41928d37dd94c53023917d890138b8fd4dae17bddbfe69accfa2171c118b'),('0073_catalogue_execution_contract','5cb4f72bd46d8f6f6b68d0780e7f5ba189ad3c24b85c26fb85a4ca0217b13923'),('0074_marketplace','ef4856733c5d7fd9f0ef390a2f46d772fdb8128919f95333764e8390e8db73d0')) e(version,checksum) LEFT JOIN app.schema_migrations a USING(version) WHERE a.checksum IS DISTINCT FROM e.checksum) THEN RAISE EXCEPTION '0075_EXACT_LEDGER_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename LIKE 'dhumi_test_%_login') THEN RAISE EXCEPTION '0075_STOP_RUNTIME_FIRST'; END IF;
 IF(SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE')<>25 OR(SELECT count(*) FROM information_schema.columns WHERE table_schema='app')<>284 THEN RAISE EXCEPTION '0075_SCHEMA_BASELINE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions WHERE engine='scraper.v1' AND published_at IS NOT NULL) OR EXISTS(SELECT 1 FROM app.runs r JOIN app.service_template_versions v ON v.id=r.service_template_version_id WHERE v.engine='scraper.v1' AND r.internal_status NOT IN ('COMPLETED','CANCELLED','UPSTREAM_FAILED','PROCESSING_FAILED','REJECTED')) THEN RAISE EXCEPTION '0075_OLD_SHARED_ENGINE_MUST_BE_UNUSED'; END IF;
END $gate$;
LOCK TABLE app.artifacts,app.audit_events,app.auth_refresh_tokens,app.auth_sessions,app.email_verifications,app.idempotency_records,app.legal_acceptances,app.marketplace_expert_enquiries,app.marketplace_sample_downloads,app.marketplace_samples,app.organization_invites,app.organization_templates,app.outbox_events,app.provider_calls,app.run_attempts,app.run_events,app.runs,app.schema_migrations,app.service_template_versions,app.service_templates,app.services,app.tenant_user_access,app.tenants,app.usage_events,app.users IN ACCESS EXCLUSIVE MODE;
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

DO $schema$ BEGIN IF current_setting('dhumi.fixture_cleanup_schema')<>(CASE inet_server_port() WHEN 5432 THEN '427197408b3f078f9baee1771f5521b2' ELSE '8622090a7237b03e1f9e9134fe948ba9' END) THEN RAISE EXCEPTION '0075_SCHEMA_ACL_POLICY_DRIFT';END IF; END $schema$;
DO $backup$ DECLARE r record;n bigint;d text;BEGIN IF inet_server_port()=5432 THEN FOR r IN SELECT * FROM(VALUES ('artifacts',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('audit_events',19298::bigint,'8e8b9854181b07da8db09a901cefb9cb'),('auth_refresh_tokens',3357::bigint,'c130ab8b32ad4dfe87ad0fbae2d6341f'),('auth_sessions',2967::bigint,'6e72e0078069f7c39fcb8f21263b3579'),('email_verifications',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('idempotency_records',11008::bigint,'369f45982e8bace45c00b2f1e37baa4f'),('legal_acceptances',10192::bigint,'d67975b714febfabdf8338695bd87e65'),('marketplace_expert_enquiries',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('marketplace_sample_downloads',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('marketplace_samples',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('organization_invites',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('organization_templates',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('outbox_events',10823::bigint,'ca9169a68ee55f3b0bae1268d7b6460b'),('provider_calls',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('run_attempts',4::bigint,'9019054b8d8bc7e31120b631b24431b8'),('run_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('runs',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('schema_migrations',74::bigint,'89fd79e0ce9f1e6377cf5bc0d2b08121'),('service_template_versions',26::bigint,'fe7ea9e43429030e3ec235aa243c5f53'),('service_templates',13::bigint,'7a9546866b5307015621fcda13757c48'),('services',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('tenant_user_access',10192::bigint,'08356bed633fb03fddcaca2236821f73'),('tenants',10192::bigint,'2c2add83470feeb9612e0e41932f34ee'),('usage_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),('users',10962::bigint,'55607d7c26a8b298afba9a0046a37e44')) expected(t,n,d) LOOP
 EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,r.t) INTO n,d;
 IF n<>r.n OR d<>r.d THEN RAISE EXCEPTION '0075_BACKUP_DATA_DRIFT %',r.t;END IF;END LOOP;END IF;END $backup$;
CREATE TEMP TABLE phase75_expected(t text PRIMARY KEY,n bigint,d text) ON COMMIT DROP;
INSERT INTO phase75_expected SELECT 'artifacts',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))-'deleted_at')||CASE WHEN t.deleted_at IS NOT NULL THEN jsonb_build_object('state','deleted') ELSE '{}'::jsonb END)::text)d FROM app.artifacts t)s;
INSERT INTO phase75_expected SELECT 'audit_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.audit_events t)s;
CREATE TEMP TABLE phase75_audit_ids ON COMMIT DROP AS SELECT id FROM app.audit_events;
INSERT INTO phase75_expected SELECT 'auth_refresh_tokens',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.auth_refresh_tokens t)s;
INSERT INTO phase75_expected SELECT 'auth_sessions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.auth_sessions t)s;
INSERT INTO phase75_expected SELECT 'email_verifications',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.email_verifications t)s;
INSERT INTO phase75_expected SELECT 'idempotency_records',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))-ARRAY['scope_kind','updated_at'])::text)d FROM app.idempotency_records t)s;
INSERT INTO phase75_expected SELECT 'legal_acceptances',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.legal_acceptances t)s;
INSERT INTO phase75_expected SELECT 'marketplace_expert_enquiries',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.marketplace_expert_enquiries t)s;
INSERT INTO phase75_expected SELECT 'marketplace_sample_downloads',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.marketplace_sample_downloads t)s;
INSERT INTO phase75_expected SELECT 'marketplace_samples',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.marketplace_samples t)s;
INSERT INTO phase75_expected SELECT 'organization_invites',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.organization_invites t)s;
INSERT INTO phase75_expected SELECT 'organization_templates',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.organization_templates t)s;
INSERT INTO phase75_expected SELECT 'outbox_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.outbox_events t)s;
INSERT INTO phase75_expected SELECT 'provider_calls',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.provider_calls t)s;
INSERT INTO phase75_expected SELECT 'run_attempts',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.run_attempts t)s;
INSERT INTO phase75_expected SELECT 'run_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.run_events t)s;
INSERT INTO phase75_expected SELECT 'runs',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id','service_template_version_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id','template_version_id',to_jsonb(t)->'service_template_version_id'))::text)d FROM app.runs t)s;
INSERT INTO phase75_expected SELECT 'schema_migrations',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.schema_migrations t)s;
INSERT INTO phase75_expected SELECT 'service_template_versions',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.service_template_versions t)s;
INSERT INTO phase75_expected SELECT 'service_templates',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.service_templates t)s;
INSERT INTO phase75_expected SELECT 'services',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.services t)s;
INSERT INTO phase75_expected SELECT 'organization_members',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id','access_role'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id','role',to_jsonb(t)->'access_role'))::text)d FROM app.tenant_user_access t)s;
INSERT INTO phase75_expected SELECT 'organizations',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['display_name'])||jsonb_build_object('name',to_jsonb(t)->'display_name'))::text)d FROM app.tenants t)s;
INSERT INTO phase75_expected SELECT 'usage_events',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(((to_jsonb(t)-ARRAY['tenant_id'])||jsonb_build_object('organization_id',to_jsonb(t)->'tenant_id'))::text)d FROM app.usage_events t)s;
INSERT INTO phase75_expected SELECT 'users',count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5((to_jsonb(t))::text)d FROM app.users t)s;
-- Retain observed artifact deletion clocks as audit facts; never invent the staff actor.
INSERT INTO app.audit_events(tenant_id,action,target_type,target_id,outcome,safe_diff,occurred_at)
 SELECT tenant_id,'artifact.deletion.naming_backfill','artifact',id,'deleted',jsonb_build_object('migration','0075','deleted_at',deleted_at,'source_state',state,'actor_known',false),deleted_at FROM app.artifacts WHERE deleted_at IS NOT NULL;
UPDATE app.artifacts SET state='deleted' WHERE deleted_at IS NOT NULL AND state<>'deleted';
DROP TRIGGER idempotency_records_touch_updated_at ON app.idempotency_records;
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_check;
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_cancel_semantics_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_run_cancel_semantics_check CHECK (((operation_code <> 'runs.cancel'::text) OR ((tenant_id IS NOT NULL) AND (((state = 'in_progress'::text) AND (response_status IS NULL) AND (resource_type IS NULL) AND (resource_id IS NULL) AND (related_resource_id IS NULL) AND (response_body_reference IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (response_status = 202) AND (resource_type = 'run'::text) AND (resource_id IS NOT NULL) AND (related_resource_id IS NULL) AND (response_body_reference = 'inline_json_v1'::text) AND (response_body IS NOT NULL) AND (response_body ?& ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text]) AND ((response_body - ARRAY['id'::text, 'service_id'::text, 'status'::text, 'error_code'::text, 'retryable'::text, 'created_at'::text, 'updated_at'::text, 'completed_at'::text]) = '{}'::jsonb) AND ((response_body ->> 'id'::text) = (resource_id)::text) AND (jsonb_typeof((response_body -> 'service_id'::text)) = 'string'::text) AND ((response_body ->> 'status'::text) = ANY (ARRAY['queued'::text, 'running'::text])) AND ((response_body -> 'error_code'::text) = 'null'::jsonb) AND ((response_body -> 'retryable'::text) = 'false'::jsonb) AND (jsonb_typeof((response_body -> 'created_at'::text)) = 'string'::text) AND (jsonb_typeof((response_body -> 'updated_at'::text)) = 'string'::text) AND ((response_body -> 'completed_at'::text) = 'null'::jsonb) AND (completed_at IS NOT NULL))))));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_create_semantics_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_run_create_semantics_check CHECK (((operation_code <> 'runs.create'::text) OR ((tenant_id IS NOT NULL) AND (((state = 'in_progress'::text) AND (response_status IS NULL) AND (resource_type IS NULL) AND (resource_id IS NULL) AND (related_resource_id IS NULL) AND (response_body_reference IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (response_status = 202) AND (resource_type = 'run'::text) AND (resource_id IS NOT NULL) AND (related_resource_id IS NULL) AND (response_body_reference = 'inline_json_v1'::text) AND (response_body IS NOT NULL) AND ((response_body - ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text]) = '{}'::jsonb) AND ((response_body ->> 'run_id'::text) = (resource_id)::text) AND ((response_body ->> 'status'::text) = 'queued'::text) AND (jsonb_typeof((response_body -> 'accepted_at'::text)) = 'string'::text) AND (completed_at IS NOT NULL))))));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_run_retry_semantics_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_run_retry_semantics_check CHECK (((operation_code <> 'runs.retry'::text) OR ((tenant_id IS NOT NULL) AND (((state = 'in_progress'::text) AND (response_status IS NULL) AND (resource_type IS NULL) AND (resource_id IS NULL) AND (related_resource_id IS NULL) AND (response_body_reference IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (response_status = 202) AND (resource_type = 'run'::text) AND (resource_id IS NOT NULL) AND (related_resource_id IS NOT NULL) AND (resource_id <> related_resource_id) AND (response_body_reference = 'inline_json_v1'::text) AND (response_body IS NOT NULL) AND (response_body ?& ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text]) AND ((response_body - ARRAY['run_id'::text, 'status'::text, 'accepted_at'::text]) = '{}'::jsonb) AND ((response_body ->> 'run_id'::text) = (resource_id)::text) AND ((response_body ->> 'status'::text) = 'queued'::text) AND (jsonb_typeof((response_body -> 'accepted_at'::text)) = 'string'::text) AND (completed_at IS NOT NULL))))));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_scope_kind_check;
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_service_create_semantics_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_service_create_semantics_check CHECK (((operation_code <> 'services.create'::text) OR ((tenant_id IS NOT NULL) AND (((state = 'in_progress'::text) AND (response_status IS NULL) AND (resource_type IS NULL) AND (resource_id IS NULL) AND (related_resource_id IS NULL) AND (response_body_reference IS NULL) AND (response_body IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (response_status = 201) AND (resource_type = 'service'::text) AND (resource_id IS NOT NULL) AND (related_resource_id IS NULL) AND (response_body_reference = 'inline_json_v1'::text) AND (response_body IS NOT NULL) AND (response_body ? 'id'::text) AND ((response_body ->> 'id'::text) = (resource_id)::text) AND (completed_at IS NOT NULL))))));
ALTER TABLE app.idempotency_records DROP CONSTRAINT idempotency_records_time_order_check;
ALTER TABLE app.idempotency_records ADD CONSTRAINT idempotency_records_time_order_check CHECK (((expires_at > created_at) AND ((completed_at IS NULL) OR (completed_at >= created_at))));
DROP POLICY idempotency_records_signup_identity_access ON app.idempotency_records;CREATE POLICY idempotency_records_signup_identity_access ON app.idempotency_records AS PERMISSIVE FOR ALL TO dhumi_identity USING(tenant_id IS NULL) WITH CHECK(tenant_id IS NULL);
DROP INDEX app.idempotency_records_signup_scope_idx;CREATE UNIQUE INDEX idempotency_records_signup_scope_idx ON app.idempotency_records USING btree (actor_fingerprint, operation_code, idempotency_key) WHERE (tenant_id IS NULL);
DROP INDEX app.idempotency_records_tenant_scope_idx;CREATE UNIQUE INDEX idempotency_records_tenant_scope_idx ON app.idempotency_records USING btree (tenant_id, operation_code, idempotency_key) WHERE (tenant_id IS NOT NULL);
ALTER TABLE app.idempotency_records DROP COLUMN scope_kind RESTRICT,DROP COLUMN updated_at RESTRICT;
ALTER TABLE app.artifacts DROP COLUMN deleted_at RESTRICT;
ALTER TABLE app.tenants RENAME TO organizations;ALTER TABLE app.tenant_user_access RENAME TO organization_members;
ALTER TABLE app.artifacts RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.audit_events RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.idempotency_records RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.marketplace_expert_enquiries RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.marketplace_sample_downloads RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.outbox_events RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.run_attempts RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.run_events RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.runs RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.runs RENAME COLUMN service_template_version_id TO template_version_id;
ALTER TABLE app.services RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.organization_members RENAME COLUMN tenant_id TO organization_id;
ALTER TABLE app.organization_members RENAME COLUMN access_role TO role;
ALTER TABLE app.organizations RENAME COLUMN display_name TO name;
ALTER TABLE app.usage_events RENAME COLUMN tenant_id TO organization_id;
ALTER FUNCTION app.current_tenant_id() RENAME TO current_organization_id;
CREATE OR REPLACE FUNCTION app.current_organization_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$function$
;
CREATE OR REPLACE FUNCTION app.guard_organization_membership_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Membership identity/history is immutable' USING ERRCODE='55000';
 END IF;
 IF current_user='dhumi_identity' AND (OLD.state<>'removed' OR NEW.state<>'active') THEN
  -- Fresh proof permits reactivation only. An active join is a locking read,
  -- never an UPDATE; its role, invitation and original time stay unchanged.
  RAISE EXCEPTION 'Only removed memberships may be reactivated' USING ERRCODE='42501';
 END IF;
 IF current_user='dhumi_customer_api' AND NOT EXISTS(
  SELECT 1 FROM app.organization_members a WHERE a.organization_id=OLD.organization_id
   AND a.user_id=app.current_user_id() AND a.role='admin' AND a.state='active') THEN
  RAISE EXCEPTION 'Organization administrator required' USING ERRCODE='42501';
 END IF;
 -- This check runs BEFORE the change, so an authorized admin may step down
 -- and still complete audit/idempotency. Creator/last-admin checks and the
 -- organization-first lock order remain in the TypeScript repository.
 RETURN NEW; END $function$
;
CREATE OR REPLACE FUNCTION app.guard_outbox_command_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
BEGIN
 IF (NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.organization_id,NEW.topic,NEW.ordering_key,NEW.payload,NEW.schema_version,NEW.created_at,NEW.recovered_from_event_id)
 IS DISTINCT FROM(OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.organization_id,OLD.topic,OLD.ordering_key,OLD.payload,OLD.schema_version,OLD.created_at,OLD.recovered_from_event_id)
 THEN RAISE EXCEPTION 'OUTBOX_COMMAND_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.guard_run_admission_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
BEGIN
 IF (NEW.id,NEW.organization_id,NEW.service_id,NEW.template_version_id,NEW.created_by_user_id,NEW.trace_id,
     NEW.commercial_config_version,NEW.validated_input,NEW.estimated_cost_micros,NEW.retry_of_run_id,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.service_id,OLD.template_version_id,OLD.created_by_user_id,OLD.trace_id,
     OLD.commercial_config_version,OLD.validated_input,OLD.estimated_cost_micros,OLD.retry_of_run_id,OLD.created_at)
 THEN RAISE EXCEPTION 'RUN_ADMISSION_FIELDS_ARE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.guard_service_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
BEGIN
 IF (NEW.id,NEW.organization_id,NEW.template_version_id,NEW.configuration,NEW.created_by_user_id,NEW.created_at)
 IS DISTINCT FROM(OLD.id,OLD.organization_id,OLD.template_version_id,OLD.configuration,OLD.created_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'SERVICE_CONFIGURATION_AND_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.reject_organization_creator_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN RAISE EXCEPTION 'Organization creator is immutable' USING ERRCODE='55000'; END IF;
 -- UPDATE USING admits an ordinary member's locking SELECT. Only an active
 -- admin may perform an actual customer UPDATE. No SELECT/lock fires a trigger.
 IF current_user='dhumi_customer_api' AND NOT EXISTS(
  SELECT 1 FROM app.organization_members a WHERE a.organization_id=OLD.id
   AND a.user_id=app.current_user_id() AND a.role='admin' AND a.state='active') THEN
  RAISE EXCEPTION 'Organization administrator required' USING ERRCODE='42501';
 END IF;
 RETURN NEW; END $function$
;
ALTER FUNCTION app.require_tenant_context() RENAME TO require_organization_context;
CREATE OR REPLACE FUNCTION app.require_organization_context()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  organization_id uuid;
BEGIN
  organization_id := app.current_organization_id();
  IF organization_id IS NULL THEN
    RAISE EXCEPTION 'ORGANIZATION_CONTEXT_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  RETURN organization_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.validate_artifact_attempt_belongs_to_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app.run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.organization_id = NEW.organization_id
      AND attempt.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_ATTEMPT_DOES_NOT_BELONG_TO_RUN'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION app.validate_provider_call_attempt_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF NEW.attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.run_attempts a
  WHERE a.id=NEW.attempt_id AND a.organization_id=NEW.organization_id AND a.run_id=NEW.run_id) THEN
  RAISE EXCEPTION 'Provider call Attempt must belong to its Run' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.validate_run_retry_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
BEGIN
 IF NEW.retry_of_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.runs r WHERE r.organization_id=NEW.organization_id AND r.id=NEW.retry_of_run_id AND r.service_id=NEW.service_id)
 THEN RAISE EXCEPTION 'RUN_RETRY_SERVICE_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.validate_run_version_pins()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.services s WHERE s.organization_id=NEW.organization_id AND s.id=NEW.service_id AND s.template_version_id=NEW.template_version_id)
 THEN RAISE EXCEPTION 'RUN_SERVICE_TEMPLATE_PIN_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION app.validate_usage_attempt_belongs_to_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM app.run_attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.organization_id = NEW.organization_id
      AND attempt.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'USAGE_ATTEMPT_DOES_NOT_BELONG_TO_RUN'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$
;
DO $names$ DECLARE r record;n text;BEGIN
 FOR r IN SELECT c.relname t,k.conname name FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND k.conname ~ '(tenant|access_role|display_name|service_template_version_id)' LOOP
 n:=replace(replace(replace(replace(replace(replace(r.name,'tenant_user_access','organization_members'),'tenants','organizations'),'tenant','organization'),'access_role','role'),'display_name','name'),'service_template_version_id','template_version_id');
 EXECUTE format('ALTER TABLE app.%I RENAME CONSTRAINT %I TO %I',r.t,r.name,n);END LOOP;
 FOR r IN SELECT c.relname name FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND c.relkind='i' AND c.relname ~ '(tenant|access_role|display_name|service_template_version_id)' LOOP
 n:=replace(replace(replace(replace(replace(replace(r.name,'tenant_user_access','organization_members'),'tenants','organizations'),'tenant','organization'),'access_role','role'),'display_name','name'),'service_template_version_id','template_version_id');EXECUTE format('ALTER INDEX app.%I RENAME TO %I',r.name,n);END LOOP;
 FOR r IN SELECT c.relname t,p.polname name FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND p.polname ~ 'tenant' LOOP
 n:=replace(replace(replace(r.name,'tenant_user_access','organization_members'),'tenants','organizations'),'tenant','organization');EXECUTE format('ALTER POLICY %I ON app.%I RENAME TO %I',r.name,r.t,n);END LOOP;
END $names$;
DO $verify$ DECLARE r record;n bigint;d text;BEGIN
 FOR r IN SELECT * FROM phase75_expected LOOP
 IF r.t='audit_events' THEN SELECT count(*),md5(coalesce(string_agg(x.d,'' ORDER BY x.d),'')) INTO n,d FROM(SELECT md5(to_jsonb(a)::text)d FROM app.audit_events a JOIN phase75_audit_ids p USING(id))x;
 ELSE EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,r.t) INTO n,d;END IF;
 IF n<>r.n OR d<>r.d THEN RAISE EXCEPTION '0075_RETAINED_VALUE_CHANGED %',r.t;END IF;END LOOP;
 IF EXISTS(SELECT 1 FROM app.artifacts a WHERE a.state='deleted' AND EXISTS(SELECT 1 FROM app.audit_events e WHERE e.target_id=a.id AND e.action='artifact.deletion.naming_backfill' AND e.actor_user_id IS NOT NULL)) THEN RAISE EXCEPTION '0075_FABRICATED_DELETION_ACTOR';END IF;
 IF(SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE')<>25 OR(SELECT count(*) FROM information_schema.columns WHERE table_schema='app')<>281 THEN RAISE EXCEPTION '0075_EXPECTED_25_TABLES_279_TABLE_COLUMNS';END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND column_name IN ('tenant_id','access_role','display_name','service_template_version_id')) OR to_regclass('app.tenants') IS NOT NULL OR to_regclass('app.tenant_user_access') IS NOT NULL THEN RAISE EXCEPTION '0075_OLD_DATABASE_IDENTIFIER_REMAINS';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='app' AND(p.prosecdef OR CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE '' END ~ '(tenant_id|tenant_user_access|app[.]tenants|scope_kind)')) THEN RAISE EXCEPTION '0075_OLD_FUNCTION_REFERENCE_OR_DEFINER';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='app' AND c.relkind='r' AND c.relname NOT IN ('auth_refresh_tokens','auth_sessions','schema_migrations') AND(NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) THEN RAISE EXCEPTION '0075_FORCE_RLS_REQUIRED';END IF;
END $verify$;
