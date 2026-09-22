import type { ProductFamily, ProductStatus } from "../../api/generated";
import { usePlatformStatusQuery } from "./statusQueries";
import "./platformStatus.css";

function stateLabel(state: ProductStatus["state"] | "checking"): string {
  if (state === "not_enabled") return "Not enabled";
  return `${state.slice(0, 1).toLocaleUpperCase()}${state.slice(1)}`;
}

interface PlatformStatusNoticeProps {
  readonly family?: ProductFamily;
}

export function PlatformStatusNotice({
  family = "scraper_library",
}: PlatformStatusNoticeProps) {
  const statusQuery = usePlatformStatusQuery();

  if (statusQuery.isPending) {
    return (
      <div className="platform-status platform-status--checking" role="status">
        <span aria-hidden="true" />
        Checking services
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div className="platform-status platform-status--unknown" role="status">
        <span aria-hidden="true" />
        Status unavailable
      </div>
    );
  }

  const productStatus = statusQuery.data.products.find(
    (product) => product.family === family,
  );
  const state = productStatus?.state ?? "unknown";
  const productLabel =
    family === "marketplace_dataset" ? "Marketplace" : "Scrapers";

  return (
    <div
      className={`platform-status platform-status--${state}`}
      role="status"
      title={productStatus?.message ?? undefined}
    >
      <span aria-hidden="true" />
      {productLabel} {stateLabel(state)}
    </div>
  );
}
