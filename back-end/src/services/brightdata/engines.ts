import {AMAZON_EXECUTOR_IDENTITIES} from './amazonExecutorIdentities.js';
import {SHARED_SCRAPER_ADAPTER_CODE,SHARED_SCRAPER_ADAPTER_VERSION,SHARED_SCRAPER_ARTIFACT_DIGEST} from '../scrapers/sharedScraperVersion.js';
/** Closed private engine metadata; hashes are verified against contracts/engine-identities.json. */
export const TEMPLATE_ENGINE_IDENTITIES=Object.freeze({
 'amazon.v1':Object.freeze({...AMAZON_EXECUTOR_IDENTITIES[1]!}),
 'scraper.v1':Object.freeze({code:SHARED_SCRAPER_ADAPTER_CODE,version:SHARED_SCRAPER_ADAPTER_VERSION,digest:SHARED_SCRAPER_ARTIFACT_DIGEST}),
});
