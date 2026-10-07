import type { QueryResultRow } from 'pg';
import type { DatabaseExecutor } from '../../types/database.js';
/** Existing governed preview predicates, now issued by a TypeScript repository. */
export const marketplacePreviewSource = `(SELECT
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
    FROM app.marketplace_samples AS stored
    WHERE stored.template_version_id = version.id
      AND stored.collected_at <= statement_timestamp()
      AND stored.expires_at > statement_timestamp()
      AND stored.deleted_at IS NULL
      AND (
        (
          template.slug = 'linkedin-posts'
          AND stored.retention_policy_version = 'linkedin-posts-sample-30d-v1'
          AND (
            (
              stored.source_kind = 'provider_qualification'
              AND stored.state = 'validated_provider_sample'
              AND stored.governance_state = 'formal_agreement_pending_local_demo'
              AND (stored.evidence_ref::jsonb->>'decision') =
                'decision://product-owner/2026-09-13/linkedin-posts-real-sample-local-demo-formal-agreement-pending'
              AND ((stored.evidence_ref::jsonb->>'qualification_packet_id')::uuid) =
                '2e1560c3-ca8b-40a0-b578-c9e71ecf27cd'::uuid
              AND stored.published_at IS NOT NULL
            )
            OR
            (
              stored.source_kind = 'synthetic_fixture'
              AND stored.state = 'validated_fixture'
              AND stored.governance_state = 'synthetic_fixture'
              AND ((stored.evidence_ref::jsonb->>'qualification_packet_id')::uuid) IS NULL
              AND (stored.evidence_ref::jsonb->>'rights') IS NULL
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
          AND ((stored.evidence_ref::jsonb->>'qualification_packet_id')::uuid) IS NULL
          AND (stored.evidence_ref::jsonb->>'rights') IS NULL
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
  WHERE statement_timestamp() IS NOT NULL
    AND true
    AND template.slug IN ('linkedin-posts', 'linkedin-people')
    AND template.product_family = 'marketplace_dataset'
    AND template.state = 'draft'
    AND template.current_public_version_id IS NULL
    AND version.version = 1
    AND version.availability_state = 'coming_soon'
    AND version.published_at IS NULL
    AND version.presentation_metadata ? 'provider_record_count'
  ORDER BY template.slug) AS preview(template_id,template_slug,template_version,public_name,public_description,presentation_metadata,configuration_schema,input_schema,provider_record_count,provider_record_count_as_of,sample_version,sample_record_count,sample_byte_count,sample_checksum_hex,sample_object_key,collected_at,expires_at,fields)`;
export interface MarketplaceManifestRow extends QueryResultRow {
 readonly template_id:string; readonly template_version_id:string; readonly sample_id:string;
 readonly template_slug:string; readonly template_version:number; readonly sample_version:number;
 readonly sample_record_count:number; readonly sample_byte_count:string|number; readonly sample_checksum_hex:string;
 readonly sample_object_key:string; readonly collected_at:Date; readonly expires_at:Date; readonly fields:unknown;
}
export async function queryMarketplacePreview(database:DatabaseExecutor,slug:string):Promise<MarketplaceManifestRow|undefined> {
 const result=await database.query<MarketplaceManifestRow>(`SELECT preview.*,version.id template_version_id,sample.id sample_id FROM ${marketplacePreviewSource}
 JOIN app.service_template_versions version ON version.service_template_id=preview.template_id AND version.version=preview.template_version
 JOIN app.marketplace_samples sample ON sample.template_version_id=version.id AND sample.sample_version=preview.sample_version AND sample.object_key=preview.sample_object_key
 WHERE preview.template_slug=$1`,[slug]);
 return result.rows[0];
}
