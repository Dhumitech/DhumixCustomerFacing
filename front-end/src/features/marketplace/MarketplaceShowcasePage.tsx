import "./marketplace.css";

const collections = [
  {
    slug: "linkedin-people",
    name: "LinkedIn People",
    category: "Professional profiles",
    description:
      "Explore professional profiles, roles and company information in one dataset.",
  },
  {
    slug: "linkedin-posts",
    name: "LinkedIn Posts",
    category: "Content and engagement",
    description:
      "Explore professional posts and engagement data for content research.",
  },
] as const;

/** Demo catalogue only; retained sample workflows are deferred to a later release. */
export function MarketplaceShowcasePage() {
  return (
    <section
      className="marketplace-library marketplace-showcase"
      aria-labelledby="marketplace-title"
    >
      <header className="marketplace-hero">
        <div>
          <p className="workspace-eyebrow">A look at what’s next</p>
          <h2 id="marketplace-title">Dataset Marketplace</h2>
          <p>
            Discover the collections coming to Dhumi. Curated datasets will be
            available in a future update.
          </p>
        </div>
        <span className="marketplace-hero__index" aria-hidden="true">
          DM
        </span>
      </header>

      <div className="marketplace-card-grid">
        {collections.map((collection) => (
          <article
            className="marketplace-card marketplace-card--showcase"
            key={collection.slug}
            aria-labelledby={`showcase-${collection.slug}`}
          >
            <span className="marketplace-card__brand" aria-hidden="true">
              in
            </span>
            <div className="marketplace-card__content">
              <span className="marketplace-card__eyebrow">
                {collection.category}
              </span>
              <h3 id={`showcase-${collection.slug}`}>{collection.name}</h3>
              <p>{collection.description}</p>
              <span className="marketplace-showcase__badge">Coming soon</span>
            </div>
          </article>
        ))}
      </div>

      <p className="marketplace-boundary-note">
        Dataset previews, downloads and access requests will open in a future
        update.
      </p>
    </section>
  );
}
