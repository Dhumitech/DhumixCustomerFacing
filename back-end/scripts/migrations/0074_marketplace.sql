-- 0074 Marketplace contraction. Existing credentials and identities stay unchanged.
-- Run only through Review-0074.ps1; the runner owns BEGIN/body/ledger/COMMIT.
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s';
DO $gate$ BEGIN
 IF current_database()<>'dhumi_test' OR host(inet_server_addr())<>'127.0.0.1' OR inet_server_port() NOT IN (5432,65474) OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN RAISE EXCEPTION '0074_LOCAL_TEST_ADMIN_ONLY'; END IF;
 IF inet_server_port()=5432 AND(current_setting('dhumi.refactor_apply',true) IS DISTINCT FROM '0074' OR current_setting('dhumi.owner_approved',true) IS DISTINCT FROM 'yes' OR current_setting('dhumi.backend_qualified',true) IS DISTINCT FROM 'yes' OR current_setting('dhumi.backup_restore_verified',true) IS DISTINCT FROM 'yes') THEN RAISE EXCEPTION '0074_REVIEW_GATES_REQUIRED'; END IF;
 IF inet_server_port()=65474 AND current_setting('dhumi.qualification',true) IS DISTINCT FROM '0074' THEN RAISE EXCEPTION '0074_ISOLATED_ONLY'; END IF;
 IF(SELECT count(*) FROM app.schema_migrations)<>73 OR EXISTS(SELECT 1 FROM(VALUES ('0001_bootstrap_roles_and_schema','f3bb8b9318b74413ba4cb570262046df2b7cbaeedfcbad2bc8ffc6fba61fa9ea'),('0002_core_tables','7747ed1b26b990e20de30fa19478914fa02ab69c742d78b585784d78cf4e10bf'),('0003_rls_transitions_and_transaction_functions','23b1073746a3dacc145ecd4c3454e5938d1a9d9e530e4fe778ef21bccd9f9bc2'),('0004_database_integrity_corrections','34710ca15692ee3319fcf1cbbcb1db52f06a149f13c4405a3f067a8f36c6cc91'),('0005_tenant_workspace_state_alignment','7780b5fd3fb6c9126df449249fa6f096f679bdf63ed6db1f61070e92d6131831'),('0006_refresh_token_rotation','af3c6101c956bda36ef313efff2f1d678397af3842a94db415e2e05c4ed2faa4'),('0007_api_key_schema_foundation','cb2dd9b4ace666d2b1c6a5edba9dd437f15daaca199929c1413edfb0246bbde0'),('0008_core_integrity_constraints','08b8ab9db3fad43aec23ebad44f268e3007d81e977ff911fa142cf5b740a6529'),('0009_envelope_destruction','29f5e7e80e4b92215549e4c225221ef30e505f152e7688af2581297697f4cbbf'),('0010_api_key_list_read_surface','b299e93840b05495298b941e8fc497d3c44730629b44a90cb4f57d1e2fe06913'),('0011_api_key_revocation','f80d48efbffef4c8ded2a5f4054a87a2a315c8ae7c840ed2ec11a86edd4d4750'),('0012_api_key_revocation_event_v2','da57b06c2121afec6dc756fe5e9c6b3903982ac91cc241d525ced19140b0d0e9'),('0013_catalogue_public_read_surface','869451d73d6507278329a0490b3d863986029ca5e4bdf00e676dc20bdcb88812'),('0014_catalogue_slug_integrity','a23db772d09350684e9d08da7f9ab022fe049527beb64974e75d36b5e2572f79'),('0015_service_list_read_surface','25cfbd8c387f2b9311ec29b2f453cf5cb6ed5c44c5aa76055e64345290d94571'),('0016_service_creation','8c967f523485214a11b7b9b6b233cf79d028545c1076e9d5656ef3100dec5da4'),('0017_service_detail_read_surface','8d9b859b0540ee3e3c07384d496418d3db6cb360ac97e62c37830e709d172bbd'),('0018_run_admission','94ae9d7adb9ffece2e7424219945f6e77e15c04dd5a20b0ce2943d3d4063077b'),('0019_run_service_lock','cdde64eff8757e0b0999db64fe34bc440724365b12108bc62f0f8828ed157688'),('0020_run_list_read_surface','6c0f87c6f2c47adc88bb2af5a41ee3740cb325e5a9e44b0e236c05af96b43fd3'),('0021_run_cancellation','abe0895839780783fb32c141e91cf82474cc442739602bace868f85340ea2dfe'),('0022_run_retry','96f89ccca5dfb35081857054af170e4e40ba1595c4cc8072d503bd166ec4212d'),('0023_run_retry_owner_rls','ed87bac9e51d05128276a82622440cb291a6cc8a6e053fb93355138bc1013971'),('0024_run_retry_idempotency_lineage','92bed8d95e91d30330db4ecd9762237ab462ad81105084d4f7268ea3e250a140'),('0025_run_event_list_read_surface','88ad8cf9ccc7206685dd028b59a52323e11a55dd4686a1cc844890385974c448'),('0026_template_presentation_and_configuration_schema','5c1442740fa41ddd2a51443e990cfb2ea141cd20ec06d86a56fe500fba956db3'),('0027_run_list_service_filter','5e538b6f30540716b2d776fb0e28d6e037aec718ffdc5fee7ef6b53a1cd72030'),('0028_run_result_read_surface','08c122231cf9bb74971f770c707f77ce7c09d9bf12bffc2c58e48ff258722093'),('0029_durable_execution_fencing','b935672cc78820410ab93d5c09c4d4511a32c270c1fea36352418b8ba95d0977'),('0030_durable_execution_reconciliation','b8bcd4a6e1cc72f1d60e16a545c3a4478f9fab46f65ebd09d19c58bf17fc7651'),('0031_provider_execution_boundary','61c19bb9dfac565db1ccf8f473f5c397b9d8d65c645963337a6ae01ffbfa2bc6'),('0032_amazon_operation_definitions','92a60d577d0fa84a47fe03b4ca0aab70e8783c1d258cba888ea43ce99ea281b7'),('0033_amazon_live_qualification_foundation','a08ed607df2231a408043628592b322f6a996ae1e396c36e314f0e396dfc7db5'),('0034_amazon_qualification_audit_rls','a5c9eba29d6df6bc4894372a6e6daa5035c1690a3e9767c993ad5bf36a5ec857'),('0035_amazon_qualification_template_version_rls','d7b3c67edf88a4f277ae736f5728339fc80e12ef9c8a7e6d40c464896c39d7e2'),('0036_amazon_qualification_execution_mode','cee070da327c40ac779b4577f64833846b8ff3ad2dc6ad52229ff207c183e48b'),('0037_usage_finalization','09829dc1f9637f4bbe00bf32f4250f1ae07824800cc4bf4d16b542115d6aacf3'),('0038_usage_read_surface','050aab6e5903dd4513c621d3acd372dcc23eb0b4a9845d6e5e551845d2bb4e23'),('0039_platform_status_projection','5db6faed19a73e30ae568dd822658d8f52a4faa9270233019c7f1a48650061fb'),('0040_amazon_precise_output_contracts','1733b72ccb31d00065735f99ae96ef2d7e380d4a5c6c648ac99dc25c395e87c2'),('0041_amazon_controlled_publication','6d1c813a275e172c537cd49f260269a0592ba94bb81cac10901c90d07bb3972c'),('0042_provider_mapping_aad_lineage','0e258efec49c1e3745441cd242f9a9359e667fefc2987ac7e2053fae7d839442'),('0043_amazon_products_input_contract_v4','56f00965f10d1abcb13ec4165a5914e6f85098201d12a4ccfaa83c5b238100ae'),('0044_provider_poll_checkpoint','6144ea86ba338f2c51edd69d6c42c113b0b0a3ff40e2639a52c603849ba697f2'),('0045_marketplace_catalogue_import','5a3602bb0125bb587cfe1ac7394745d29b73f4256e81f6015a89242b3c6a5d5a'),('0046_marketplace_sample_ingestion','e6e0c12509d574ded99deb23cfddc15b8e25b880f67533b9a3d4e250f3d233f5'),('0047_marketplace_sample_retention_policy','d372502c00bfbd240f619a55f104f7cfcf121c2edd59832a112a71a7f7315478'),('0048_marketplace_sample_fixture_lifecycle','5cc2ca451dc3d6edf25a0ffedc6311fbc6d98933fb487016d7119889ce28def9'),('0049_marketplace_sample_preview_read','93c7a4b612a03ce765e50d5545143842703fb0022e73300e4bb0770e512b5eb7'),('0050_marketplace_sample_download_authorization','526b488ea947cf3bd75b0741f446d4290f81465500a3eae1616ba52f38345a78'),('0051_marketplace_expert_enquiries','b96c2a55ead67f2492355ebdfccf6cc770f93db27c58f90eb88630cc07ba00c8'),('0052_marketplace_filter_adapter_fixture','e78ab7338aa7eee7ce9980ac6e5b0af6ce54ead2c32e3cc5b5f44cd8b18b5c60'),('0053_marketplace_filter_execution_rls','5e4b98e1745f8b176f317dffa7f8f0994bf1ceb6d0a781d597dc3368f3285c6c'),('0054_marketplace_qualification_preflight','ada06465a57dc50a52967dd7fb1a8b519537a075a97c871dd5243f0704628ea9'),('0055_marketplace_qualification_execution','7393871036e47966764606a8c4cd7dd84759b8a06b9dfa0486a36d56021920ed'),('0056_marketplace_export_candidate','53eb18f59c2485c2456cb6966227d6395581c7caeec59baa54ec004c4cc9ab1e'),('0057_linkedin_posts_provider_sample','535860e803d7b811614b76b583672d55a0a4a7495ffa44782fdb09138f224286'),('0058_marketplace_provider_sample_timestamp_authority','c1160595d9fdc7385becf02ea584963870b75b1a1c2674bdf668960caf357014'),('0059_linkedin_posts_provider_sample_version_3','b32eda2ff7e7484e2361b5147c72343db74dde62c71c4a935acdd9e5f2848f9e'),('0060_linkedin_people_metadata_observation','e5a1877abd766cb5f3c24a88865009ef23436d36b10f3d2b7cd29c5354eb922b'),('0061_linkedin_people_synthetic_preview','12b41e3887642a7d4da6d1bade8c10f363c34a0dad0849e0a9631aa9ac3c330e'),('0062_linkedin_people_sample_timestamp_authority','077b8abbbd9d56ad8c5cd5f2fbc05ac0edea20a748081ed359abcf1b78b0dcbb'),('0063_linkedin_people_contact_contract','af1a9b8900adc369d20e1dbb8193fa68dfb478769b24bd3b2e9443a80b8afe83'),('0064_marketplace_sample_download_cleanup','eefa25c1aac1bd5a9527624a2e860a7f2da6b71307f49577fe2e5c6b427ba422'),('0065_marketplace_fixture_current_schema','a555b737e3dfd73fd835a271c9ac562ec5203bbb87bff8616dc738c8a065f894'),('0066_shared_scraper_processing','65da95f341d63abc8a7861d0f08936e111af69fb8b4a2abd0b50359c0b443a60'),('0067_shared_scraper_draft_registration','c79b9dcd42fb0fb5261905f7ebd9cf0dff3fc8400ecdfaecaeb5b3842cc573fb'),('0068_shared_scraper_release_identity','0fac582eef7e19bcfa969bf4b45482d8e9c6312e7ebc7c5821e6a2058bd379c7'),('0069_shared_scraper_commercial_capacity','6b729ac9d99717371fe1354c3efa296625b492f07dc008f4706aea8796e9efe5'),('0070_archive','0804b5d0716f47f3e826e9aa4c67e38b8d34e2d83ae284eb7cd2a6b1bfdc297a'),('0071_organizations','af85bea48d8bb0e4c77ba9d301a23977ecfc33b5fe77ded0469c207e13e17bd9'),('0072_catalogue_execution_expand','7b2e41928d37dd94c53023917d890138b8fd4dae17bddbfe69accfa2171c118b'),('0073_catalogue_execution_contract','5cb4f72bd46d8f6f6b68d0780e7f5ba189ad3c24b85c26fb85a4ca0217b13923')) expected(version,checksum) LEFT JOIN app.schema_migrations actual USING(version) WHERE actual.checksum IS DISTINCT FROM expected.checksum) THEN RAISE EXCEPTION '0074_EXACT_LEDGER_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename LIKE 'dhumi_test_%_login') THEN RAISE EXCEPTION '0074_STOP_RUNTIME_FIRST'; END IF;
 IF(SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE')<>26 OR(SELECT count(*) FROM information_schema.columns WHERE table_schema='app')<>308 THEN RAISE EXCEPTION '0074_SCHEMA_BASELINE_REQUIRED'; END IF;
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

DO $schema$ BEGIN IF inet_server_port()=5432 AND current_setting('dhumi.fixture_cleanup_schema') IS DISTINCT FROM 'a9e87385a1922a3b2b683c6d4e746966' THEN RAISE EXCEPTION '0074_SCHEMA_PRIVILEGE_POLICY_DRIFT';END IF;END $schema$;
LOCK TABLE app.artifacts,app.audit_events,app.auth_refresh_tokens,app.auth_sessions,app.email_verifications,app.idempotency_records,app.legal_acceptances,app.marketplace_expert_enquiries,app.marketplace_sample_deletions,app.marketplace_sample_download_authorizations,app.marketplace_sample_versions,app.organization_invites,app.organization_templates,app.outbox_events,app.provider_calls,app.run_attempts,app.run_events,app.runs,app.schema_migrations,app.service_template_versions,app.service_templates,app.services,app.tenant_user_access,app.tenants,app.usage_events,app.users IN ACCESS EXCLUSIVE MODE;
DO $backup$ DECLARE r record;n bigint;digest_value text;BEGIN
 IF inet_server_port()=5432 THEN FOR r IN SELECT * FROM(VALUES ('artifacts',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('audit_events',19298::bigint,'8e8b9854181b07da8db09a901cefb9cb'),
('auth_refresh_tokens',3357::bigint,'c130ab8b32ad4dfe87ad0fbae2d6341f'),
('auth_sessions',2967::bigint,'6e72e0078069f7c39fcb8f21263b3579'),
('email_verifications',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('idempotency_records',11008::bigint,'369f45982e8bace45c00b2f1e37baa4f'),
('legal_acceptances',10192::bigint,'d67975b714febfabdf8338695bd87e65'),
('marketplace_expert_enquiries',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_deletions',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_download_authorizations',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_versions',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_invites',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_templates',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('outbox_events',10823::bigint,'ca9169a68ee55f3b0bae1268d7b6460b'),
('provider_calls',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('run_attempts',4::bigint,'9019054b8d8bc7e31120b631b24431b8'),
('run_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('runs',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('schema_migrations',73::bigint,'244200ac086dc8aaa7014b420afaf4d3'),
('service_template_versions',26::bigint,'fe7ea9e43429030e3ec235aa243c5f53'),
('service_templates',13::bigint,'7a9546866b5307015621fcda13757c48'),
('services',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('tenant_user_access',10192::bigint,'08356bed633fb03fddcaca2236821f73'),
('tenants',10192::bigint,'2c2add83470feeb9612e0e41932f34ee'),
('usage_events',0::bigint,'d41d8cd98f00b204e9800998ecf8427e'),
('users',10962::bigint,'55607d7c26a8b298afba9a0046a37e44')) expected(t,n,d) LOOP
 EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,r.t) INTO n,digest_value;
 IF n<>r.n OR digest_value<>r.d THEN RAISE EXCEPTION '0074_BACKUP_DATA_DRIFT %',r.t; END IF;END LOOP;END IF;
END $backup$;
CREATE TEMP TABLE phase74_retained(t text PRIMARY KEY,n bigint,d text) ON COMMIT DROP;
DO $save$ DECLARE t text;n bigint;digest_value text;BEGIN FOREACH t IN ARRAY ARRAY['artifacts','auth_refresh_tokens','auth_sessions','email_verifications','legal_acceptances','organization_invites','organization_templates','outbox_events','provider_calls','run_attempts','run_events','runs','schema_migrations','service_template_versions','service_templates','services','tenant_user_access','tenants','usage_events','users'] LOOP
 EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,t) INTO n,digest_value;INSERT INTO phase74_retained VALUES(t,n,digest_value);END LOOP;END $save$;
CREATE TEMP TABLE phase74_samples ON COMMIT DROP AS SELECT to_jsonb(s) original FROM app.marketplace_sample_versions s;
CREATE TEMP TABLE phase74_downloads ON COMMIT DROP AS SELECT to_jsonb(d) original FROM app.marketplace_sample_download_authorizations d;
CREATE TEMP TABLE phase74_enquiries ON COMMIT DROP AS SELECT to_jsonb(e) original FROM app.marketplace_expert_enquiries e;
CREATE TEMP TABLE phase74_deletions ON COMMIT DROP AS SELECT to_jsonb(d) original FROM app.marketplace_sample_deletions d;
CREATE TEMP TABLE phase74_audits ON COMMIT DROP AS SELECT id,md5(to_jsonb(a)::text) digest FROM app.audit_events a;
CREATE TEMP TABLE phase74_idem ON COMMIT DROP AS SELECT id,md5(to_jsonb(i)::text) digest FROM app.idempotency_records i;

-- Fold replay keys before their source columns are removed. No source result is overwritten.
INSERT INTO app.idempotency_records(id,tenant_id,scope_kind,actor_fingerprint,operation_code,idempotency_key,request_hash,state,response_status,resource_type,resource_id,response_body,created_at,expires_at,completed_at)
 SELECT gen_random_uuid(),tenant_id,'tenant',actor_fingerprint,'marketplace.sample_download.authorize.v1',idempotency_key,request_hash,
 CASE state WHEN 'reserved' THEN 'in_progress' WHEN 'authorized' THEN 'completed' ELSE 'failed' END,CASE WHEN state='authorized' THEN 201 END,'marketplace_sample_download',id,
 jsonb_build_object('projection_fingerprint',encode(projection_fingerprint,'hex')),least(created_at,authorized_at),'infinity',authorized_at FROM app.marketplace_sample_download_authorizations;
INSERT INTO app.idempotency_records(id,tenant_id,scope_kind,actor_fingerprint,operation_code,idempotency_key,request_hash,state,response_status,resource_type,resource_id,response_body,created_at,expires_at,completed_at)
 SELECT gen_random_uuid(),tenant_id,'tenant',actor_fingerprint,'marketplace.expert_enquiry.create.v1',idempotency_key,request_hash,'completed',201,'marketplace_expert_enquiry',id,
 jsonb_build_object('enquiryId',id,'templateSlug',template_slug,'templateVersion',template_version,'state',state,'submittedAt',created_at),created_at,'infinity',created_at FROM app.marketplace_expert_enquiries;
CREATE UNIQUE INDEX idempotency_marketplace_org_key ON app.idempotency_records(tenant_id,operation_code,idempotency_key) WHERE operation_code IN ('marketplace.sample_download.authorize.v1','marketplace.expert_enquiry.create.v1');
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,ip_fingerprint,safe_diff)
 SELECT tenant_id,actor_user_id,'marketplace.download.contract_backfill','marketplace_sample_download',id,state,request_id,ip_fingerprint,
 jsonb_build_object('migration','0074','template_slug',template_slug,'template_version',template_version,'sample_version',sample_version,'projection_fingerprint',encode(projection_fingerprint,'hex'),'authorized_at',authorized_at,'failed_at',failed_at) FROM app.marketplace_sample_download_authorizations;
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,ip_fingerprint,safe_diff)
 SELECT tenant_id,actor_user_id,'marketplace.enquiry.contract_backfill','marketplace_expert_enquiry',id,state,request_id,ip_fingerprint,jsonb_build_object('migration','0074','template_slug',template_slug,'template_version',template_version) FROM app.marketplace_expert_enquiries;
-- Every known clock is retained separately. The unknown historical staff actor stays NULL.
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff,occurred_at)
 SELECT tenant_id,NULL,'marketplace.expert_enquiry.historical_contacted','marketplace_expert_enquiry',id,'contacted',request_id,jsonb_build_object('migration','0074','transition_at',contacted_at,'actor_known',false),contacted_at FROM app.marketplace_expert_enquiries WHERE contacted_at IS NOT NULL;
INSERT INTO app.audit_events(tenant_id,actor_user_id,action,target_type,target_id,outcome,trace_id,safe_diff,occurred_at)
 SELECT tenant_id,NULL,'marketplace.expert_enquiry.historical_closed','marketplace_expert_enquiry',id,'closed',request_id,jsonb_build_object('migration','0074','transition_at',closed_at,'actor_known',false),closed_at FROM app.marketplace_expert_enquiries WHERE closed_at IS NOT NULL;
INSERT INTO app.audit_events(action,target_type,target_id,outcome,safe_diff,occurred_at)
 SELECT 'marketplace.sample.deletion_backfill','marketplace_sample_version',sample_version_id,'completed',jsonb_build_object('migration','0074','deleted_at',deleted_at,'actor',actor,'storage_disposition',storage_disposition,'receipt_created_at',created_at),created_at FROM app.marketplace_sample_deletions;

-- Remove functions with RESTRICT, so an unknown dependency blocks the cutover.
DROP FUNCTION app.claim_marketplace_sample_download_cleanup(p_tenant_id uuid, p_authorization_id uuid, p_object_key text) RESTRICT;
DROP FUNCTION app.complete_marketplace_sample_download(p_authorization_id uuid, p_download_expires_at timestamp with time zone, p_request_id uuid, p_ip_fingerprint bytea) RESTRICT;
DROP FUNCTION app.create_marketplace_expert_enquiry(p_enquiry_id uuid, p_actor_user_id uuid, p_actor_api_key_id uuid, p_actor_fingerprint bytea, p_idempotency_key text, p_request_hash bytea, p_template_slug text, p_expected_template_version integer, p_request_id uuid, p_ip_fingerprint bytea) RESTRICT;
DROP FUNCTION app.enforce_marketplace_qualification_execution_evidence() RESTRICT;
DROP FUNCTION app.fail_marketplace_sample_download(p_authorization_id uuid) RESTRICT;
DROP FUNCTION app.fail_marketplace_sample_download_for_cleanup(p_authorization_id uuid) RESTRICT;
DROP FUNCTION app.list_expired_marketplace_fixture_samples(p_as_of timestamp with time zone, p_limit integer) RESTRICT;
DROP FUNCTION app.marketplace_qualification_filter_valid(p_filter jsonb, p_properties jsonb, p_depth integer) RESTRICT;
DROP FUNCTION app.marketplace_qualification_schema_supports(p_schema jsonb, p_type text) RESTRICT;
DROP FUNCTION app.record_marketplace_fixture_deletion(p_sample_id uuid, p_deleted_at timestamp with time zone, p_storage_disposition text, p_actor text) RESTRICT;
DROP FUNCTION app.record_marketplace_fixture_sample(p_sample_id uuid, p_template_version_id uuid, p_sample_version integer, p_object_key text, p_content_type text, p_record_count integer, p_byte_count bigint, p_checksum bytea, p_metadata_checksum bytea, p_schema_version integer, p_masking_policy_version text, p_retention_policy_version text, p_provenance_evidence_reference text, p_collected_at timestamp with time zone, p_expires_at timestamp with time zone, p_actor text) RESTRICT;
DROP FUNCTION app.reject_marketplace_qualification_packet_contract_mutation() RESTRICT;
DROP FUNCTION app.reserve_marketplace_sample_download(p_authorization_id uuid, p_actor_user_id uuid, p_actor_api_key_id uuid, p_actor_fingerprint bytea, p_idempotency_key text, p_request_hash bytea, p_template_slug text, p_expected_sample_version integer, p_format text, p_selected_fields jsonb, p_projection_fingerprint bytea, p_record_limit integer, p_record_count integer, p_object_key text, p_content_type text, p_file_name text, p_byte_count bigint, p_checksum bytea, p_rate_limit_max integer, p_rate_window_seconds integer) RESTRICT;
DROP FUNCTION app.resolve_marketplace_contact_modes(p_template_id uuid, p_template_version integer) RESTRICT;
DROP FUNCTION app.resolve_marketplace_fixture_sample(p_template_slug text, p_template_version integer, p_sample_version integer, p_as_of timestamp with time zone) RESTRICT;
DROP FUNCTION app.resolve_marketplace_sample_ingestion_target(p_template_slug text, p_template_version integer) RESTRICT;
DROP FUNCTION app.resolve_marketplace_sample_preview(p_template_slug text, p_as_of timestamp with time zone) RESTRICT;
DROP FUNCTION app.transition_marketplace_expert_enquiry(p_enquiry_id uuid, p_expected_state text, p_target_state text, p_actor text) RESTRICT;
DROP TRIGGER marketplace_sample_versions_immutable ON app.marketplace_sample_versions;
ALTER TABLE app.marketplace_sample_versions ADD COLUMN evidence_ref text,ADD COLUMN deleted_at timestamptz;
UPDATE app.marketplace_sample_versions s SET evidence_ref=jsonb_build_object('provenance',s.provenance_evidence_reference,'rights',s.rights_evidence_reference,'decision',s.interim_decision_reference,'qualification_packet_id',s.qualification_packet_id)::text,
 deleted_at=(SELECT d.deleted_at FROM app.marketplace_sample_deletions d WHERE d.sample_version_id=s.id);
ALTER TABLE app.marketplace_sample_versions ALTER COLUMN evidence_ref SET NOT NULL;
ALTER TABLE app.marketplace_sample_versions DROP COLUMN provenance_evidence_reference,DROP COLUMN rights_evidence_reference,DROP COLUMN interim_decision_reference,DROP COLUMN qualification_packet_id;
ALTER TABLE app.marketplace_sample_versions RENAME TO marketplace_samples;
ALTER TABLE app.marketplace_samples RENAME COLUMN service_template_version_id TO template_version_id;
ALTER TABLE app.marketplace_samples ADD CONSTRAINT marketplace_sample_evidence_shape CHECK(jsonb_typeof(evidence_ref::jsonb)='object' AND evidence_ref::jsonb ?& ARRAY['provenance','rights','decision','qualification_packet_id'] AND jsonb_typeof(evidence_ref::jsonb->'provenance')='string' AND (evidence_ref::jsonb->>'provenance') IS NOT NULL AND ((evidence_ref::jsonb->>'qualification_packet_id') IS NULL OR (evidence_ref::jsonb->>'qualification_packet_id')::uuid IS NOT NULL));
ALTER TABLE app.marketplace_samples ADD CONSTRAINT marketplace_sample_evidence_provenance CHECK ((evidence_ref::jsonb->>'provenance') ~ '^(fixture|qualification)://[A-Za-z0-9][A-Za-z0-9._/-]*$' AND length(evidence_ref::jsonb->>'provenance') BETWEEN 16 AND 1024);
ALTER TABLE app.marketplace_samples ADD CONSTRAINT marketplace_samples_governance CHECK ((((source_kind = 'synthetic_fixture'::text) AND (state = 'validated_fixture'::text) AND ((evidence_ref::jsonb->>'qualification_packet_id') IS NULL) AND ((evidence_ref::jsonb->>'rights') IS NULL) AND (published_at IS NULL) AND (governance_state = 'synthetic_fixture'::text) AND ((evidence_ref::jsonb->>'decision') IS NULL)) OR ((source_kind = 'provider_qualification'::text) AND (state = 'validated_provider_sample'::text) AND ((evidence_ref::jsonb->>'qualification_packet_id') IS NOT NULL) AND ((evidence_ref::jsonb->>'rights') IS NULL) AND (published_at IS NOT NULL) AND (governance_state = 'formal_agreement_pending_local_demo'::text) AND ((evidence_ref::jsonb->>'decision') = 'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'::text))));
ALTER TABLE app.marketplace_sample_download_authorizations ADD COLUMN finished_at timestamptz;
UPDATE app.marketplace_sample_download_authorizations SET finished_at=coalesce(authorized_at,failed_at);
ALTER TABLE app.marketplace_sample_download_authorizations DROP COLUMN actor_fingerprint,DROP COLUMN idempotency_key,DROP COLUMN request_hash,DROP COLUMN template_slug,DROP COLUMN template_version,DROP COLUMN sample_version,DROP COLUMN projection_fingerprint,DROP COLUMN ip_fingerprint,DROP COLUMN authorized_at,DROP COLUMN failed_at;
ALTER TABLE app.marketplace_sample_download_authorizations RENAME TO marketplace_sample_downloads;
ALTER TABLE app.marketplace_sample_downloads RENAME COLUMN request_id TO trace_id;
ALTER TABLE app.marketplace_sample_downloads ADD CONSTRAINT marketplace_download_finished_state CHECK (
 (state='reserved' AND finished_at IS NULL AND download_expires_at IS NULL) OR
 (state='authorized' AND finished_at IS NOT NULL AND download_expires_at>finished_at) OR
 (state='failed' AND finished_at IS NOT NULL AND download_expires_at IS NULL));
ALTER TABLE app.marketplace_expert_enquiries DROP COLUMN actor_fingerprint,DROP COLUMN idempotency_key,DROP COLUMN request_hash,DROP COLUMN template_slug,DROP COLUMN template_version,DROP COLUMN ip_fingerprint,DROP COLUMN contacted_at,DROP COLUMN closed_at;
ALTER TABLE app.marketplace_expert_enquiries RENAME COLUMN service_template_version_id TO template_version_id;
ALTER TABLE app.marketplace_expert_enquiries RENAME COLUMN request_id TO trace_id;
DROP TABLE app.marketplace_sample_deletions RESTRICT;

-- Samples stay immutable except for a single expiry receipt, owned by the operator.
CREATE FUNCTION app.guard_marketplace_sample_immutability() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,app AS $immutable$
BEGIN IF TG_OP='UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.deleted_at>=OLD.expires_at AND (to_jsonb(NEW)-'deleted_at')=(to_jsonb(OLD)-'deleted_at') THEN RETURN NEW;END IF;RAISE EXCEPTION 'MARKETPLACE_SAMPLE_IMMUTABLE';END $immutable$;
REVOKE ALL ON FUNCTION app.guard_marketplace_sample_immutability() FROM PUBLIC;
CREATE TRIGGER marketplace_samples_immutable BEFORE UPDATE OR DELETE ON app.marketplace_samples FOR EACH ROW EXECUTE FUNCTION app.guard_marketplace_sample_immutability();

-- Preserve execution-disabled sample-only Marketplace versions while allowing bounded reads.
CREATE POLICY templates_0074_sample_read ON app.service_templates FOR SELECT TO dhumi_customer_api USING(product_family='marketplace_dataset' AND state='draft' AND current_public_version_id IS NULL AND (access='all' OR (app.current_user_id() IS NOT NULL AND EXISTS(SELECT 1 FROM app.organization_templates a WHERE a.organization_id=app.current_tenant_id() AND a.service_template_id=id))));
CREATE POLICY versions_0074_sample_read ON app.service_template_versions FOR SELECT TO dhumi_customer_api USING(availability_state='coming_soon' AND published_at IS NULL AND engine IS NULL AND execution_definition IS NULL AND provider_dataset_ciphertext IS NULL AND EXISTS(SELECT 1 FROM app.service_templates t WHERE t.id=service_template_id AND t.product_family='marketplace_dataset' AND t.state='draft' AND t.current_public_version_id IS NULL));
CREATE POLICY samples_0074_customer_read ON app.marketplace_samples FOR SELECT TO dhumi_customer_api USING(EXISTS(SELECT 1 FROM app.service_template_versions v WHERE v.id=template_version_id));
CREATE POLICY samples_0074_operator_read ON app.marketplace_samples FOR SELECT TO dhumi_operator USING(true);
CREATE POLICY samples_0074_operator_insert ON app.marketplace_samples FOR INSERT TO dhumi_operator WITH CHECK(source_kind='synthetic_fixture' AND state='validated_fixture' AND governance_state='synthetic_fixture');
CREATE POLICY samples_0074_operator_expiry ON app.marketplace_samples FOR UPDATE TO dhumi_operator USING(true) WITH CHECK(deleted_at IS NOT NULL);
GRANT SELECT ON app.marketplace_samples TO dhumi_customer_api,dhumi_operator;
GRANT INSERT ON app.marketplace_samples TO dhumi_operator;
GRANT UPDATE(deleted_at) ON app.marketplace_samples TO dhumi_operator;
CREATE POLICY marketplace_sample_downloads_0074_customer ON app.marketplace_sample_downloads FOR ALL TO dhumi_customer_api USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenants o WHERE o.id=tenant_id AND o.state='active') AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.state='active')) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenants o WHERE o.id=tenant_id AND o.state='active') AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.state='active'));
CREATE POLICY marketplace_sample_downloads_0074_operator ON app.marketplace_sample_downloads FOR ALL TO dhumi_operator USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT ON app.marketplace_sample_downloads TO dhumi_customer_api;
GRANT SELECT ON app.marketplace_sample_downloads TO dhumi_operator;
CREATE POLICY enquiries_0074_customer_read ON app.marketplace_expert_enquiries FOR SELECT TO dhumi_customer_api USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenants o WHERE o.id=tenant_id AND o.state='active') AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.state='active'));
 CREATE POLICY enquiries_0074_customer_insert ON app.marketplace_expert_enquiries FOR INSERT TO dhumi_customer_api WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenants o WHERE o.id=tenant_id AND o.state='active') AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.state='active'));
 CREATE POLICY enquiries_0074_customer_lock ON app.marketplace_expert_enquiries FOR UPDATE TO dhumi_customer_api USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.tenants o WHERE o.id=tenant_id AND o.state='active') AND EXISTS(SELECT 1 FROM app.tenant_user_access a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.state='active')) WITH CHECK(false);
 GRANT UPDATE(id) ON app.marketplace_expert_enquiries TO dhumi_customer_api;
