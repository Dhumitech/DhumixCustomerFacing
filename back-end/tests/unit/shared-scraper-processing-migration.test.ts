import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHARED_SCRAPER_ARTIFACT_DIGEST, SHARED_SCRAPER_DRAFT_ARTIFACT_DIGEST,SHARED_SCRAPER_LEGACY_RELEASE_ARTIFACT_DIGEST } from "../../src/services/scrapers/sharedScraperVersion.js";

const root = new URL("../../", import.meta.url);
const migration = readFileSync(new URL("scripts/migrations/0066_shared_scraper_processing.sql", root), "utf8");
const releaseMigration = readFileSync(new URL("scripts/migrations/0068_shared_scraper_release_identity.sql", root), "utf8");
const capacityMigration = readFileSync(new URL("scripts/migrations/0069_shared_scraper_commercial_capacity.sql", root), "utf8");

describe("shared scraper protocol migration", () => {
  it("pins the reviewed processing/lifecycle/boundary/reader bytes, independent of retailer definitions", () => {
    expect(migration.split(SHARED_SCRAPER_DRAFT_ARTIFACT_DIGEST)).toHaveLength(4);
    // Historical migrations retain their original identities. Changed source is bound only to the new recorded release.
    const manifest=JSON.parse(readFileSync(new URL('contracts/engine-identities.json',root),'utf8')) as {scraper:{digest:string;sources:{path:string;lfSha256:string}[]}};
    const releaseHash = createHash("sha256");
    for (const source of manifest.scraper.sources){const content=readFileSync(new URL(source.path,root),'utf8').replace(/\r\n/g,'\n');
      expect(createHash('sha256').update(content).digest('hex')).toBe(source.lfSha256);releaseHash.update(content);}
    expect(releaseHash.digest("hex")).toBe(SHARED_SCRAPER_ARTIFACT_DIGEST);
    expect(manifest.scraper.digest).toBe(SHARED_SCRAPER_ARTIFACT_DIGEST);
    expect(SHARED_SCRAPER_ARTIFACT_DIGEST).not.toBe(SHARED_SCRAPER_LEGACY_RELEASE_ARTIFACT_DIGEST);
    expect(releaseMigration.split(SHARED_SCRAPER_LEGACY_RELEASE_ARTIFACT_DIGEST)).toHaveLength(5);
    expect(capacityMigration).toContain(SHARED_SCRAPER_LEGACY_RELEASE_ARTIFACT_DIGEST);
    expect(releaseMigration).toContain("commercial_evidence.evidence_hash = sha256");
  });
  it("adds no retailer tables, runtime credentials, publication or work", () => {
    expect(migration).not.toMatch(/CREATE TABLE|CREATE ROLE|INSERT INTO app\.(service_templates|service_template_versions|provider_mappings|services|runs|outbox_events)/i);
    expect(migration).toContain("'disabled'");
    expect(migration).not.toMatch(/PENDING_|\bAmazon\b|linkedin|target\.products|lowes\.products/);
    expect(releaseMigration).not.toMatch(/INSERT INTO app\.(service_templates|service_template_versions|provider_mappings|services|runs|outbox_events)/i);
    expect(capacityMigration).toContain("SHARED_SCRAPER_COMMERCIAL_POLICY_UNAVAILABLE");
    expect(capacityMigration).toContain("request_rules->>'limitPerInput'");
    expect(capacityMigration).toContain("policy ?& ARRAY");
  });
  it("uses least-privilege SECURITY DEFINER readers, pinned lineage, Tenant, live lease and fence", () => {
    expect(migration.match(/LANGUAGE plpgsql SECURITY DEFINER/g)).toHaveLength(3);
    expect(migration.match(/SET search_path = pg_catalog, app, pg_temp/g)).toHaveLength(3);
    expect(migration).toContain("app.require_tenant_context()");
    expect(migration).toContain("attempt.fence_token = p_fence_token");
    expect(migration).toContain("attempt.worker_lease_expires_at > clock_timestamp()");
    expect(migration).toContain("aad_mapping.id = mapping.provider_resource_aad_mapping_id");
    expect(migration).toContain("CASE WHEN p_phase = 'normalization' THEN NULL ELSE credential.vault_secret_reference END");
    expect(migration).not.toMatch(/GRANT SELECT ON app\.provider_credentials/);
  });
});
