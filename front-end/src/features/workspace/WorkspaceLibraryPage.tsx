import { organizationPath } from "../../api/organizationScope";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { ServiceTemplate } from "../../api/generated";
import { cleanCustomerText } from "./customerText";
import { useScraperLibraryQuery } from "./workspaceQueries";
import "./workspaceLibrary.css";

interface DomainCardModel {
  readonly slug: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly iconKey: string;
  readonly operationCount: number;
  readonly displayPriority: number;
}

const HIDDEN_CUSTOMER_TEMPLATE_SLUGS = new Set(["pattern4-controlled-local"]);

function displayLabel(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function toDomainCards(
  templates: readonly ServiceTemplate[],
): DomainCardModel[] {
  const groups = new Map<string, ServiceTemplate[]>();
  for (const template of templates) {
    if (HIDDEN_CUSTOMER_TEMPLATE_SLUGS.has(template.slug)) continue;
    const current = groups.get(template.presentation.domain_slug) ?? [];
    current.push(template);
    groups.set(template.presentation.domain_slug, current);
  }

  return [...groups.entries()]
    .map(([slug, operations]) => {
      const sorted = [...operations].sort(
        (left, right) =>
          left.presentation.display_priority -
          right.presentation.display_priority,
      );
      const first = sorted[0];
      return {
        slug,
        name: cleanCustomerText(first.presentation.domain_name),
        category: first.presentation.category,
        description: cleanCustomerText(first.description),
        iconKey: first.presentation.icon_key,
        operationCount: operations.length,
        displayPriority: first.presentation.display_priority,
      };
    })
    .sort((left, right) => left.displayPriority - right.displayPriority);
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}

export function WorkspaceLibraryPage() {
  const [activeCategory, setActiveCategory] = useState("all");
  const [query, setQuery] = useState("");
  const catalogueQuery = useScraperLibraryQuery();

  const domainCards = useMemo(
    () => toDomainCards(catalogueQuery.data?.data ?? []),
    [catalogueQuery.data],
  );
  const categories = useMemo(
    () => [...new Set(domainCards.map((domain) => domain.category))].sort(),
    [domainCards],
  );
  const visibleDomains = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return domainCards.filter((domain) => {
      const categoryMatches =
        activeCategory === "all" || activeCategory === domain.category;
      const queryMatches =
        normalizedQuery.length === 0 ||
        domain.name.toLocaleLowerCase().includes(normalizedQuery) ||
        domain.description.toLocaleLowerCase().includes(normalizedQuery);
      return categoryMatches && queryMatches;
    });
  }, [activeCategory, domainCards, query]);

  const visibleCategoryGroups = useMemo(() => {
    const groups = new Map<string, DomainCardModel[]>();
    for (const domain of visibleDomains) {
      const current = groups.get(domain.category) ?? [];
      current.push(domain);
      groups.set(domain.category, current);
    }
    return [...groups.entries()];
  }, [visibleDomains]);

  return (
    <section className="scraper-library" aria-labelledby="library-title">
      <div className="scraper-library__intro">
        <p className="workspace-eyebrow">Ready-to-use collections</p>
        <h2 id="library-title">Scrapers Library</h2>
        <p>
          Choose a target, add the pages you need, and keep every collection
          organized inside your workspace.
        </p>
      </div>

      <div className="library-search">
        <SearchIcon />
        <label className="visually-hidden" htmlFor="scraper-search">
          Search scrapers
        </label>
        <input
          id="scraper-search"
          type="search"
          value={query}
          placeholder="Search scrapers"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <span>{domainCards.length} available</span>
      </div>

      <fieldset className="library-categories">
        <legend className="visually-hidden">Scraper categories</legend>
        <button
          className={activeCategory === "all" ? "is-active" : undefined}
          type="button"
          aria-pressed={activeCategory === "all"}
          onClick={() => setActiveCategory("all")}
        >
          All scrapers
        </button>
        {categories.map((category) => (
          <button
            className={category === activeCategory ? "is-active" : undefined}
            type="button"
            key={category}
            aria-pressed={category === activeCategory}
            onClick={() => setActiveCategory(category)}
          >
            {displayLabel(category)}
          </button>
        ))}
      </fieldset>

      {catalogueQuery.isPending && (
        <div className="library-empty" role="status">
          <span>··</span>
          <strong>Loading your scraper library…</strong>
        </div>
      )}

      {catalogueQuery.isError && (
        <div className="library-empty library-empty--error" role="alert">
          <span>!</span>
          <strong>The scraper library could not be loaded.</strong>
          <p>Check the backend connection and try again.</p>
        </div>
      )}

      {catalogueQuery.isSuccess && visibleCategoryGroups.length === 0 && (
        <div className="library-empty" role="status">
          <span>00</span>
          <strong>No scrapers match this search.</strong>
          <p>Try another name or return to all scrapers.</p>
        </div>
      )}

      {visibleCategoryGroups.map(([category, domains], categoryIndex) => (
        <div className="library-domain-section" key={category}>
          <div className="library-section-heading">
            <div>
              <span>{String(categoryIndex + 1).padStart(2, "0")}</span>
              <h3>{displayLabel(category)}</h3>
            </div>
            <p>
              {domains.length} ready-to-use{" "}
              {domains.length === 1 ? "domain" : "domains"}
            </p>
          </div>

          <div className="domain-grid">
            {domains.map((domain) => (
              <Link
                className="domain-card"
                key={domain.slug}
                to={organizationPath(`/workspace/scrapers/${domain.slug}`)}
                aria-label={`${domain.name}: ${domain.description}`}
              >
                <span className="domain-card__topline">
                  <span className="amazon-mark" aria-hidden="true">
                    {domain.iconKey === "amazon"
                      ? "a"
                      : domain.name.slice(0, 1).toLocaleLowerCase()}
                  </span>
                  <span className="domain-card__title">{domain.name}</span>
                  <span className="domain-card__arrow">
                    <ArrowIcon />
                  </span>
                </span>
                <span className="domain-card__description">
                  {domain.description}
                </span>
                <span className="domain-card__metadata">
                  <span>{displayLabel(domain.category)}</span>
                  <span>
                    {domain.operationCount} published{" "}
                    {domain.operationCount === 1 ? "operation" : "operations"}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}

      {catalogueQuery.data?.page.has_more && (
        <p className="library-page-note" role="status">
          More published scrapers are available on the next catalogue page.
        </p>
      )}
    </section>
  );
}
