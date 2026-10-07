-- 0072 catalogue/execution expansion: REVIEWABLE, NOT APPLIED.
-- Fixed dhumi_test only. Existing runtime writers and all old names remain.
-- The reviewed launcher owns approval, backup pins, transaction and one ledger INSERT.
-- Dataset/definition/hash pairs are populated by the separately guarded operator
-- after 0072 and before 0073; SQL must not copy ciphertext under its old AAD.
DO $execution_gate$ BEGIN
 IF current_setting('dhumi.refactor_apply',true) IS DISTINCT FROM '0072'
  OR current_setting('dhumi.owner_approved',true) IS DISTINCT FROM 'yes'
  OR current_setting('dhumi.backup_restore_verified',true) IS DISTINCT FROM 'yes'
  OR current_setting('dhumi.old_writers_qualified',true) IS DISTINCT FROM 'yes'
  OR current_database()<>'dhumi_test' OR inet_server_port() IS DISTINCT FROM 5432
  OR current_setting('server_version_num')::int<180000
  OR inet_server_addr() IS NULL OR inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet)
  OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
  RAISE EXCEPTION '0072 requires reviewed qualification and separate owner approval on local dhumi_test';
 END IF;
END $execution_gate$;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL search_path=pg_catalog;
-- Freeze the qualified source briefly; contention fails closed, not by bypassing locks.
DO $source_lock$ DECLARE item record; BEGIN
 FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE app.%I IN ACCESS EXCLUSIVE MODE',item.relname);
 END LOOP;
END $source_lock$;
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
DO $source_schema_gate$ BEGIN
 IF current_setting('dhumi.fixture_cleanup_schema')<>'c34cd5a2109c27ceec4b8552d90d9081' THEN
  RAISE EXCEPTION '0072 qualified source catalog changed; requalify before application';
 END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relkind='r')<>35 THEN RAISE EXCEPTION '0072 source table count'; END IF;
END $source_schema_gate$;
DO $history_gate$ BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
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
('0070_archive','0804b5d0716f47f3e826e9aa4c67e38b8d34e2d83ae284eb7cd2a6b1bfdc297a'),
('0071_organizations','af85bea48d8bb0e4c77ba9d301a23977ecfc33b5fe77ded0469c207e13e17bd9')
 ) AS expected(version,checksum) FULL JOIN app.schema_migrations actual USING(version)
 WHERE actual.checksum IS DISTINCT FROM expected.checksum) THEN
  RAISE EXCEPTION '0072 requires all 71 exact applied migration checksums';
 END IF;