CREATE POLICY marketplace_expert_enquiries_0074_operator ON app.marketplace_expert_enquiries FOR ALL TO dhumi_operator USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT ON app.marketplace_expert_enquiries TO dhumi_customer_api;
GRANT SELECT ON app.marketplace_expert_enquiries TO dhumi_operator;
GRANT UPDATE(state,finished_at,download_expires_at,trace_id) ON app.marketplace_sample_downloads TO dhumi_customer_api;
GRANT UPDATE(state,finished_at) ON app.marketplace_sample_downloads TO dhumi_operator;
GRANT UPDATE(state) ON app.marketplace_expert_enquiries TO dhumi_operator;
GRANT SELECT(id,state) ON app.users TO dhumi_operator;
CREATE POLICY users_0074_operator_named_actor ON app.users FOR SELECT TO dhumi_operator USING(id=app.current_user_id());
GRANT UPDATE(state,updated_at) ON app.idempotency_records TO dhumi_operator;
GRANT SELECT(id,tenant_id,resource_id,operation_code,state,updated_at) ON app.idempotency_records TO dhumi_operator;
CREATE POLICY idem_0074_operator_cleanup ON app.idempotency_records FOR ALL TO dhumi_operator USING(tenant_id=app.current_tenant_id() AND operation_code='marketplace.sample_download.authorize.v1') WITH CHECK(tenant_id=app.current_tenant_id() AND operation_code='marketplace.sample_download.authorize.v1');
-- Historical and retained rows must be byte-equivalent except for the explicit fold.
DO $verify$ DECLARE r record;n bigint;digest_value text;BEGIN
 FOR r IN SELECT * FROM phase74_retained LOOP EXECUTE format($digest$SELECT count(*),md5(coalesce(string_agg(d,'' ORDER BY d),'')) FROM(SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s$digest$,r.t) INTO n,digest_value;IF n<>r.n OR digest_value<>r.d THEN RAISE EXCEPTION '0074_RETAINED_ROW_CHANGED %',r.t;END IF;END LOOP;
 IF EXISTS(SELECT 1 FROM phase74_audits p LEFT JOIN app.audit_events a USING(id) WHERE p.digest IS DISTINCT FROM md5(to_jsonb(a)::text)) OR EXISTS(SELECT 1 FROM phase74_idem p LEFT JOIN app.idempotency_records i USING(id) WHERE p.digest IS DISTINCT FROM md5(to_jsonb(i)::text)) THEN RAISE EXCEPTION '0074_EXISTING_AUDIT_OR_REPLAY_CHANGED';END IF;
 IF(SELECT count(*) FROM app.marketplace_samples)<>(SELECT count(*) FROM phase74_samples) OR EXISTS(SELECT 1 FROM phase74_samples p LEFT JOIN app.marketplace_samples s ON s.id=(p.original->>'id')::uuid WHERE
  (to_jsonb(s)-ARRAY['template_version_id','evidence_ref','deleted_at']) IS DISTINCT FROM (p.original-ARRAY['service_template_version_id','provenance_evidence_reference','rights_evidence_reference','interim_decision_reference','qualification_packet_id']) OR s.template_version_id::text IS DISTINCT FROM p.original->>'service_template_version_id' OR s.evidence_ref::jsonb IS DISTINCT FROM jsonb_build_object('provenance',p.original->'provenance_evidence_reference','rights',p.original->'rights_evidence_reference','decision',p.original->'interim_decision_reference','qualification_packet_id',p.original->'qualification_packet_id')) THEN RAISE EXCEPTION '0074_SAMPLE_FOLD_LOSS';END IF;
 IF EXISTS(SELECT 1 FROM phase74_deletions p LEFT JOIN app.marketplace_samples s ON s.id=(p.original->>'sample_version_id')::uuid WHERE s.deleted_at IS DISTINCT FROM (p.original->>'deleted_at')::timestamptz OR NOT EXISTS(SELECT 1 FROM app.audit_events a WHERE a.target_id=s.id AND a.action='marketplace.sample.deletion_backfill' AND a.safe_diff->>'actor'=p.original->>'actor' AND a.safe_diff->>'storage_disposition'=p.original->>'storage_disposition')) THEN RAISE EXCEPTION '0074_DELETION_FOLD_LOSS';END IF;
 IF(SELECT count(*) FROM app.marketplace_sample_downloads)<>(SELECT count(*) FROM phase74_downloads) OR EXISTS(SELECT 1 FROM phase74_downloads p LEFT JOIN app.marketplace_sample_downloads d ON d.id=(p.original->>'id')::uuid WHERE (to_jsonb(d)-ARRAY['trace_id','finished_at']) IS DISTINCT FROM (p.original-ARRAY['request_id','actor_fingerprint','idempotency_key','request_hash','template_slug','template_version','sample_version','projection_fingerprint','ip_fingerprint','authorized_at','failed_at']) OR d.trace_id::text IS DISTINCT FROM p.original->>'request_id' OR d.finished_at IS DISTINCT FROM coalesce((p.original->>'authorized_at')::timestamptz,(p.original->>'failed_at')::timestamptz)) THEN RAISE EXCEPTION '0074_DOWNLOAD_FOLD_LOSS';END IF;
 IF(SELECT count(*) FROM app.marketplace_expert_enquiries)<>(SELECT count(*) FROM phase74_enquiries) OR EXISTS(SELECT 1 FROM phase74_enquiries p LEFT JOIN app.marketplace_expert_enquiries e ON e.id=(p.original->>'id')::uuid WHERE (to_jsonb(e)-ARRAY['template_version_id','trace_id']) IS DISTINCT FROM (p.original-ARRAY['service_template_version_id','request_id','actor_fingerprint','idempotency_key','request_hash','template_slug','template_version','ip_fingerprint','contacted_at','closed_at']) OR e.template_version_id::text IS DISTINCT FROM p.original->>'service_template_version_id' OR e.trace_id::text IS DISTINCT FROM p.original->>'request_id') THEN RAISE EXCEPTION '0074_ENQUIRY_FOLD_LOSS';END IF;
 IF(SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE')<>25 OR(SELECT count(*) FROM information_schema.columns WHERE table_schema='app')<>284 THEN RAISE EXCEPTION '0074_EXPECTED_25_TABLES_282_TABLE_COLUMNS';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND c.relname NOT IN ('auth_refresh_tokens','auth_sessions','schema_migrations') AND(NOT c.relrowsecurity OR NOT c.relforcerowsecurity)) THEN RAISE EXCEPTION '0074_RLS_NOT_FORCED';END IF;
END $verify$;

GRANT UPDATE(id) ON app.users TO dhumi_operator;
CREATE POLICY users_0074_operator_actor_lock ON app.users FOR UPDATE TO dhumi_operator USING(id=app.current_user_id()) WITH CHECK(false);
ALTER FUNCTION app.guard_marketplace_sample_immutability() OWNER TO dhumi_owner;
