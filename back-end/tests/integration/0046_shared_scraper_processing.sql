-- Disposable/rollback-only proof. Synthetic identities, no provider client.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END; $$;

SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(state = 'disabled')
  FROM app.adapter_versions a JOIN app.adapter_definitions d ON d.id = a.adapter_definition_id
  WHERE d.code = 'bright_data.scraper_library.shared'
    AND a.semantic_version = '1.0.0-shared-scraper-processing'), 'draft protocol remains disabled');
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(state = 'enabled')
  FROM app.adapter_versions a JOIN app.adapter_definitions d ON d.id = a.adapter_definition_id
  WHERE d.code = 'bright_data.scraper_library.shared'
    AND a.semantic_version = '1.1.0-shared-scraper-release'), 'one shared release identity is available without an operation');
SELECT pg_temp.assert_true(
  has_function_privilege('dhumi_job_manager','app.resolve_provider_executor_identity(uuid,uuid,uuid)','EXECUTE')
  AND has_function_privilege('dhumi_job_manager','app.resolve_shared_scraper_execution_plan(uuid,uuid,uuid,text,uuid)','EXECUTE')
  AND has_function_privilege('dhumi_admission','app.resolve_shared_scraper_admission_contract(uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('dhumi_customer_api','app.resolve_shared_scraper_execution_plan(uuid,uuid,uuid,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('dhumi_job_manager','app.resolve_shared_scraper_admission_contract(uuid,uuid)','EXECUTE')
  AND NOT has_table_privilege('dhumi_job_manager','app.provider_credentials','SELECT'), 'function-only least privilege');

INSERT INTO app.users(id,email_normalized,password_hash) VALUES
 ('76010000-0000-4000-8000-000000000015','shared-scraper@example.test','$argon2id$offline-fixture-only');
INSERT INTO app.tenants(id,display_name) VALUES
 ('76010000-0000-4000-8000-000000000001','Shared scraper proof'),
 ('76010000-0000-4000-8000-000000000002','Other Tenant');
INSERT INTO app.tenant_user_access(tenant_id,user_id) VALUES
 ('76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-000000000015');
INSERT INTO app.launch_evidence(id,evidence_code,scope_type,scope_key,state,restricted_reference,effective_at,approved_by,approved_at)
 VALUES
 ('76010000-0000-4000-8000-000000000003','shared-template-fixture','template','shared','approved','fixture:template',clock_timestamp()-interval '1 hour','offline-test',clock_timestamp()-interval '1 hour'),
 ('76010000-0000-4000-8000-000000000004','shared-mapping-fixture','mapping','shared','approved','fixture:mapping',clock_timestamp()-interval '1 hour','offline-test',clock_timestamp()-interval '1 hour'),
 ('76010000-0000-4000-8000-000000000005','shared-feature-fixture','feature','shared','approved','fixture:feature',clock_timestamp()-interval '1 hour','offline-test',clock_timestamp()-interval '1 hour');
INSERT INTO app.feature_flags(id,feature_code,environment,state,launch_evidence_id,changed_by,changed_reason)
 VALUES ('76010000-0000-4000-8000-000000000006','scraper_library','test','enabled','76010000-0000-4000-8000-000000000005','offline-test','rollback-only proof');

INSERT INTO app.service_templates(id,slug,product_family,state) VALUES
 ('76010000-0000-4000-8000-000000000009','shared-scraper-proof','scraper_library','draft');
INSERT INTO app.service_template_versions(id,service_template_id,version,public_name,public_description,input_schema,configuration_schema,
 output_schema,presentation_metadata,availability_copy,availability_state,adapter_version_id,launch_evidence_id,effective_at,published_at)
 SELECT '76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-000000000009',1,'Shared proof','Offline only',
 '{"type":"object","additionalProperties":false,"required":["targets"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string"}}}}}}'::jsonb,
 '{"type":"object","additionalProperties":false}'::jsonb,
 '{"type":"array","items":{"type":"object","additionalProperties":false,"required":["url"],"properties":{"url":{"type":"string"}}}}'::jsonb,
 '{"domain_slug":"target-com","domain_name":"Target","category":"ecommerce","icon_key":"target","operation_group":"Products","operation_name":"Collect by URL","display_priority":100}'::jsonb,
 'Offline only','available',a.id,'76010000-0000-4000-8000-000000000003',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'
 FROM app.adapter_versions a JOIN app.adapter_definitions d ON d.id=a.adapter_definition_id
 WHERE d.code='bright_data.scraper_library.shared' AND a.semantic_version='1.1.0-shared-scraper-release';
UPDATE app.service_templates SET state='published',current_public_version_id='76010000-0000-4000-8000-00000000000a'
 WHERE id='76010000-0000-4000-8000-000000000009';
INSERT INTO app.provider_credentials(id,provider_code,environment,vault_secret_reference,permission_label,state,activated_at)
 VALUES ('76010000-0000-4000-8000-00000000000b','bright_data','test','FIXTURE_ONLY_NOT_A_SECRET','offline-proof','active',clock_timestamp()-interval '1 hour');
INSERT INTO app.provider_mappings(id,service_template_version_id,adapter_version_id,provider_credential_id,environment,operation_code,
 provider_resource_ciphertext,provider_resource_fingerprint,output_policy,commercial_config_version,config_version,launch_evidence_id,state)
 SELECT '76010000-0000-4000-8000-00000000000c',v.id,v.adapter_version_id,'76010000-0000-4000-8000-00000000000b','test','target.products.collect_by_url',
 decode(repeat('52',40),'hex'),decode(repeat('53',32),'hex'),
 '{"scraper_processing":{"version":1},"scraper_contract_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,
 'offline-proof','offline-proof','76010000-0000-4000-8000-000000000004','enabled'
 FROM app.service_template_versions v WHERE v.id='76010000-0000-4000-8000-00000000000a';
-- The first mapping has no approved spending policy and must never admit a
-- shared-protocol Run, even though its release and credential are enabled.
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 BEGIN
  PERFORM * FROM app.require_shared_scraper_run_capacity('test','76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-00000000000c',1);
  RAISE EXCEPTION 'missing commercial policy admitted';
 EXCEPTION WHEN SQLSTATE 'P5104' THEN NULL;
 END;
END; $$;
SELECT pg_temp.assert_true(
  has_column_privilege('dhumi_admission','app.adapter_versions','semantic_version','SELECT'),
  'admission can inspect the immutable adapter version');
RESET ROLE;

-- An independent, synthetic local mapping proves a bounded and approved
-- commercial policy without changing the original test mapping or any
-- operational mapping. All amounts here are offline test values, not prices.
INSERT INTO app.provider_credentials(id,provider_code,environment,vault_secret_reference,permission_label,state,activated_at)
 VALUES ('76010000-0000-4000-8000-000000000031','bright_data','local','FIXTURE_ONLY_LOCAL_NOT_A_SECRET','offline-proof','active',clock_timestamp()-interval '1 hour');
INSERT INTO app.launch_evidence(id,evidence_code,scope_type,scope_key,state,restricted_reference,effective_at,approved_by,approved_at)
 VALUES ('76010000-0000-4000-8000-000000000032','shared-local-mapping-fixture','mapping','shared-local','approved','fixture:local-mapping',clock_timestamp()-interval '1 hour','offline-test',clock_timestamp()-interval '1 hour');
INSERT INTO app.provider_mappings(id,service_template_version_id,adapter_version_id,provider_credential_id,environment,operation_code,
 provider_resource_ciphertext,provider_resource_fingerprint,output_policy,commercial_config_version,config_version,launch_evidence_id,state)
 SELECT '76010000-0000-4000-8000-000000000030',v.id,v.adapter_version_id,'76010000-0000-4000-8000-000000000031','local','target.products.collect_by_url',
 decode(repeat('62',40),'hex'),decode(repeat('63',32),'hex'),
 jsonb_build_object('scraper_processing',jsonb_build_object('version',1,'request',jsonb_build_object('limitPerInput',5)),
   'scraper_contract_sha256',repeat('a',64),
   'scraper_spending',jsonb_build_object('version','offline-proof-v1','evidenceId','76010000-0000-4000-8000-000000000033',
     'maxInputsPerRun',2,'maxRecordsPerInput',5,'maxRunsPerDay',1,'maxConcurrentRuns',1,
     'upperBoundMicrosPerRecord',10,'fixedUpperBoundMicros',0,'maximumHoldMicros',100,'currencyCode','USD')),
 'offline-proof-v1','offline-proof','76010000-0000-4000-8000-000000000032','enabled'
 FROM app.service_template_versions v WHERE v.id='76010000-0000-4000-8000-00000000000a';
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 BEGIN
  PERFORM * FROM app.require_shared_scraper_run_capacity('local','76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-000000000030',2);
  RAISE EXCEPTION 'unapproved commercial policy admitted';
 EXCEPTION WHEN SQLSTATE 'P5104' THEN NULL;
 END;
END; $$;
RESET ROLE;
INSERT INTO app.launch_evidence(id,evidence_code,scope_type,scope_key,state,restricted_reference,evidence_hash,effective_at,approved_by,approved_at)
 SELECT '76010000-0000-4000-8000-000000000033','shared-local-commercial-fixture','scraper_commercial',
 '76010000-0000-4000-8000-000000000030','approved','fixture:approved-local-commercial-policy',
 sha256(convert_to(((mapping.output_policy->'scraper_spending') - 'evidenceId')::text,'UTF8')),
 clock_timestamp()-interval '1 hour','offline-test',clock_timestamp()-interval '1 hour'
 FROM app.provider_mappings AS mapping WHERE mapping.id='76010000-0000-4000-8000-000000000030';
INSERT INTO app.feature_flags(id,feature_code,environment,state,launch_evidence_id,changed_by,changed_reason)
 VALUES ('76010000-0000-4000-8000-000000000035','scraper_library','local','enabled',
 '76010000-0000-4000-8000-000000000005','offline-test','rollback-only local proof');
SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(estimated_amount_micros=100 AND currency_code='USD'
  AND evidence_reference='fixture:approved-local-commercial-policy')
 FROM app.require_shared_scraper_run_capacity('local','76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-000000000030',2)),
 'approved shared policy returns the exact bounded hold');