END $history_gate$;
CREATE TEMP TABLE refactor0072_source_rows(table_name text PRIMARY KEY,n bigint,digest text) ON COMMIT DROP;
DO $capture_source$ DECLARE item record; row_n bigint; row_digest text; BEGIN
 FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='app' AND c.relkind='r' ORDER BY c.relname LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),'''')) FROM (SELECT md5(to_jsonb(t)::text)d FROM app.%I t)s',item.relname)
   INTO row_n,row_digest;
  INSERT INTO pg_temp.refactor0072_source_rows VALUES(item.relname,row_n,row_digest);
 END LOOP;
END $capture_source$;
DO $source_snapshot_gate$ BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
('adapter_definitions',4,'04aa97e9c7d58af72bc0afb198e7c041'),
('adapter_versions',7,'953d355709b7bd018543fef572310a7c'),
('artifacts',0,'d41d8cd98f00b204e9800998ecf8427e'),
('audit_events',19298,'87eeb7dad26ba8efe28bb8fc59e85082'),
('auth_refresh_tokens',3357,'c130ab8b32ad4dfe87ad0fbae2d6341f'),
('auth_sessions',2967,'6e72e0078069f7c39fcb8f21263b3579'),
('dead_letter_recovery_intents',0,'d41d8cd98f00b204e9800998ecf8427e'),
('email_verifications',0,'d41d8cd98f00b204e9800998ecf8427e'),
('feature_flags',0,'d41d8cd98f00b204e9800998ecf8427e'),
('idempotency_records',11008,'369f45982e8bace45c00b2f1e37baa4f'),
('launch_evidence',26,'62c6f63d2f9ec8e47ca034de22c97832'),
('legal_acceptances',10192,'d67975b714febfabdf8338695bd87e65'),
('marketplace_expert_enquiries',0,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_deletions',0,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_download_authorizations',0,'d41d8cd98f00b204e9800998ecf8427e'),
('marketplace_sample_versions',0,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_invites',0,'d41d8cd98f00b204e9800998ecf8427e'),
('organization_templates',0,'d41d8cd98f00b204e9800998ecf8427e'),
('outbox_events',10823,'c1acb8874ab02acf84469eb5fbcfc704'),
('provider_cost_holds',0,'d41d8cd98f00b204e9800998ecf8427e'),
('provider_credentials',0,'d41d8cd98f00b204e9800998ecf8427e'),
('provider_mappings',0,'d41d8cd98f00b204e9800998ecf8427e'),
('run_attempts',4,'8021c2177ad8cab5a2a52fad4b6b6482'),
('run_events',0,'d41d8cd98f00b204e9800998ecf8427e'),
('run_status_transitions',10,'1e1b865cb1b9207fcd9fad62b9b13839'),
('runs',0,'d41d8cd98f00b204e9800998ecf8427e'),
('schema_migrations',71,'cd945b619dfddc4d40efb5c4fd7865fb'),
('service_template_versions',26,'7c4ea72b9d7cb3e91def5380e418377e'),
('service_templates',13,'553549a2edc97bb12b8667374d54c501'),
('service_versions',0,'d41d8cd98f00b204e9800998ecf8427e'),
('services',0,'d41d8cd98f00b204e9800998ecf8427e'),
('tenant_user_access',10192,'08356bed633fb03fddcaca2236821f73'),
('tenants',10192,'2c2add83470feeb9612e0e41932f34ee'),
('usage_events',0,'d41d8cd98f00b204e9800998ecf8427e'),
('users',10962,'55607d7c26a8b298afba9a0046a37e44')
 ) expected(table_name,n,digest) FULL JOIN pg_temp.refactor0072_source_rows actual USING(table_name)
 WHERE actual.n IS DISTINCT FROM expected.n OR actual.digest IS DISTINCT FROM expected.digest) THEN
  RAISE EXCEPTION '0072 backup-qualified source rows changed; refresh backup and qualification';
 END IF;
END $source_snapshot_gate$;
-- These are migration preconditions, never values silently invented by a merge.
DO $merge_preconditions$ BEGIN
 IF EXISTS(SELECT s.id FROM app.services s LEFT JOIN app.service_versions v ON v.tenant_id=s.tenant_id AND v.service_id=s.id
  GROUP BY s.id HAVING count(v.id)<>1 OR min(v.version)<>1) THEN
  RAISE EXCEPTION '0072 requires exactly one version-1 row per Service'; END IF;
 IF EXISTS(SELECT service_template_version_id FROM app.provider_mappings WHERE environment='test' AND state='enabled'
  GROUP BY service_template_version_id HAVING count(*)<>1) THEN
  RAISE EXCEPTION '0072 has ambiguous enabled test mappings'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_mappings m JOIN app.service_template_versions v ON v.id=m.service_template_version_id
  WHERE m.environment='test' AND m.state='enabled' AND m.adapter_version_id<>v.adapter_version_id) THEN
  RAISE EXCEPTION '0072 enabled mapping/template adapter mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r JOIN app.service_versions v ON v.id=r.service_version_id AND v.tenant_id=r.tenant_id
  WHERE v.service_template_version_id<>r.service_template_version_id) THEN
  RAISE EXCEPTION '0072 Run/Service template provenance mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_cost_holds WHERE currency_code<>'USD')
  OR EXISTS(SELECT 1 FROM app.run_attempts WHERE provider_cost_currency IS NOT NULL AND provider_cost_currency<>'USD')
  OR EXISTS(SELECT 1 FROM app.provider_mappings WHERE environment='test' AND output_policy ? 'scraper_spending'
   AND output_policy->'scraper_spending'->>'currencyCode' IS DISTINCT FROM 'USD') THEN
  RAISE EXCEPTION '0072 cannot represent non-USD or unproved commercial currency'; END IF;
 IF EXISTS(SELECT 1 FROM app.provider_cost_holds h JOIN app.runs r ON r.id=h.run_id
  WHERE h.tenant_id<>r.tenant_id OR h.commercial_config_version<>r.commercial_config_version) THEN
  RAISE EXCEPTION '0072 cost hold provenance mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN('app.service_template_versions'::regclass,'app.services'::regclass,'app.runs'::regclass)
  AND tgname IN('service_template_versions_immutable','services_touch_updated_at','runs_touch_updated_at') AND tgenabled<>'O')
  OR (SELECT count(*) FROM pg_trigger WHERE (tgrelid,tgname) IN
   (('app.service_template_versions'::regclass,'service_template_versions_immutable'),('app.services'::regclass,'services_touch_updated_at'),('app.runs'::regclass,'runs_touch_updated_at')))<>3 THEN
  RAISE EXCEPTION '0072 expected integrity/timestamp guards changed'; END IF;
END $merge_preconditions$;
-- NULL is deliberate during expansion: existing insert writers remain valid.
-- No dataset ciphertext is copied under its old mapping AAD.
ALTER TABLE app.service_template_versions
 ADD COLUMN engine text,
 ADD COLUMN execution_definition jsonb,
 ADD COLUMN definition_sha256 bytea,
 ADD COLUMN provider_dataset_ciphertext bytea,
 ADD COLUMN provider_dataset_fingerprint bytea,
 ADD COLUMN published_by text,
 ADD COLUMN evidence_ref text,
 ADD CONSTRAINT template_engine_closed_check CHECK (engine IS NULL OR engine IN ('amazon.v1','scraper.v1')),
 ADD CONSTRAINT template_execution_definition_object_check CHECK (execution_definition IS NULL OR jsonb_typeof(execution_definition)='object'),
 ADD CONSTRAINT template_execution_definition_pair_check CHECK ((execution_definition IS NULL)=(definition_sha256 IS NULL)),
 ADD CONSTRAINT template_definition_sha256_check CHECK (definition_sha256 IS NULL OR octet_length(definition_sha256)=32),
 ADD CONSTRAINT template_dataset_pair_check CHECK ((provider_dataset_ciphertext IS NULL)=(provider_dataset_fingerprint IS NULL)),
 ADD CONSTRAINT template_dataset_ciphertext_check CHECK (provider_dataset_ciphertext IS NULL OR octet_length(provider_dataset_ciphertext)>=30),
 ADD CONSTRAINT template_dataset_fingerprint_check CHECK (provider_dataset_fingerprint IS NULL OR octet_length(provider_dataset_fingerprint)=32);

ALTER TABLE app.services
 ADD COLUMN template_version_id uuid REFERENCES app.service_template_versions(id) ON DELETE RESTRICT,
 ADD COLUMN configuration jsonb,
 ADD COLUMN created_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
 ADD CONSTRAINT services_configuration_object_check CHECK (configuration IS NULL OR jsonb_typeof(configuration)='object'),
 ADD CONSTRAINT services_creator_membership_fk FOREIGN KEY (tenant_id,created_by_user_id)
  REFERENCES app.tenant_user_access(tenant_id,user_id) ON DELETE RESTRICT;

ALTER TABLE app.runs
 ADD COLUMN service_id uuid,
 ADD COLUMN trace_id uuid,
 ADD COLUMN cost_state text,
 ADD COLUMN estimated_cost_micros bigint,
 ADD COLUMN final_cost_micros bigint,
 ADD CONSTRAINT runs_service_fk FOREIGN KEY (tenant_id,service_id) REFERENCES app.services(tenant_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT runs_cost_state_check CHECK (cost_state IS NULL OR cost_state IN ('held','finalized','released')),
 ADD CONSTRAINT runs_estimated_cost_check CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros>=0),
 ADD CONSTRAINT runs_final_cost_check CHECK (final_cost_micros IS NULL OR final_cost_micros>=0);

-- A historical request_id could have come from the caller. It is not proof of
-- a server-owned trace: leave unmatched history NULL rather than invent it.
ALTER TABLE app.audit_events ADD COLUMN trace_id uuid;

CREATE TABLE app.provider_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE RESTRICT,
 run_id uuid NOT NULL,
 initiated_by_user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
 attempt_id uuid,
 purpose text NOT NULL CHECK (purpose IN ('run_submit','run_poll','run_download','run_cancel')),
 endpoint text NOT NULL CHECK (endpoint IN (
  '/datasets/v3/scrape','/datasets/v3/trigger','/datasets/v3/progress/:snapshot',
  '/datasets/v3/snapshot/:snapshot','/datasets/v3/snapshot/:snapshot/parts',
  '/datasets/v3/snapshot/:snapshot/cancel')),
 state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','responded','not_sent','uncertain')),
 http_status integer CHECK (http_status BETWEEN 100 AND 599),
 safe_error_code text CHECK (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 response_bytes bigint CHECK (response_bytes>=0),
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CONSTRAINT provider_calls_run_fk FOREIGN KEY (organization_id,run_id) REFERENCES app.runs(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT provider_calls_attempt_fk FOREIGN KEY (organization_id,attempt_id) REFERENCES app.run_attempts(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT provider_calls_initiator_membership_fk FOREIGN KEY (organization_id,initiated_by_user_id)
  REFERENCES app.tenant_user_access(tenant_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT provider_calls_observation_check CHECK (
  (state='prepared' AND http_status IS NULL AND safe_error_code IS NULL AND response_bytes IS NULL AND finished_at IS NULL)
  OR (state='responded' AND http_status IS NOT NULL AND finished_at IS NOT NULL)
  OR (state IN ('not_sent','uncertain') AND http_status IS NULL AND response_bytes IS NULL AND finished_at IS NOT NULL)),
 CONSTRAINT provider_calls_time_check CHECK (finished_at IS NULL OR finished_at>=prepared_at)
);
ALTER TABLE app.provider_calls ADD CONSTRAINT provider_calls_purpose_endpoint_check CHECK (
 (purpose='run_submit' AND endpoint IN('/datasets/v3/scrape','/datasets/v3/trigger'))
 OR (purpose='run_poll' AND endpoint='/datasets/v3/progress/:snapshot')
 OR (purpose='run_download' AND endpoint IN('/datasets/v3/snapshot/:snapshot','/datasets/v3/snapshot/:snapshot/parts'))
 OR (purpose='run_cancel' AND endpoint='/datasets/v3/snapshot/:snapshot/cancel'));
ALTER TABLE app.provider_calls OWNER TO dhumi_owner;
ALTER TABLE app.provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.provider_calls FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.provider_calls FROM PUBLIC;
CREATE POLICY provider_calls_worker_scope ON app.provider_calls TO dhumi_job_manager
 USING (organization_id=app.current_tenant_id()) WITH CHECK (organization_id=app.current_tenant_id());
GRANT SELECT ON app.provider_calls TO dhumi_job_manager;
GRANT INSERT (id,organization_id,run_id,initiated_by_user_id,attempt_id,purpose,endpoint) ON app.provider_calls TO dhumi_job_manager;
GRANT UPDATE (state,http_status,safe_error_code,response_bytes,finished_at) ON app.provider_calls TO dhumi_job_manager;

CREATE FUNCTION app.guard_provider_call_observation() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN
 IF (NEW.id,NEW.organization_id,NEW.run_id,NEW.initiated_by_user_id,NEW.attempt_id,NEW.purpose,NEW.endpoint,NEW.prepared_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.run_id,OLD.initiated_by_user_id,OLD.attempt_id,OLD.purpose,OLD.endpoint,OLD.prepared_at)
  OR OLD.state<>'prepared' OR NEW.state='prepared' THEN
  RAISE EXCEPTION 'Provider call identity is immutable and observation is finalized once' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION app.guard_provider_call_observation() OWNER TO dhumi_owner;
REVOKE ALL ON FUNCTION app.guard_provider_call_observation() FROM PUBLIC;
CREATE TRIGGER provider_calls_observation_guard BEFORE UPDATE ON app.provider_calls
 FOR EACH ROW EXECUTE FUNCTION app.guard_provider_call_observation();

CREATE FUNCTION app.validate_provider_call_attempt_run() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN
 IF NEW.attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.run_attempts a
  WHERE a.id=NEW.attempt_id AND a.tenant_id=NEW.organization_id AND a.run_id=NEW.run_id) THEN
  RAISE EXCEPTION 'Provider call Attempt must belong to its Run' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION app.validate_provider_call_attempt_run() OWNER TO dhumi_owner;
REVOKE ALL ON FUNCTION app.validate_provider_call_attempt_run() FROM PUBLIC;
CREATE TRIGGER provider_calls_attempt_run_guard BEFORE INSERT ON app.provider_calls
 FOR EACH ROW EXECUTE FUNCTION app.validate_provider_call_attempt_run();

CREATE INDEX provider_calls_organization_time_idx ON app.provider_calls(organization_id,prepared_at,id);
CREATE INDEX provider_calls_run_time_idx ON app.provider_calls(run_id,prepared_at);


-- One privileged, table-locked transaction bypasses only these three guards.
-- Foreign keys/RLS/all lifecycle guards stay enabled. Source clocks/bytes are
-- checked below and the original guard states are restored before return.
ALTER TABLE app.service_template_versions DISABLE TRIGGER service_template_versions_immutable;
ALTER TABLE app.services DISABLE TRIGGER services_touch_updated_at;
ALTER TABLE app.runs DISABLE TRIGGER runs_touch_updated_at;
UPDATE app.service_template_versions v SET
 engine=CASE WHEN d.code='bright_data.amazon.scraper_library' AND a.semantic_version IN
  ('1.0.0-pattern6','1.1.0-pattern8-output-contracts','1.1.0-pattern8-release')
  AND encode(a.code_artifact_digest,'hex') IN
   ('afd0a29edcc08fdae2d26e1b3c9ca2281869b184e550717e834592c969336a62','742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14')
  AND t.product_family='scraper_library' THEN 'amazon.v1' ELSE NULL END,
 published_by=e.approved_by,
 evidence_ref=jsonb_build_object('restricted_reference',e.restricted_reference,'evidence_hash',encode(e.evidence_hash,'hex'))::text
 FROM app.adapter_versions a JOIN app.adapter_definitions d ON d.id=a.adapter_definition_id,
 app.service_templates t,app.launch_evidence e
 WHERE a.id=v.adapter_version_id AND t.id=v.service_template_id AND e.id=v.launch_evidence_id;
-- Shared engine identity is finalized only with the recorder's new source digest
-- at 0073; no old published/in-flight shared pin is rebound here.
UPDATE app.services s SET template_version_id=v.service_template_version_id,
 configuration=v.validated_configuration,created_by_user_id=v.created_by_user_id
 FROM app.service_versions v WHERE v.service_id=s.id AND v.tenant_id=s.tenant_id;
UPDATE app.runs r SET service_id=v.service_id FROM app.service_versions v
 WHERE v.id=r.service_version_id AND v.tenant_id=r.tenant_id;
UPDATE app.runs r SET cost_state=h.state,estimated_cost_micros=h.estimated_amount_micros,final_cost_micros=h.finalized_amount_micros
 FROM app.provider_cost_holds h WHERE h.run_id=r.id AND h.tenant_id=r.tenant_id;
-- Missing source holds and unproved historical caller traces stay NULL.
-- No new trace CHECK/default or synchronization trigger is installed at expansion.
ALTER TABLE app.runs ENABLE TRIGGER runs_touch_updated_at;
ALTER TABLE app.services ENABLE TRIGGER services_touch_updated_at;
ALTER TABLE app.service_template_versions ENABLE TRIGGER service_template_versions_immutable;
DO $moved_value_gate$ BEGIN
 IF EXISTS(SELECT 1 FROM app.services s JOIN app.service_versions v ON v.service_id=s.id AND v.tenant_id=s.tenant_id
  WHERE (s.template_version_id,s.configuration,s.created_by_user_id) IS DISTINCT FROM
   (v.service_template_version_id,v.validated_configuration,v.created_by_user_id)) THEN RAISE EXCEPTION '0072 Service moved values mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r JOIN app.service_versions v ON v.id=r.service_version_id AND v.tenant_id=r.tenant_id
  WHERE r.service_id IS DISTINCT FROM v.service_id) THEN RAISE EXCEPTION '0072 Run Service provenance mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r JOIN app.provider_cost_holds h ON h.run_id=r.id AND h.tenant_id=r.tenant_id
  WHERE (r.cost_state,r.estimated_cost_micros,r.final_cost_micros) IS DISTINCT FROM (h.state,h.estimated_amount_micros,h.finalized_amount_micros)) THEN
  RAISE EXCEPTION '0072 cost moved values mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs r WHERE NOT EXISTS(SELECT 1 FROM app.provider_cost_holds h WHERE h.run_id=r.id)
  AND (r.cost_state IS NOT NULL OR r.estimated_cost_micros IS NOT NULL OR r.final_cost_micros IS NOT NULL)) THEN
  RAISE EXCEPTION '0072 invented missing historical cost'; END IF;
 IF EXISTS(SELECT 1 FROM app.runs WHERE trace_id IS NOT NULL) OR EXISTS(SELECT 1 FROM app.audit_events WHERE trace_id IS NOT NULL) THEN
  RAISE EXCEPTION '0072 invented historical server trace'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions v JOIN app.launch_evidence e ON e.id=v.launch_evidence_id
  WHERE v.published_by IS DISTINCT FROM e.approved_by OR v.evidence_ref IS DISTINCT FROM
   jsonb_build_object('restricted_reference',e.restricted_reference,'evidence_hash',encode(e.evidence_hash,'hex'))::text) THEN
  RAISE EXCEPTION '0072 publication evidence moved values mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM app.service_template_versions WHERE execution_definition IS NOT NULL OR definition_sha256 IS NOT NULL
  OR provider_dataset_ciphertext IS NOT NULL OR provider_dataset_fingerprint IS NOT NULL) THEN
  RAISE EXCEPTION '0072 definition/dataset operator must run separately after expansion'; END IF;
END $moved_value_gate$;
DO $source_value_preservation$ DECLARE item record; omitted text[]; row_n bigint; row_digest text; BEGIN
 FOR item IN SELECT * FROM pg_temp.refactor0072_source_rows ORDER BY table_name LOOP
  omitted:=CASE item.table_name
   WHEN 'service_template_versions' THEN ARRAY['engine','execution_definition','definition_sha256','provider_dataset_ciphertext','provider_dataset_fingerprint','published_by','evidence_ref']
   WHEN 'services' THEN ARRAY['template_version_id','configuration','created_by_user_id']
   WHEN 'runs' THEN ARRAY['service_id','trace_id','cost_state','estimated_cost_micros','final_cost_micros']
   WHEN 'audit_events' THEN ARRAY['trace_id'] ELSE ARRAY[]::text[] END;
  EXECUTE format('SELECT count(*),md5(coalesce(string_agg(d,'''' ORDER BY d),'''')) FROM (SELECT md5((to_jsonb(t)-$1)::text)d FROM app.%I t)s',item.table_name)
   INTO row_n,row_digest USING omitted;
  IF row_n<>item.n OR row_digest<>item.digest THEN RAISE EXCEPTION '0072 changed retained source values in %',item.table_name; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r')<>36
  OR (SELECT count(*) FROM information_schema.columns WHERE table_schema='app' AND table_name='provider_calls')<>13
  OR EXISTS(SELECT 1 FROM app.provider_calls) OR (SELECT count(*) FROM app.schema_migrations)<>71
  OR (SELECT column_default FROM information_schema.columns WHERE table_schema='app' AND table_name='runs' AND column_name='state_version')<>'0'
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app.runs'::regclass AND conname LIKE '%trace%')
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN('app.service_template_versions'::regclass,'app.services'::regclass,'app.runs'::regclass)
   AND tgname IN('service_template_versions_immutable','services_touch_updated_at','runs_touch_updated_at') AND tgenabled<>'O') THEN
  RAISE EXCEPTION '0072 expansion/history/default/guard assertion failed'; END IF;
END $source_value_preservation$;
