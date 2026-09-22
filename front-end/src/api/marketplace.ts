import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  authorizeMarketplaceSampleDownload as generatedAuthorizeMarketplaceSampleDownload,
  createMarketplaceExpertEnquiry as generatedCreateMarketplaceExpertEnquiry,
  getMarketplaceSample as generatedGetMarketplaceSample,
  getTemplate as generatedGetTemplate,
  listTemplates as generatedListTemplates,
  queryMarketplaceSample as generatedQueryMarketplaceSample,
  type MarketplaceExpertEnquiry,
  type MarketplaceExpertEnquiryInput,
  type MarketplaceSampleDownloadAuthorization,
  type MarketplaceSampleDownloadInput,
  type MarketplaceSampleQueryInput,
  type MarketplaceSampleQueryResult,
  type ServiceTemplate,
  type TemplatePage,
} from "./generated";
import {
  acquireMutationIdempotency,
  completeMutationIdempotency,
} from "./mutationIdempotency";

const MAX_CATALOGUE_PAGE_SIZE = 100;
const DEFAULT_SAMPLE_PAGE_SIZE = 30;

export const marketplaceApi = Object.freeze({
  async list(): Promise<TemplatePage> {
    const response = await asDhumiRequest(
      generatedListTemplates({
        client: dhumiClient,
        query: {
          family: "marketplace_dataset",
          limit: MAX_CATALOGUE_PAGE_SIZE,
        },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async getTemplate(slug: string): Promise<ServiceTemplate> {
    const response = await asDhumiRequest(
      generatedGetTemplate({
        client: dhumiClient,
        path: { slug },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async getSample(
    slug: string,
    cursor?: string,
  ): Promise<MarketplaceSampleQueryResult> {
    const response = await asDhumiRequest(
      generatedGetMarketplaceSample({
        client: dhumiClient,
        path: { slug },
        query: {
          limit: DEFAULT_SAMPLE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async querySample(
    slug: string,
    body: MarketplaceSampleQueryInput,
  ): Promise<MarketplaceSampleQueryResult> {
    const response = await asDhumiRequest(
      generatedQueryMarketplaceSample({
        client: dhumiClient,
        path: { slug },
        body,
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async authorizeSampleDownload(
    slug: string,
    body: MarketplaceSampleDownloadInput,
  ): Promise<MarketplaceSampleDownloadAuthorization> {
    const lease = await acquireMutationIdempotency(
      "marketplace.sample-download",
      { slug, body },
    );
    const response = await asDhumiRequest(
      generatedAuthorizeMarketplaceSampleDownload({
        client: dhumiClient,
        path: { slug },
        body,
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async createExpertEnquiry(
    slug: string,
    body: MarketplaceExpertEnquiryInput,
  ): Promise<MarketplaceExpertEnquiry> {
    const lease = await acquireMutationIdempotency(
      "marketplace.expert-enquiry",
      { slug, body },
    );
    const response = await asDhumiRequest(
      generatedCreateMarketplaceExpertEnquiry({
        client: dhumiClient,
        path: { slug },
        body,
        headers: { "Idempotency-Key": lease.headerValue },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },
});
