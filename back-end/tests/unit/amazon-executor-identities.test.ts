import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AMAZON_EXECUTOR_IDENTITIES } from "../../src/services/brightdata/amazonExecutorIdentities.js";

const migration = (name: string): string =>
  readFileSync(new URL(`../../scripts/migrations/${name}`, import.meta.url), "utf8");

const identity = (version: string) => {
  const match = AMAZON_EXECUTOR_IDENTITIES.find((candidate) => candidate.version === version);
  if (match === undefined) throw new Error(`Missing Amazon executor identity ${version}`);
  return match;
};

describe("Amazon versioned-dispatch compatibility identities", () => {
  it("covers every immutable Amazon adapter identity used before shared scraper opt-in", () => {
    expect(AMAZON_EXECUTOR_IDENTITIES).toEqual([
      {
        code: "bright_data.amazon.scraper_library",
        version: "1.0.0-pattern6",
        digest: "afd0a29edcc08fdae2d26e1b3c9ca2281869b184e550717e834592c969336a62",
      },
      {
        code: "bright_data.amazon.scraper_library",
        version: "1.1.0-pattern8-output-contracts",
        digest: "742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14",
      },
      {
        code: "bright_data.amazon.scraper_library",
        version: "1.1.0-pattern8-release",
        digest: "742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14",
      },
    ]);
  });

  it("stays aligned with the immutable migration evidence", () => {
    const pattern6 = migration("0032_amazon_operation_definitions.sql");
    const pattern8 = migration("0040_amazon_precise_output_contracts.sql");
    const release = migration("0041_amazon_controlled_publication.sql");
    const pattern6Identity = identity("1.0.0-pattern6");
    const pattern8Identity = identity("1.1.0-pattern8-output-contracts");

    expect(pattern6).toContain(`'1.0.0-pattern6'`);
    expect(pattern6).toContain(`decode('${pattern6Identity.digest}', 'hex')`);
    expect(pattern8).toContain(`'1.1.0-pattern8-output-contracts'`);
    expect(pattern8).toContain(`decode('${pattern8Identity.digest}', 'hex')`);
    expect(release).toContain(`'1.1.0-pattern8-release'`);
    expect(release).toContain("staged_adapter.code_artifact_digest");
  });
});
