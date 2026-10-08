import { useLocation } from "react-router";
import { selectedOrganization } from "../../api/organizationScope";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MarketplaceExpertEnquiryInput,
  MarketplaceSampleDownloadInput,
  MarketplaceSampleQueryInput,
} from "../../api/generated";
import { marketplaceApi } from "../../api/marketplace";
import { useSession } from "../../session/useSession";

const MARKETPLACE_STALE_TIME_MS = 60_000;

export function useMarketplaceCatalogueQuery() {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: ["catalogue", "marketplace", identityEmail, organizationId],
    queryFn: () => marketplaceApi.list(organizationId),
    enabled: isAuthenticated,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceTemplateQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: [
      "catalogue",
      "marketplace",
      "template",
      identityEmail,
      organizationId,
      slug,
    ],
    queryFn: () => marketplaceApi.getTemplate(slug as string, organizationId),
    enabled: isAuthenticated && slug !== null,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceSampleQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  const organizationId = selectedOrganization(useLocation().pathname);
  return useQuery({
    queryKey: [
      "catalogue",
      "marketplace",
      "sample",
      identityEmail,
      organizationId,
      slug,
    ],
    queryFn: () =>
      marketplaceApi.getSample(slug as string, undefined, organizationId),
    enabled: isAuthenticated && slug !== null,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceSampleMutation(slug: string | null) {
  const organizationId = selectedOrganization(useLocation().pathname);
  return useMutation({
    mutationFn: (body: MarketplaceSampleQueryInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.querySample(slug, body, organizationId);
    },
  });
}

export function useMarketplaceSampleDownloadMutation(slug: string | null) {
  const organizationId = selectedOrganization(useLocation().pathname);
  return useMutation({
    mutationFn: (body: MarketplaceSampleDownloadInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.authorizeSampleDownload(slug, body, organizationId);
    },
  });
}

export function useMarketplaceExpertEnquiryMutation(slug: string | null) {
  const organizationId = selectedOrganization(useLocation().pathname);
  return useMutation({
    mutationFn: (body: MarketplaceExpertEnquiryInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.createExpertEnquiry(slug, body, organizationId);
    },
  });
}