DO $$ BEGIN
 BEGIN
  PERFORM * FROM app.require_shared_scraper_run_capacity('local','76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-000000000030',3);
  RAISE EXCEPTION 'over-limit input admitted';
 EXCEPTION WHEN SQLSTATE 'P5101' THEN NULL;
 END;
 BEGIN
  PERFORM * FROM app.require_shared_scraper_run_capacity('production','76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-000000000030',1);
  RAISE EXCEPTION 'unqualified production environment admitted';
 EXCEPTION WHEN SQLSTATE 'P5104' THEN NULL;
 END;
END; $$;
RESET ROLE;
INSERT INTO app.services(id,tenant_id,service_template_id,name,state,current_version) VALUES
 ('76010000-0000-4000-8000-00000000000d','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-000000000009','Shared proof','active',1);
INSERT INTO app.service_versions(id,tenant_id,service_id,version,service_template_version_id,validated_configuration,schema_hash,created_by_user_id) VALUES
 ('76010000-0000-4000-8000-00000000000e','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-00000000000d',1,
 '76010000-0000-4000-8000-00000000000a','{}'::jsonb,decode(repeat('54',32),'hex'),'76010000-0000-4000-8000-000000000015');
INSERT INTO app.runs(id,tenant_id,service_version_id,service_template_version_id,adapter_version_id,provider_mapping_id,commercial_config_version,
 validated_input,template_launch_evidence_id,mapping_launch_evidence_id,feature_flag_id,feature_launch_evidence_id,public_status,internal_status,state_version,retryable,started_at)
 SELECT '76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-00000000000e',v.id,v.adapter_version_id,
 '76010000-0000-4000-8000-000000000030','offline-proof-v1','{"targets":[{"url":"https://www.target.com/p/offline"}]}'::jsonb,
 '76010000-0000-4000-8000-000000000003','76010000-0000-4000-8000-000000000032','76010000-0000-4000-8000-000000000035',
 '76010000-0000-4000-8000-000000000005','running','SUBMITTED',2,false,clock_timestamp()
 FROM app.service_template_versions v WHERE v.id='76010000-0000-4000-8000-00000000000a';
