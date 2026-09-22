export type ProviderExecutorIdentity = Readonly<{
  code: string;
  version: string;
  digest: string;
}>;

/**
 * Immutable Amazon adapter identities already created by migrations 0032,
 * 0040 and 0041. The versioned dispatcher must retain these bindings when
 * the shared scraper pipeline is enabled so existing pinned Services keep
 * using their reviewed implementation.
 */
export const AMAZON_EXECUTOR_IDENTITIES = Object.freeze([
  Object.freeze({
    code: "bright_data.amazon.scraper_library",
    version: "1.0.0-pattern6",
    digest: "afd0a29edcc08fdae2d26e1b3c9ca2281869b184e550717e834592c969336a62",
  }),
  Object.freeze({
    code: "bright_data.amazon.scraper_library",
    version: "1.1.0-pattern8-output-contracts",
    digest: "742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14",
  }),
  Object.freeze({
    code: "bright_data.amazon.scraper_library",
    version: "1.1.0-pattern8-release",
    digest: "742d4035fcad32f5b78151d2dee0c8fbf2ca2b8bc0a42e1995a70ef6eca9cb14",
  }),
] satisfies readonly ProviderExecutorIdentity[]);
