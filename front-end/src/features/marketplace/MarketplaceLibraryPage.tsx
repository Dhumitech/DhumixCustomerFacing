import { organizationPath } from "../../api/organizationScope";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { cleanCustomerText } from "../workspace/customerText";
import { useMarketplaceCatalogueQuery } from "./marketplaceQueries";
import "./marketplace.css";

interface MarketplaceDomainGroup {
  readonly slug: string;
  readonly name: string;
  readonly category: string;
  readonly iconKey: string;
  readonly templates: NonNullable<
    ReturnType<typeof useMarketplaceCatalogueQuery>["data"]
  >["data"];
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function MarketplaceLibraryPage() {
  const [query, setQuery] = useState("");
  const catalogueQuery = useMarketplaceCatalogueQuery();
  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const byDomain = new Map<string, MarketplaceDomainGroup>();
    for (const template of catalogueQuery.data?.data ?? []) {
      const presentation = template.presentation;
      const existing = byDomain.get(presentation.domain_slug);
      if (existing) {
        existing.templates.push(template);
      } else {
        byDomain.set(presentation.domain_slug, {
          slug: presentation.domain_slug,
          name: presentation.domain_name,
          category: presentation.category,
          iconKey: presentation.icon_key,
          templates: [template],
        });
      }
    }
    return [...byDomain.values()]
      .filter((group) => {
        const searchable = [
          group.name,
          group.category,
          ...group.templates.flatMap((template) => [
            template.name,
            template.description,
            template.presentation.operation_name,
          ]),
        ]
          .join(" ")
          .toLocaleLowerCase();
        return (
          normalizedQuery.length === 0 || searchable.includes(normalizedQuery)
        );
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [catalogueQuery.data, query]);

  return (
    <section
      className="marketplace-library"
      aria-labelledby="marketplace-title"
    >
      <header className="marketplace-hero">
        <div>
          <p className="workspace-eyebrow">Governed sample data</p>
          <h2 id="marketplace-title">Dataset Marketplace</h2>
          <p>
            Explore approved sample records before deciding whether a full
            dataset belongs in your workflow.
          </p>
        </div>
        <span className="marketplace-hero__index" aria-hidden="true">
          DM
        </span>
      </header>

      <div className="marketplace-search">
        <SearchIcon />
        <label className="visually-hidden" htmlFor="marketplace-search">
          Search datasets
        </label>
        <input
          id="marketplace-search"
          type="search"
          value={query}
          placeholder="Search datasets, for example LinkedIn"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <span>
          {groups.length} {groups.length === 1 ? "collection" : "collections"}
        </span>
      </div>

      {catalogueQuery.isPending && (
        <div className="marketplace-state" role="status">
          <strong>Loading the governed dataset catalogue…</strong>
        </div>
      )}

      {catalogueQuery.isError && (
        <div
          className="marketplace-state marketplace-state--error"
          role="alert"
        >
          <strong>The Dataset Marketplace could not be loaded.</strong>
          <p>Check the backend connection and try again.</p>
        </div>
      )}

      {catalogueQuery.isSuccess && groups.length === 0 && (
        <div className="marketplace-state" role="status">
          <strong>No governed samples match this search.</strong>
          <p>Try a different dataset name.</p>
        </div>
      )}

      <div className="marketplace-card-grid">
        {groups.map((group) => {
          const reviewedFields = group.templates.reduce(
            (total, template) =>
              total + (template.marketplace?.fields.length ?? 0),
            0,
          );
          const availablePreviews = group.templates.filter(
            (template) => template.marketplace?.sample.state === "available",
          ).length;
          return (
            <Link
              className="marketplace-card"
              key={group.slug}
              to={organizationPath(`/workspace/marketplace/groups/${group.slug}`)}
            >
              <span className="marketplace-card__brand" aria-hidden="true">
                in
              </span>
              <span className="marketplace-card__content">
                <span className="marketplace-card__eyebrow">
                  {cleanCustomerText(group.category)}
                </span>
                <strong>{cleanCustomerText(group.name)}</strong>
                <span>
                  Explore separately reviewed Posts and People datasets from one
                  professional-network collection.
                </span>
                <span className="marketplace-card__facts">
                  <span>{group.templates.length} datasets</span>
                  <span>{availablePreviews} stored previews</span>
                  <span>{reviewedFields} reviewed fields</span>
                </span>
              </span>
              <span className="marketplace-card__arrow" aria-hidden="true">
                →
              </span>
            </Link>
          );
        })}
      </div>

      <p className="marketplace-boundary-note">
        Samples shown here are stored and governed by Dhumi. Previewing or
        filtering them does not request a full dataset.
      </p>
    </section>
  );
}