INSERT INTO app.run_attempts(id,tenant_id,run_id,attempt_number,kind,state,fence_token,worker_lease_expires_at,adapter_version_id,provider_mapping_id,provider_credential_id)
 SELECT '76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-00000000000f',1,'submission','claimed',
 '76010000-0000-4000-8000-000000000011',clock_timestamp()+interval '15 minutes',v.adapter_version_id,'76010000-0000-4000-8000-000000000030','76010000-0000-4000-8000-000000000031'
 FROM app.service_template_versions v WHERE v.id='76010000-0000-4000-8000-00000000000a';

SET LOCAL ROLE dhumi_admission;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(operation_code='target.products.collect_by_url')
 FROM app.resolve_shared_scraper_admission_contract('76010000-0000-4000-8000-00000000000a','76010000-0000-4000-8000-00000000000c')), 'admission reads a pinned contract without credentials');
SET LOCAL ROLE dhumi_job_manager;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(adapter_code='bright_data.scraper_library.shared')
 FROM app.resolve_provider_executor_identity('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011')), 'fenced identity uses the Run pin');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(provider_resource_ciphertext IS NOT NULL AND vault_secret_reference IS NOT NULL)
 FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011','submission','76010000-0000-4000-8000-000000000010')), 'one pinned submission plan');
RESET ROLE;
UPDATE app.launch_evidence SET expires_at=clock_timestamp()-interval '1 second'
 WHERE id='76010000-0000-4000-8000-000000000033';
SET LOCAL ROLE dhumi_job_manager;
DO $$ BEGIN
 BEGIN
  PERFORM * FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011','submission','76010000-0000-4000-8000-000000000010');
  RAISE EXCEPTION 'expired commercial evidence allowed provider submission';
 EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
 END;
END; $$;
RESET ROLE;
UPDATE app.launch_evidence SET expires_at=NULL
 WHERE id='76010000-0000-4000-8000-000000000033';
