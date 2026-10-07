import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { withOperatorTransaction } from '../database/transactions.js';
import { requireExecutableTemplate } from '../catalogue/templateExecutionDefinition.js';
import type { ProviderReferenceProtector } from './providerReferenceProtector.js';
import { providerDatasetAad } from './providerReferenceContexts.js';
import { runDatabaseError } from '../jobs/runLifecycle.js';

/** Existing operator capability only; no provider transport, new process or customer route. */
export function createTemplateBindingRepository(pool:Pool,protector:ProviderReferenceProtector) {
  return {
    setDataset:async(input:{templateVersionId:string;datasetId:string;operatorUserId:string})=>{
      if(!/^gd_[a-z0-9]{8,128}$/.test(input.datasetId))throw new Error('Invalid private dataset binding');
      return withOperatorTransaction(pool,async db=>{
        const row=await db.query<{published_at:Date|null}>(`SELECT published_at FROM app.service_template_versions WHERE id=$1 FOR UPDATE`,[input.templateVersionId]);
        if(!row.rows[0]||row.rows[0].published_at!==null)runDatabaseError('23514','PUBLISHED_TEMPLATE_VERSION_IMMUTABLE');
        const binding=await protector.protect(input.datasetId,providerDatasetAad(input.templateVersionId));
        if(await protector.reveal(binding.ciphertext,binding.fingerprint,providerDatasetAad(input.templateVersionId))!==input.datasetId)throw new Error('Private binding verification failed');
        const changed=await db.query(`UPDATE app.service_template_versions SET provider_dataset_ciphertext=$1,provider_dataset_fingerprint=$2 WHERE id=$3 AND published_at IS NULL RETURNING id`,[binding.ciphertext,binding.fingerprint,input.templateVersionId]);
        if(changed.rows.length!==1)runDatabaseError('40001','TEMPLATE_BINDING_CONFLICT');
        await db.query(`INSERT INTO app.audit_events(actor_user_id,action,target_type,target_id,outcome,trace_id)
          VALUES($1,'template.dataset.bind','service_template_version',$2,'bound',$3)`,[input.operatorUserId,input.templateVersionId,randomUUID()]);
      });
    },
    publish:async(input:{templateVersionId:string;operatorUserId:string;evidenceReference:string})=>{
      if(!input.evidenceReference.trim()||input.evidenceReference.length>2048)throw new Error('Accepted evidence reference is required');
      return withOperatorTransaction(pool,async db=>{
        const parent=await db.query<{service_template_id:string}>('SELECT service_template_id FROM app.service_template_versions WHERE id=$1',[input.templateVersionId]);
        if(!parent.rows[0])runDatabaseError('P0002','TEMPLATE_VERSION_NOT_FOUND');
        const template=await db.query<{id:string;product_family:string;state:string}>('SELECT id,product_family,state FROM app.service_templates WHERE id=$1 FOR UPDATE',[parent.rows[0].service_template_id]);
        const versions=await db.query<{id:string;published_at:Date|null;engine:string|null;execution_definition:unknown;definition_sha256:Buffer|null;provider_dataset_ciphertext:Buffer|null;provider_dataset_fingerprint:Buffer|null}>(`
          SELECT id,published_at,engine,execution_definition,definition_sha256,provider_dataset_ciphertext,provider_dataset_fingerprint FROM app.service_template_versions WHERE id=$1 FOR UPDATE`,[input.templateVersionId]);
        const t=template.rows[0],v=versions.rows[0];if(!t||!v||t.state==='retired'||v.published_at!==null)runDatabaseError('23514','TEMPLATE_PUBLICATION_CONFLICT');
        if(t.product_family==='scraper_library'){
          requireExecutableTemplate({productFamily:t.product_family,engine:v.engine,definition:v.execution_definition,definitionSha256:v.definition_sha256,datasetCiphertext:v.provider_dataset_ciphertext,datasetFingerprint:v.provider_dataset_fingerprint});
          const dataset=await protector.reveal(v.provider_dataset_ciphertext!,v.provider_dataset_fingerprint!,providerDatasetAad(v.id));
          if(!/^gd_[a-z0-9]{8,128}$/.test(dataset))runDatabaseError('23514','TEMPLATE_DATASET_BINDING_INVALID');
        }
        else {
          if(v.engine!==null||v.execution_definition!==null||v.definition_sha256!==null||v.provider_dataset_ciphertext!==null||v.provider_dataset_fingerprint!==null)runDatabaseError('23514','SAMPLE_ONLY_VERSION_NOT_EXECUTABLE');
          // New governed sample publication remains the explicit deferred command.
          runDatabaseError('23514','NEW_MARKETPLACE_SAMPLE_PUBLICATION_DEFERRED');
        }
        await db.query(`UPDATE app.service_template_versions SET published_at=clock_timestamp(),published_by=$1,evidence_ref=$2,availability_state='available' WHERE id=$3 AND published_at IS NULL`,[input.operatorUserId,input.evidenceReference,input.templateVersionId]);
        await db.query("UPDATE app.service_templates SET current_public_version_id=$1,state='published' WHERE id=$2",[input.templateVersionId,t.id]);
        await db.query(`INSERT INTO app.audit_events(actor_user_id,action,target_type,target_id,outcome,trace_id) VALUES($1,'template.publish','service_template_version',$2,'published',$3)`,[input.operatorUserId,input.templateVersionId,randomUUID()]);
      });
    },
  };
}
