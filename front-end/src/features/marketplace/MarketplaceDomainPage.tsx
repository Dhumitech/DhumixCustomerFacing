import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { cleanCustomerText } from "../workspace/customerText";
import { useMarketplaceCatalogueQuery } from "./marketplaceQueries";

interface MarketplaceDomainPageProps {
  readonly domainSlug?: string;
}

export function MarketplaceDomainPage({
  domainSlug: configuredDomainSlug,
}: MarketplaceDomainPageProps) {
  const { domainSlug: routeDomainSlug } = useParams();
  const domainSlug = configuredDomainSlug ?? routeDomainSlug ?? null;
  const catalogueQuery = useMarketplaceCatalogueQuery();
  const datasets = useMemo(
    () =>
      (catalogueQuery.data?.data ?? [])
        .filter((template) => template.presentation.domain_slug === domainSlug)
        .sort(
          (left, right) =>
            left.presentation.display_priority -
            right.presentation.display_priority,
        ),
    [catalogueQuery.data, domainSlug],
  );
  const firstDataset = datasets[0];

  if (catalogueQuery.isPending) {
    return (
      <div className="marketplace-state" role="status">
        Loading this dataset collection…
      </div>
    );
  }

  if (catalogueQuery.isError || !firstDataset) {
    return (
      <div className="marketplace-state marketplace-state--error" role="alert">
        <strong>This dataset collection is unavailable.</strong>
        <p>Return to the Dataset Marketplace and choose another collection.</p>
        <Link to="/workspace/marketplace">Back to marketplace</Link>
      </div>
    );
  }

  const domainName = cleanCustomerText(firstDataset.presentation.domain_name);

  return (
    <section className="marketplace-domain" aria-labelledby="domain-title">
      <Link className="sample-back" to="/workspace/marketplace">
        ← Dataset Marketplace
      </Link>

      <header className="marketplace-domain__header">
        <span className="marketplace-card__brand" aria-hidden="true">
          in
        </span>
        <div>
          <p className="workspace-eyebrow">Professional network data</p>
          <h2 id="domain-title">{domainName}</h2>
          <p>
            Choose a reviewed {domainName} dataset, inspect its governed sample,
            and shape the fields you need before requesting full access.
          </p>
        </div>
        <span className="marketplace-domain__count">
          {datasets.length} {datasets.length === 1 ? "dataset" : "datasets"}
        </span>
      </header>

      <div className="marketplace-domain__intro">
        <div>
          <span>01</span>
          <strong>Choose a dataset</strong>
          <small>Posts and People remain separate reviewed products.</small>
        </div>
        <div>
          <span>02</span>
          <strong>Inspect the sample</strong>
          <small>Filter and configure stored data without provider work.</small>
        </div>
        <div>
          <span>03</span>
          <strong>Request access</strong>
          <small>Purchase remains closed until checkout is available.</small>
        </div>
      </div>

      <div className="marketplace-offer-grid">
        {datasets.map((template, index) => {
          const marketplace = template.marketplace;
          return (
            <Link
              className="marketplace-offer-card"
              key={template.slug}
              to={`/workspace/marketplace/${template.slug}`}
            >
              <span
                className="marketplace-offer-card__number"
                aria-hidden="true"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="marketplace-card__eyebrow">
                {cleanCustomerText(template.presentation.operation_name)}
              </span>
              <h3>{cleanCustomerText(template.name)}</h3>
              <p>{cleanCustomerText(template.description)}</p>
              <span className="marketplace-offer-card__facts">
                <span>{marketplace?.fields.length ?? 0} reviewed fields</span>
                <span>{marketplace?.sample.record_count ?? 0} sample rows</span>
                <span>{cleanCustomerText(template.availability)}</span>
              </span>
              <strong className="marketplace-offer-card__action">
                View data sample <span aria-hidden="true">→</span>
              </strong>
            </Link>
          );
        })}
      </div>

      <p className="marketplace-boundary-note">
        These are Dhumi-governed stored samples. Browsing them does not create a
        purchase, provider request, or billable export.
      </p>
    </section>
  );
}
