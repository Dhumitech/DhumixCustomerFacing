export const SAMPLE_HOST = "northwind.example";

export const PLATFORMS = [
  { id: "amazon", name: "Amazon", needsStoreId: false },
  { id: "walmart", name: "Walmart", needsStoreId: false },
  { id: "target", name: "Target", needsStoreId: false },
  { id: "homedepot", name: "Home Depot", needsStoreId: false },
  { id: "bestbuy", name: "Best Buy", needsStoreId: true },
] as const;

export type PlatformId = (typeof PLATFORMS)[number]["id"];

export interface CatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly variant: string;
  readonly pdp: string;
  readonly identifier: string;
  readonly priceUsd: number | null;
  readonly hasCompetitors: boolean;
}

export interface AnalysisRow {
  readonly id: string;
  readonly productName: string;
  readonly competitor: string;
  readonly seller: string;
  readonly platformName: string;
  readonly customerPriceUsd: number | null;
  readonly competitorPriceUsd: number | null;
  readonly stock: string | null;
  readonly pdp: string;
  readonly coverage: string;
}

const CATALOG: readonly CatalogProduct[] = [
  {
    id: "trail",
    name: "Trail Runner",
    variant: "Size 10 / Blue",
    pdp: "https://northwind.example/products/trail-runner",
    identifier: "NW-TR-10",
    priceUsd: 120,
    hasCompetitors: true,
  },
  {
    id: "city",
    name: "City Sneaker",
    variant: "Size 9 / White",
    pdp: "https://northwind.example/products/city-sneaker",
    identifier: "NW-CS-09",
    priceUsd: null,
    hasCompetitors: true,
  },
  {
    id: "cleat",
    name: "Specialty Cleat",
    variant: "Size 11",
    pdp: "https://northwind.example/products/specialty-cleat",
    identifier: "NW-SC-11",
    priceUsd: 90,
    hasCompetitors: false,
  },
];

const PRIVATE_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)|\.local$|\.internal$/i;

export function validateWebsite(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a public http or https website.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Enter a public http or https website.";
  }
  if (url.username || url.password) {
    return "Remove credentials from the website address.";
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    return "Use a public store website, not a private or internal address.";
  }
  if (/\/(login|admin|signin|sign-in)(\/|$)/i.test(url.pathname)) {
    return "Use the store website, not a login or admin page.";
  }
  return null;
}

export function validateZip(value: string): string | null {
  if (!/^\d{5}(?:-\d{4})?$/.test(value)) {
    return "Enter a US ZIP or ZIP+4. Leading zeros are kept.";
  }
  return null;
}

export function validatePrompt(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Describe the products to compare.";
  }
  if (/\b0\s+products?\b/i.test(trimmed) || /no products/i.test(trimmed)) {
    return "A zero product count cannot start discovery.";
  }
  if (/one product/i.test(trimmed) && /five products/i.test(trimmed)) {
    return "The request names conflicting product counts. Clarify which count to use.";
  }
  return null;
}

export function isSampleStore(website: string): boolean {
  try {
    return new URL(website.trim()).hostname.toLowerCase() === SAMPLE_HOST;
  } catch {
    return false;
  }
}

export function discoverProducts(website: string): CatalogProduct[] {
  return isSampleStore(website) ? [...CATALOG] : [];
}

export function productFromManualPdp(pdp: string): CatalogProduct | null {
  if (validateWebsite(pdp)) {
    return null;
  }
  const url = new URL(pdp.trim());
  const slug =
    url.pathname.split("/").filter(Boolean).at(-1) ?? "manual-product";
  const name = slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    id: `manual-${slug}`,
    name: name || "Manual product",
    variant: "Customer-supplied PDP",
    pdp: url.toString(),
    identifier: "Manual",
    priceUsd: 100,
    hasCompetitors: url.hostname.toLowerCase() === SAMPLE_HOST,
  };
}

export function pricePosition(
  customerPriceUsd: number | null,
  competitorPriceUsd: number | null,
):
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "parity" | "gap";
      readonly absolute: number;
      readonly percent: number;
    } {
  if (customerPriceUsd === null || competitorPriceUsd === null) {
    return { kind: "unavailable" };
  }
  const absolute = competitorPriceUsd - customerPriceUsd;
  const percent = (absolute / customerPriceUsd) * 100;
  return {
    kind: Math.abs(percent) <= 5 ? "parity" : "gap",
    absolute,
    percent,
  };
}

export function buildRows(
  products: readonly CatalogProduct[],
  platformIds: readonly PlatformId[],
  includeOwnListings: boolean,
): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  for (const product of products) {
    if (includeOwnListings) {
      rows.push({
        id: `${product.id}-own`,
        productName: product.name,
        competitor: "Own listing",
        seller: "Your store",
        platformName: "Customer site",
        customerPriceUsd: product.priceUsd,
        competitorPriceUsd: product.priceUsd,
        stock: "In stock",
        pdp: product.pdp,
        coverage: "Own listing",
      });
    }
    if (!product.hasCompetitors) {
      continue;
    }
    platformIds.forEach((platformId, index) => {
      const platform = PLATFORMS.find((item) => item.id === platformId);
      if (!platform) {
        return;
      }
      const failed = platformId === "target";
      rows.push({
        id: `${product.id}-${platformId}`,
        productName: product.name,
        competitor: index === 0 ? "Summit Step" : "Ridge Footwear",
        seller: index === 0 ? "Northline Outfitters" : "Harbor Supply",
        platformName: platform.name,
        customerPriceUsd: product.priceUsd,
        competitorPriceUsd: failed
          ? null
          : (product.priceUsd ?? 110) + index * 8,
        stock: failed ? null : index === 0 ? "In stock" : "Low stock",
        pdp: `https://${platformId}.example/p/${product.id}`,
        coverage: failed
          ? "Lookup failed — unknown, not proof it is unsold"
          : "Verified PDP",
      });
    });
  }
  return rows;
}