SET LOCAL ROLE dhumi_job_manager;
DO $$ BEGIN
 BEGIN PERFORM * FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000099','submission','76010000-0000-4000-8000-000000000010'); RAISE EXCEPTION 'stale fence accepted'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN PERFORM * FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011','normalization','76010000-0000-4000-8000-000000000010'); RAISE EXCEPTION 'normalization without durable raw accepted'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
 BEGIN PERFORM 1 FROM app.provider_credentials; RAISE EXCEPTION 'direct credentials SELECT accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 BEGIN PERFORM * FROM app.resolve_provider_executor_identity('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011'); RAISE EXCEPTION 'wrong Tenant identity accepted'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
END; $$;
SELECT set_config('app.tenant_id','76010000-0000-4000-8000-000000000001',true);
RESET ROLE;
UPDATE app.run_attempts SET worker_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='76010000-0000-4000-8000-000000000010';
SET LOCAL ROLE dhumi_job_manager;
DO $$ BEGIN
 BEGIN PERFORM * FROM app.resolve_provider_executor_identity('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011'); RAISE EXCEPTION 'expired lease accepted'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
END; $$;
RESET ROLE;
UPDATE app.run_attempts SET worker_lease_expires_at=clock_timestamp()+interval '15 minutes' WHERE id='76010000-0000-4000-8000-000000000010';
-- Guarded transitions are already independently proven. This isolated fixture
-- changes state only to exercise the reader, never to repair a real Run.
ALTER TABLE app.runs DISABLE TRIGGER USER;
UPDATE app.runs SET internal_status='PROCESSING',state_version=4 WHERE id='76010000-0000-4000-8000-00000000000f';
ALTER TABLE app.runs ENABLE TRIGGER USER;
INSERT INTO app.artifacts(id,tenant_id,run_id,attempt_id,kind,state,object_key,content_type,byte_count,checksum,artifact_version)
 VALUES ('76010000-0000-4000-8000-000000000012','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-00000000000f',
 '76010000-0000-4000-8000-000000000010','raw','durable','offline-private-key','application/json',2,decode(repeat('55',32),'hex'),1);
SET LOCAL ROLE dhumi_job_manager;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(provider_resource_ciphertext IS NULL AND provider_resource_fingerprint IS NULL AND vault_secret_reference IS NULL)
 FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000010','76010000-0000-4000-8000-000000000011','normalization','76010000-0000-4000-8000-000000000010')), 'normalization follows raw evidence but returns no credentials');
RESET ROLE;
ALTER TABLE app.runs DISABLE TRIGGER USER;
UPDATE app.runs SET internal_status='SUBMITTED',state_version=2 WHERE id='76010000-0000-4000-8000-00000000000f';
ALTER TABLE app.runs ENABLE TRIGGER USER;
UPDATE app.run_attempts SET state='ambiguous',finished_at=clock_timestamp(),provider_reference_ciphertext=decode(repeat('56',40),'hex'),
 provider_reference_fingerprint=decode(repeat('57',32),'hex') WHERE id='76010000-0000-4000-8000-000000000010';
INSERT INTO app.run_attempts(id,tenant_id,run_id,attempt_number,kind,state,fence_token,worker_lease_expires_at,adapter_version_id,provider_mapping_id,provider_credential_id)
 SELECT '76010000-0000-4000-8000-000000000020','76010000-0000-4000-8000-000000000001','76010000-0000-4000-8000-00000000000f',2,'reconciliation','claimed',
 '76010000-0000-4000-8000-000000000021',clock_timestamp()+interval '15 minutes',v.adapter_version_id,'76010000-0000-4000-8000-000000000030','76010000-0000-4000-8000-000000000031'
 FROM app.service_template_versions v WHERE v.id='76010000-0000-4000-8000-00000000000a';
SET LOCAL ROLE dhumi_job_manager;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(source_attempt_id='76010000-0000-4000-8000-000000000010' AND source_provider_reference_ciphertext IS NOT NULL)
 FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000020','76010000-0000-4000-8000-000000000021','reconciliation','76010000-0000-4000-8000-000000000010')), 'reconciliation returns only the original ambiguous continuation');
DO $$ BEGIN
 BEGIN PERFORM * FROM app.resolve_shared_scraper_execution_plan('76010000-0000-4000-8000-00000000000f','76010000-0000-4000-8000-000000000020','76010000-0000-4000-8000-000000000021','submission','76010000-0000-4000-8000-000000000010'); RAISE EXCEPTION 'reconciliation could resubmit'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
END; $$;
RESET ROLE;
ROLLBACK;
\echo 'Shared scraper Tenant/fence/lease/admission/normalization/reconciliation database proof passed. Provider calls: 0.'
