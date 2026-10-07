import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalProviderReferenceProtector } from "../../src/services/brightdata/providerReferenceProtector.js";
import { providerMappingAad } from "../../src/services/brightdata/providerExecutionPlanRepository.js";
import { reencryptProviderDataset, reencryptProviderDatasets, templateDatasetAad, ProviderDatasetMigrationError } from "../../src/services/brightdata/providerDatasetMigration.js";

const mapping = "11111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const otherVersion = "33333333-3333-4333-8333-333333333333";
const dataset = "gd_synthetic012345";
function protector() { return createLocalProviderReferenceProtector("test", randomBytes(32).toString("base64url")); }

describe("dataset AAD migration between 0072 and 0073", () => {
  it("decrypts the source, re-encrypts under the template version and verifies it without returning plaintext", async () => {
    const crypto = protector(), source = await crypto.protect(dataset, providerMappingAad(mapping));
    const target = await reencryptProviderDataset({ protector: crypto, templateVersionId: version, sourceAadMappingId: mapping, ...source });
    expect(Object.keys(target).sort()).toEqual(["ciphertext", "fingerprint"]);
    expect(target.ciphertext).not.toEqual(source.ciphertext); expect(target.fingerprint).not.toEqual(source.fingerprint);
    expect(target.ciphertext.toString()).not.toContain(dataset);
    await expect(crypto.reveal(target.ciphertext, target.fingerprint, templateDatasetAad(version))).resolves.toBe(dataset);
    await expect(crypto.reveal(target.ciphertext, target.fingerprint, providerMappingAad(mapping))).rejects.toThrow();
    await expect(crypto.reveal(target.ciphertext, target.fingerprint, templateDatasetAad(otherVersion))).rejects.toThrow();
    await expect(crypto.reveal(source.ciphertext, source.fingerprint, providerMappingAad(mapping))).resolves.toBe(dataset);
  });
  it("validates and retains an already migrated pair on restart", async () => {
    const crypto = protector(), source = await crypto.protect(dataset, providerMappingAad(mapping));
    const target = await reencryptProviderDataset({ protector: crypto, templateVersionId: version, sourceAadMappingId: mapping, ...source });
    await expect(reencryptProviderDataset({ protector: crypto, templateVersionId: version, sourceAadMappingId: mapping, ...source, existingTarget: target })).resolves.toEqual(target);
  });
  it("refuses changed target data, wrong source context, malformed IDs and wrong keys with a safe error", async () => {
    const crypto = protector(), source = await crypto.protect(dataset, providerMappingAad(mapping));
    const wrong = await crypto.protect("gd_other01234567", templateDatasetAad(version));
    for (const change of [{ existingTarget: wrong }, { sourceAadMappingId: otherVersion }, { templateVersionId: "not-a-uuid" }, { protector: protector() }, { fingerprint: Buffer.alloc(32) }]) {
      const error = await reencryptProviderDataset({ protector: crypto, templateVersionId: version, sourceAadMappingId: mapping, ...source, ...change }).catch(error => error);
      expect(error).toBeInstanceOf(ProviderDatasetMigrationError); expect(error.message).not.toContain(dataset); expect(error.cause).toBeUndefined();
    }
  });
  it("refuses a snapshot identifier in place of a dataset", async () => {
    const crypto = protector(), source = await crypto.protect("sd_synthetic012345", providerMappingAad(mapping));
    await expect(reencryptProviderDataset({ protector: crypto, templateVersionId: version, sourceAadMappingId: mapping, ...source })).rejects.toBeInstanceOf(ProviderDatasetMigrationError);
  });
  it("verifies every row in a batch and refuses duplicate template bindings or a later corrupt row", async () => {
    const crypto = protector(), source = await crypto.protect(dataset, providerMappingAad(mapping));
    const rows = [{ templateVersionId: version, sourceAadMappingId: mapping, ...source }, { templateVersionId: otherVersion, sourceAadMappingId: mapping, ...source }];
    const result = await reencryptProviderDatasets({ protector: crypto, rows });
    expect(result).toHaveLength(2);
    for (const row of result) await expect(crypto.reveal(row.binding.ciphertext, row.binding.fingerprint, templateDatasetAad(row.templateVersionId))).resolves.toBe(dataset);
    await expect(reencryptProviderDatasets({ protector: crypto, rows: [rows[0]!, rows[0]!] })).rejects.toBeInstanceOf(ProviderDatasetMigrationError);
    await expect(reencryptProviderDatasets({ protector: crypto, rows: [rows[0]!, { ...rows[1]!, fingerprint: Buffer.alloc(32) }] })).rejects.toBeInstanceOf(ProviderDatasetMigrationError);
    await expect(reencryptProviderDatasets({ protector: crypto, rows: [] })).resolves.toEqual([]);
  });
});
