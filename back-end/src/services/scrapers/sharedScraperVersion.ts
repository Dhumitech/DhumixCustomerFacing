/** New code identity; legacy Amazon/Marketplace release digests remain unchanged. */
export const SHARED_SCRAPER_ADAPTER_CODE = "bright_data.scraper_library.shared";
// Drafts stay pinned to the immutable, disabled qualification version in 0066.
// Every qualified retailer using this protocol shares one release identity.
export const SHARED_SCRAPER_DRAFT_ADAPTER_VERSION = "1.0.0-shared-scraper-processing";
export const SHARED_SCRAPER_ADAPTER_VERSION = "1.3.0-organization-naming";
// Pure identity metadata. No credential/provider dependency is exposed to admission.
// SHA-256 over the ordered LF-normalized source list in the migration test.
export const SHARED_SCRAPER_DRAFT_ARTIFACT_DIGEST = "007f1a56c59ec83ff8d6c4e359cc7b6121edf4a6c9d93ad7565d86b178bbca7f";
export const SHARED_SCRAPER_ARTIFACT_DIGEST = "f999a4908fd9b7345cdf939f74a61177e32d37faeb46611e20ada4b0e6ee1e74";

/** Immutable historical SQL identity; never a binding for changed source. */
export const SHARED_SCRAPER_LEGACY_RELEASE_ARTIFACT_DIGEST = "94cc1cb6132f65b60101964647087d967dbd57dae7c3a51610b184151928846a";
