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
  return useQuery({
    queryKey: ["catalogue", "marketplace", identityEmail],
    queryFn: marketplaceApi.list,
    enabled: isAuthenticated,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceTemplateQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["catalogue", "marketplace", "template", identityEmail, slug],
    queryFn: () => marketplaceApi.getTemplate(slug as string),
    enabled: isAuthenticated && slug !== null,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceSampleQuery(slug: string | null) {
  const { identityEmail, isAuthenticated } = useSession();
  return useQuery({
    queryKey: ["catalogue", "marketplace", "sample", identityEmail, slug],
    queryFn: () => marketplaceApi.getSample(slug as string),
    enabled: isAuthenticated && slug !== null,
    staleTime: MARKETPLACE_STALE_TIME_MS,
  });
}

export function useMarketplaceSampleMutation(slug: string | null) {
  return useMutation({
    mutationFn: (body: MarketplaceSampleQueryInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.querySample(slug, body);
    },
  });
}

export function useMarketplaceSampleDownloadMutation(slug: string | null) {
  return useMutation({
    mutationFn: (body: MarketplaceSampleDownloadInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.authorizeSampleDownload(slug, body);
    },
  });
}

export function useMarketplaceExpertEnquiryMutation(slug: string | null) {
  return useMutation({
    mutationFn: (body: MarketplaceExpertEnquiryInput) => {
      if (slug === null) {
        throw new TypeError("A Marketplace template is required");
      }
      return marketplaceApi.createExpertEnquiry(slug, body);
    },
  });
}
