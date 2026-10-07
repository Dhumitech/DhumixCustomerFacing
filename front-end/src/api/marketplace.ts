import { guardOrganizationAction, organizationHeaders } from "./organizationScope";
import { tokenStore } from "../session/tokenStore";
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

function currentCsrfToken(): string {
  const session = tokenStore.getSnapshot();
  if (session === null)
    throw new Error("An authenticated browser session is required.");
  return session.csrf_token;
}

export const marketplaceApi = Object.freeze({
  async list(): Promise<TemplatePage> {
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedListTemplates({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetTemplate({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedGetMarketplaceSample({
        client: dhumiClient, headers: scope,
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
    const scope = organizationHeaders();
    const response = await asDhumiRequest(
      generatedQueryMarketplaceSample({
        client: dhumiClient,
        headers: { ...scope, "X-CSRF-Token": currentCsrfToken() },
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
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
    const lease = await acquireMutationIdempotency(
      "marketplace.sample-download",
      { slug, body },
    );
    const response = await asDhumiRequest(
      generatedAuthorizeMarketplaceSampleDownload({
        client: dhumiClient,
        path: { slug },
        body,
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
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
    const scope = organizationHeaders();
    guardOrganizationAction(scope);
    const lease = await acquireMutationIdempotency(
      "marketplace.expert-enquiry",
      { slug, body },
    );
    const response = await asDhumiRequest(
      generatedCreateMarketplaceExpertEnquiry({
        client: dhumiClient,
        path: { slug },
        body,
        headers: { ...scope,
          "Idempotency-Key": lease.headerValue,
          "X-CSRF-Token": currentCsrfToken(),
        },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },
});
