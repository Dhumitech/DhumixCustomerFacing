import { Link } from "react-router";
import type { MarketplaceMetadata, ServiceTemplate } from "../../api/generated";
import {
  formatMarketplaceCount,
  formatMarketplaceDate,
  marketplaceFieldLabel,
} from "./marketplaceViewModel";

export type MarketplaceDatasetTab =
  | "sample"
  | "description"
  | "use-cases"
  | "statistics"
  | "dictionary"
  | "related";

export const MARKETPLACE_DATASET_TABS: ReadonlyArray<{
  readonly id: MarketplaceDatasetTab;
  readonly label: string;
}> = [
  { id: "sample", label: "Data sample" },
  { id: "description", label: "Description" },
  { id: "use-cases", label: "Use cases" },
  { id: "statistics", label: "Statistics" },
  { id: "dictionary", label: "Dictionary" },
  { id: "related", label: "Related" },
];

interface MarketplaceDatasetInformationProps {
  readonly tab: Exclude<MarketplaceDatasetTab, "sample">;
  readonly template: ServiceTemplate;
  readonly marketplace: MarketplaceMetadata;
}

export function MarketplaceDatasetInformation({
  tab,
  template,
  marketplace,
}: MarketplaceDatasetInformationProps) {
  if (tab === "description") {
    return (
      <section
        className="dataset-information"
        aria-labelledby="description-title"
      >
        <p className="workspace-eyebrow">Reviewed product description</p>
        <h3 id="description-title">About {template.name}</h3>
        <p className="dataset-information__lead">{template.description}</p>
        <div className="dataset-information__note">
          The sample on this page is an immutable, governed Dhumi preview. Its
          masking and retention rules are separate from any future purchased
          dataset.
        </div>
      </section>
    );
  }

  if (tab === "use-cases") {
    return (
      <section
        className="dataset-information"
        aria-labelledby="use-cases-title"
      >
        <p className="workspace-eyebrow">Pre-purchase evaluation</p>
        <h3 id="use-cases-title">What this preview helps you evaluate</h3>
        <div className="dataset-use-case-grid">
          <article>
            <span>01</span>
            <strong>Schema fit</strong>
            <p>
              Review the approved field dictionary before requesting access.
            </p>
          </article>
          <article>
            <span>02</span>
            <strong>Sample relevance</strong>
            <p>Test bounded filters against the stored sample only.</p>
          </article>
          <article>
            <span>03</span>
            <strong>Export shape</strong>
            <p>Choose and order the fields needed by your workflow.</p>
          </article>
        </div>
        <p className="dataset-information__footnote">
          No provider use-case claims are added here; these are Dhumi preview
          capabilities supported by the current API.
        </p>
      </section>
    );
  }

  if (tab === "statistics") {
    return (
      <section
        className="dataset-information"
        aria-labelledby="statistics-title"
      >
        <p className="workspace-eyebrow">Governed metadata</p>
        <h3 id="statistics-title">Dataset and sample statistics</h3>
        <dl className="dataset-statistics-grid">
          <div>
            <dt>Dataset records</dt>
            <dd>{formatMarketplaceCount(marketplace.record_count)}</dd>
            <small>
              As of {formatMarketplaceDate(marketplace.record_count_as_of)}
            </small>
          </div>
          <div>
            <dt>Reviewed fields</dt>
            <dd>{marketplace.fields.length}</dd>
            <small>From the immutable template dictionary</small>
          </div>
          <div>
            <dt>Stored sample</dt>
            <dd>{marketplace.sample.record_count}</dd>
            <small>Version {marketplace.sample.version}</small>
          </div>
          <div>
            <dt>Sample collected</dt>
            <dd>{formatMarketplaceDate(marketplace.sample.collected_at)}</dd>
            <small>
              Expires {formatMarketplaceDate(marketplace.sample.expires_at)}
            </small>
          </div>
        </dl>
      </section>
    );
  }

  if (tab === "dictionary") {
    return (
      <section
        className="dataset-information"
        aria-labelledby="dictionary-title"
      >
        <p className="workspace-eyebrow">Immutable field contract</p>
        <h3 id="dictionary-title">Data dictionary</h3>
        <p className="dataset-information__lead">
          Visibility and supported sample operators come directly from the
          reviewed Marketplace template.
        </p>
        <div className="dataset-dictionary-scroll">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Preview</th>
                <th>Required</th>
                <th>Sample operators</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {marketplace.fields.map((field) => (
                <tr key={field.name}>
                  <td className="dataset-dictionary-cell">
                    <strong>{marketplaceFieldLabel(field.name)}</strong>
                    <code>{field.name}</code>
                  </td>
                  <td className="dataset-dictionary-cell">{field.type}</td>
                  <td className="dataset-dictionary-cell">
                    {field.sample_visibility}
                  </td>
                  <td className="dataset-dictionary-cell">
                    {field.required ? "Yes" : "No"}
                  </td>
                  <td className="dataset-dictionary-cell">
                    {field.allowed_operators.length > 0
                      ? field.allowed_operators.join(", ")
                      : "Not filterable"}
                  </td>
                  <td className="dataset-dictionary-cell">
                    {field.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section className="dataset-information" aria-labelledby="related-title">
      <p className="workspace-eyebrow">More from this collection</p>
      <h3 id="related-title">Related LinkedIn datasets</h3>
      <Link
        className="dataset-related-card"
        to={`/workspace/marketplace/groups/${template.presentation.domain_slug}`}
      >
        <span className="marketplace-card__brand" aria-hidden="true">
          in
        </span>
        <span>
          <strong>Browse the LinkedIn collection</strong>
          <small>Compare separately reviewed Posts and People datasets.</small>
        </span>
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
