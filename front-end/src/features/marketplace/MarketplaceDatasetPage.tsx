import { organizationPath } from "../../api/organizationScope";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { DhumiApiError } from "../../api/errors";
import type {
  MarketplaceContactMode,
  MarketplaceFilterGroup,
  MarketplaceSampleDownloadAuthorization,
  MarketplaceSampleDownloadInput,
  MarketplaceSampleQueryInput,
  MarketplaceSampleQueryResult,
  MarketplaceSortItem,
} from "../../api/generated";
import { MarketplaceContactDrawer } from "./MarketplaceContactDrawer";
import {
  MARKETPLACE_DATASET_TABS,
  MarketplaceDatasetInformation,
  type MarketplaceDatasetTab,
} from "./MarketplaceDatasetInformation";
import { MarketplaceFieldDrawer } from "./MarketplaceFieldDrawer";
import {
  buildMarketplaceFilter,
  createMarketplaceFilterRule,
  MarketplaceFilterBuilder,
  type MarketplaceFilterRuleDraft,
} from "./MarketplaceFilterBuilder";
import {
  useMarketplaceExpertEnquiryMutation,
  useMarketplaceSampleDownloadMutation,
  useMarketplaceSampleMutation,
  useMarketplaceSampleQuery,
  useMarketplaceTemplateQuery,
} from "./marketplaceQueries";
import {
  defaultMarketplaceFields,
  marketplaceDisplayValue,
  marketplaceFieldLabel,
  marketplaceRowKey,
} from "./marketplaceViewModel";
import "./marketplace.css";

function errorMessage(error: unknown): string {
  if (error instanceof DhumiApiError) {
    if (error.status === 409) {
      return "This stored sample changed. Refresh the page before filtering again.";
    }
    return error.message;
  }
  return "The stored sample could not be updated.";
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof DhumiApiError) {
    if (error.status === 409) {
      return "This stored sample changed. Refresh the page before downloading.";
    }
    if (error.status === 429) {
      return "This workspace has reached its sample-download limit. Try again later.";
    }
    return error.message;
  }
  return "The sample download could not be prepared.";
}

function enquiryErrorMessage(error: unknown): string {
  if (error instanceof DhumiApiError) {
    if (error.status === 409) {
      return "This dataset preview changed. Refresh the page before contacting our data experts.";
    }
    return error.message;
  }
  return "Your request could not be sent. Check your connection and try again.";
}

function beginBrowserDownload(
  authorization: MarketplaceSampleDownloadAuthorization,
): void {
  const anchor = document.createElement("a");
  anchor.href = authorization.download_url;
  anchor.rel = "noopener";
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function activeFilterCount(
  filter: MarketplaceSampleQueryInput["filter"],
): number {
  if (!filter) return 0;
  return "filters" in filter ? filter.filters.length : 1;
}

type OpenControl = "filters" | "fields" | "contacts" | null;

interface QueryOptions {
  readonly cursor?: string;
  readonly append?: boolean;
  readonly nextSort?: MarketplaceSortItem[];
}

interface MarketplaceDatasetPageProps {
  readonly templateSlug?: string;
}

export function MarketplaceDatasetPage({
  templateSlug: configuredTemplateSlug,
}: MarketplaceDatasetPageProps) {
  const { templateSlug: routeTemplateSlug } = useParams();
  const slug = configuredTemplateSlug ?? routeTemplateSlug ?? null;
  const templateQuery = useMarketplaceTemplateQuery(slug);
  const sampleQuery = useMarketplaceSampleQuery(slug);
  const sampleMutation = useMarketplaceSampleMutation(slug);
  const sampleDownload = useMarketplaceSampleDownloadMutation(slug);
  const expertEnquiry = useMarketplaceExpertEnquiryMutation(slug);

  const [preview, setPreview] = useState<MarketplaceSampleQueryResult | null>(
    null,
  );
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [committedFields, setCommittedFields] = useState<string[]>([]);
  const [filterRules, setFilterRules] = useState<MarketplaceFilterRuleDraft[]>(
    [],
  );
  const [filterGroupOperator, setFilterGroupOperator] =
    useState<MarketplaceFilterGroup["operator"]>("and");
  const [sort, setSort] = useState<MarketplaceSortItem[]>([]);
  const [openControl, setOpenControl] = useState<OpenControl>(null);
  const [activeTab, setActiveTab] = useState<MarketplaceDatasetTab>("sample");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [activeQuery, setActiveQuery] =
    useState<MarketplaceSampleQueryInput | null>(null);
  const [downloadedFormat, setDownloadedFormat] = useState<
    "json" | "csv" | null
  >(null);
  const [selectedContactMode, setSelectedContactMode] = useState<
    MarketplaceContactMode["code"] | null
  >(null);
  const [appliedContactMode, setAppliedContactMode] = useState<
    MarketplaceContactMode["code"] | null
  >(null);
  const [initializedTemplateKey, setInitializedTemplateKey] = useState("");

  const marketplace = templateQuery.data?.marketplace;
  const contactModes = useMemo(
    () =>
      [...(marketplace?.contact_modes ?? [])].sort(
        (left, right) => left.display_order - right.display_order,
      ),
    [marketplace?.contact_modes],
  );
  const firstAvailableContactMode = contactModes.find(
    (mode) => mode.preview_state === "available",
  );
  const availableFields = useMemo(
    () =>
      marketplace?.fields.filter(
        (field) => field.active && field.sample_visibility !== "suppressed",
      ) ?? [],
    [marketplace],
  );
  const filterableFields = useMemo(
    () =>
      availableFields.filter(
        (field) =>
          field.sample_visibility === "visible" &&
          field.allowed_operators.length > 0,
      ),
    [availableFields],
  );
  const recommendedFields = useMemo(
    () => defaultMarketplaceFields(availableFields),
    [availableFields],
  );
  const current = preview ?? sampleQuery.data;
  const effectiveCommittedFields =
    committedFields.length > 0
      ? committedFields
      : recommendedFields.length > 0
        ? recommendedFields
        : (current?.selected_fields ?? []);
  const currentFilterCount = activeFilterCount(activeQuery?.filter);
  const appliedContactDefinition = contactModes.find(
    (mode) => mode.code === appliedContactMode,
  );
  const templateInitializationKey = templateQuery.data
    ? `${templateQuery.data.slug}:${templateQuery.data.version}:${availableFields
        .map((field) => field.name)
        .join("|")}`
    : "";

  useEffect(() => {
    if (
      templateInitializationKey.length === 0 ||
      templateInitializationKey === initializedTemplateKey
    ) {
      return;
    }
    setSelectedFields(recommendedFields);
    setCommittedFields(recommendedFields);
    setFilterRules(
      filterableFields.length > 0
        ? [createMarketplaceFilterRule(filterableFields)]
        : [],
    );
    setFilterGroupOperator("and");
    setSort([]);
    setPreview(null);
    setActiveQuery(null);
    setExpandedRow(null);
    setDownloadedFormat(null);
    setOpenControl(null);
    setActiveTab("sample");
    setInitializedTemplateKey(templateInitializationKey);
  }, [
    filterableFields,
    initializedTemplateKey,
    recommendedFields,
    templateInitializationKey,
  ]);

  useEffect(() => {
    const selectedIsAvailable = contactModes.some(
      (mode) =>
        mode.code === selectedContactMode && mode.preview_state === "available",
    );
    if (!selectedIsAvailable) {
      setSelectedContactMode(firstAvailableContactMode?.code ?? null);
    }
    const appliedIsAvailable = contactModes.some(
      (mode) =>
        mode.code === appliedContactMode && mode.preview_state === "available",
    );
    if (!appliedIsAvailable) {
      setAppliedContactMode(firstAvailableContactMode?.code ?? null);
    }
  }, [
    appliedContactMode,
    contactModes,
    firstAvailableContactMode?.code,
    selectedContactMode,
  ]);

  useEffect(() => {
    if (openControl !== "fields" && openControl !== "contacts") return;
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpenControl(null);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [openControl]);

  async function executeQuery(
    body: MarketplaceSampleQueryInput,
    append = false,
  ): Promise<boolean> {
    try {
      const result = await sampleMutation.mutateAsync(body);
      setActiveQuery(body);
      setCommittedFields([...body.selected_fields]);
      setSelectedFields([...body.selected_fields]);
      setSort(body.sort ?? []);
      setPreview((previous) => {
        const committedPreview = previous ?? current;
        return append && committedPreview
          ? { ...result, rows: [...committedPreview.rows, ...result.rows] }
          : result;
      });
      setExpandedRow(null);
      setDownloadedFormat(null);
      return true;
    } catch {
      return false;
    }
  }

  async function applyFilters(): Promise<void> {
    if (!marketplace || effectiveCommittedFields.length === 0) return;
    const filter = buildMarketplaceFilter(
      filterRules,
      filterableFields,
      filterGroupOperator,
    );
    if (!filter) return;
    const body: MarketplaceSampleQueryInput = {
      expected_sample_version: marketplace.sample.version,
      selected_fields: effectiveCommittedFields,
      filter,
      ...(sort.length > 0 ? { sort } : {}),
      page: { limit: marketplace.sample.display_page_size },
    };
    if (await executeQuery(body)) setOpenControl(null);
  }

  function clearFilters(): void {
    setFilterRules((currentRules) => {
      if (filterableFields.length === 0) return [];
      const freshRule = createMarketplaceFilterRule(filterableFields);
      return [
        currentRules[0] ? { ...freshRule, id: currentRules[0].id } : freshRule,
      ];
    });
    setFilterGroupOperator("and");
    setPreview(null);
    setActiveQuery(null);
    setSort([]);
    setExpandedRow(null);
    setDownloadedFormat(null);
    sampleMutation.reset();
    sampleDownload.reset();
  }

  async function applyTableLayout(): Promise<void> {
    if (!marketplace || !current || selectedFields.length === 0) return;
    const body: MarketplaceSampleQueryInput = {
      expected_sample_version: current.sample_version,
      selected_fields: selectedFields,
      ...(activeQuery?.filter ? { filter: activeQuery.filter } : {}),
      ...(sort.length > 0 ? { sort } : {}),
      page: { limit: marketplace.sample.display_page_size },
    };
    if (await executeQuery(body)) setOpenControl(null);
  }

  async function runCommittedQuery(
    options: QueryOptions = {},
  ): Promise<boolean> {
    if (!marketplace || !current || effectiveCommittedFields.length === 0) {
      return false;
    }
    const nextSort = options.nextSort ?? sort;
    const body: MarketplaceSampleQueryInput = {
      expected_sample_version: current.sample_version,
      selected_fields: effectiveCommittedFields,
      ...(activeQuery?.filter ? { filter: activeQuery.filter } : {}),
      ...(nextSort.length > 0 ? { sort: nextSort } : {}),
      page: {
        limit: marketplace.sample.display_page_size,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      },
    };
    return executeQuery(body, options.append);
  }

  async function downloadSample(format: "json" | "csv"): Promise<void> {
    if (!current || effectiveCommittedFields.length === 0) return;
    const body: MarketplaceSampleDownloadInput = {
      expected_sample_version: current.sample_version,
      selected_fields: effectiveCommittedFields,
      ...(activeQuery?.filter ? { filter: activeQuery.filter } : {}),
      ...(sort.length > 0 ? { sort } : {}),
      format,
      record_limit: Math.max(1, Math.min(100, current.rows.length)),
    };
    try {
      const authorization = await sampleDownload.mutateAsync(body);
      setDownloadedFormat(format);
      beginBrowserDownload(authorization);
    } catch {
      setDownloadedFormat(null);
    }
  }

  async function changeSort(field: string): Promise<void> {
    const previous = sort[0];
    const next: MarketplaceSortItem[] = [
      {
        field,
        direction:
          previous?.field === field && previous.direction === "asc"
            ? "desc"
            : "asc",
      },
    ];
    await runCommittedQuery({ nextSort: next });
  }

  async function submitExpertEnquiry(): Promise<void> {
    if (!templateQuery.data) return;
    try {
      await expertEnquiry.mutateAsync({
        expected_template_version: templateQuery.data.version,
      });
    } catch {
      // React Query owns the customer-safe error state rendered below.
    }
  }

  function applyContactFilter(): void {
    const selected = contactModes.find(
      (mode) => mode.code === selectedContactMode,
    );
    if (selected?.preview_state !== "available") return;
    setAppliedContactMode(selected.code);
    setOpenControl(null);
  }

  if (templateQuery.isPending || sampleQuery.isPending) {
    return (
      <div className="marketplace-state" role="status">
        Loading the stored sample…
      </div>
    );
  }

  if (
    templateQuery.isError ||
    sampleQuery.isError ||
    !templateQuery.data ||
    !current ||
    !marketplace
  ) {
    return (
      <div className="marketplace-state marketplace-state--error" role="alert">
        <strong>The requested LinkedIn sample is unavailable.</strong>
        <p>Return to the Dataset Marketplace and try again.</p>
        <Link to={organizationPath("/workspace/marketplace")}>Back to marketplace</Link>
      </div>
    );
  }

  const domainPath = organizationPath(`/workspace/marketplace/groups/${templateQuery.data.presentation.domain_slug}`);

  return (
    <section className="sample-workspace" aria-labelledby="sample-title">
      <nav className="sample-breadcrumbs" aria-label="Breadcrumb">
        <Link to={organizationPath("/workspace/marketplace")}>Dataset Marketplace</Link>
        <span aria-hidden="true">/</span>
        <Link to={domainPath}>
          {templateQuery.data.presentation.domain_name}
        </Link>
        <span aria-hidden="true">/</span>
        <span>{templateQuery.data.presentation.operation_name}</span>
      </nav>

      <header className="sample-header">
        <div className="sample-header__title">
          <span className="marketplace-card__brand" aria-hidden="true">
            in
          </span>
          <div>
            <p className="workspace-eyebrow">LinkedIn dataset</p>
            <h2 id="sample-title">{templateQuery.data.name}</h2>
            <p>{templateQuery.data.description}</p>
          </div>
        </div>
        <div className="sample-header__actions">
          <button
            className="sample-expert-action"
            type="button"
            disabled={expertEnquiry.isPending || expertEnquiry.isSuccess}
            onClick={() => void submitExpertEnquiry()}
          >
            {expertEnquiry.isPending
              ? "Sending request…"
              : expertEnquiry.isSuccess
                ? "Request received"
                : "Talk to a data expert"}
          </button>
          <button
            className="sample-purchase-action"
            type="button"
            disabled
            aria-describedby="purchase-boundary"
          >
            Purchase unavailable
          </button>
        </div>
        {(expertEnquiry.isSuccess || expertEnquiry.isError) && (
          <div className="sample-header__message">
            {expertEnquiry.isSuccess && (
              <p className="sample-enquiry-success" role="status">
                Status: {expertEnquiry.data.state.replaceAll("_", " ")}. Our
                data team can now review this request.
              </p>
            )}
            {expertEnquiry.isError && (
              <p className="sample-enquiry-error" role="alert">
                {enquiryErrorMessage(expertEnquiry.error)}
              </p>
            )}
          </div>
        )}
        <div className="sample-header__facts">
          <span>
            <small>Data fields</small>
            <strong>{marketplace.fields.length}</strong>
          </span>
          <span>
            <small>Stored sample</small>
            <strong>{marketplace.sample.record_count} rows</strong>
          </span>
          <span>
            <small>Preview access</small>
            <strong>Governed</strong>
          </span>
          <span>
            <small>Retention</small>
            <strong>30 days</strong>
          </span>
        </div>
      </header>

      <div className="dataset-tabs" role="tablist" aria-label="Dataset details">
        {MARKETPLACE_DATASET_TABS.map((tab) => (
          <button
            id={`dataset-tab-${tab.id}`}
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`dataset-panel-${tab.id}`}
            className={activeTab === tab.id ? "is-active" : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "sample" ? (
        <div
          id="dataset-panel-sample"
          role="tabpanel"
          aria-labelledby="dataset-tab-sample"
          className="sample-tab-panel"
        >
          <fieldset className="sample-toolbar">
            <legend className="visually-hidden">Sample controls</legend>
            <button
              className={openControl === "filters" ? "is-active" : undefined}
              type="button"
              aria-expanded={openControl === "filters"}
              onClick={() =>
                setOpenControl((currentControl) =>
                  currentControl === "filters" ? null : "filters",
                )
              }
            >
              <span aria-hidden="true">⌕</span> Filters
              {currentFilterCount > 0 && <b>{currentFilterCount}</b>}
            </button>
            {contactModes.length > 0 && (
              <button
                className={openControl === "contacts" ? "is-active" : undefined}
                type="button"
                aria-expanded={openControl === "contacts"}
                onClick={() => setOpenControl("contacts")}
              >
                <span aria-hidden="true">◎</span> Contact filters
              </button>
            )}
            <button
              className={openControl === "fields" ? "is-active" : undefined}
              type="button"
              aria-expanded={openControl === "fields"}
              onClick={() => setOpenControl("fields")}
            >
              <span aria-hidden="true">▦</span> Edit table
            </button>
            <span className="sample-toolbar__count">
              {current.matches_in_sample} matched in this{" "}
              {current.sample_record_count}-row sample
            </span>
            {appliedContactDefinition && (
              <span className="sample-toolbar__mode">
                {marketplaceFieldLabel(appliedContactDefinition.code)}
              </span>
            )}
          </fieldset>

          {openControl === "filters" && (
            <MarketplaceFilterBuilder
              fields={filterableFields}
              rules={filterRules}
              groupOperator={filterGroupOperator}
              busy={sampleMutation.isPending}
              onRulesChange={setFilterRules}
              onGroupOperatorChange={setFilterGroupOperator}
              onApply={() => void applyFilters()}
              onClear={clearFilters}
              onClose={() => setOpenControl(null)}
            />
          )}

          {sampleMutation.isError && (
            <div className="sample-query-error" role="alert">
              {errorMessage(sampleMutation.error)}
            </div>
          )}

          <section
            className="sample-table-section"
            aria-labelledby="data-sample-title"
          >
            <div className="sample-table-heading">
              <div>
                <p className="workspace-eyebrow">Preview only</p>
                <h3 id="data-sample-title">Data sample</h3>
              </div>
              <div className="sample-download-actions">
                <span className="sample-download-actions__version">
                  Sample v{current.sample_version}
                </span>
                <button
                  type="button"
                  disabled={sampleDownload.isPending}
                  onClick={() => void downloadSample("json")}
                >
                  Download JSON
                </button>
                <button
                  type="button"
                  disabled={sampleDownload.isPending}
                  onClick={() => void downloadSample("csv")}
                >
                  Download CSV
                </button>
              </div>
            </div>
            <p className="sample-download-format-note">
              JSON preserves the masked sample values. CSV is for spreadsheet
              viewing and may prefix formula-like cells; use JSON for exact
              data.
            </p>

            {sampleDownload.isError && (
              <div className="sample-query-error" role="alert">
                {downloadErrorMessage(sampleDownload.error)}
              </div>
            )}
            {downloadedFormat && !sampleDownload.isPending && (
              <div className="sample-download-success" role="status">
                Your masked {downloadedFormat.toUpperCase()} sample download was
                authorized.
              </div>
            )}

            <div className="sample-table-scroll">
              <table
                style={{
                  minWidth: `${Math.max(760, effectiveCommittedFields.length * 190 + 64)}px`,
                }}
              >
                <thead>
                  <tr>
                    <th aria-label="Expand row" />
                    {effectiveCommittedFields.map((field) => {
                      const definition = availableFields.find(
                        (candidate) => candidate.name === field,
                      );
                      const sortable =
                        definition?.sample_visibility === "visible";
                      return (
                        <th key={field}>
                          {sortable ? (
                            <button
                              type="button"
                              onClick={() => void changeSort(field)}
                            >
                              {marketplaceFieldLabel(field)}
                              {sort[0]?.field === field
                                ? sort[0].direction === "asc"
                                  ? " ↑"
                                  : " ↓"
                                : " ↕"}
                            </button>
                          ) : (
                            <span>{marketplaceFieldLabel(field)}</span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {current.rows.map((row, index) => (
                    <tr key={marketplaceRowKey(current.sample_version, index)}>
                      <td>
                        <button
                          className="sample-row-toggle"
                          type="button"
                          aria-label={`${expandedRow === index ? "Collapse" : "Expand"} sample row ${index + 1}`}
                          aria-expanded={expandedRow === index}
                          onClick={() =>
                            setExpandedRow((currentRow) =>
                              currentRow === index ? null : index,
                            )
                          }
                        >
                          {expandedRow === index ? "−" : "+"}
                        </button>
                      </td>
                      {effectiveCommittedFields.map((field) => (
                        <td
                          key={field}
                          title={marketplaceDisplayValue(row[field])}
                        >
                          {marketplaceDisplayValue(row[field])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {expandedRow !== null && current.rows[expandedRow] && (
              <dl className="sample-row-detail">
                {effectiveCommittedFields.map((field) => (
                  <div key={field}>
                    <dt>{marketplaceFieldLabel(field)}</dt>
                    <dd>
                      {marketplaceDisplayValue(
                        current.rows[expandedRow]?.[field],
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {current.rows.length === 0 && (
              <div className="sample-empty">
                No rows in this stored sample match the filter.
              </div>
            )}
            <footer className="sample-table-footer">
              <div>
                <strong>
                  Showing {current.rows.length} of {current.matches_in_sample}{" "}
                  sample matches
                </strong>
                <p>{current.masking_notice}</p>
              </div>
              {current.page.has_more && current.page.next_cursor && (
                <button
                  className="sample-secondary-action sample-table-footer__load-more"
                  type="button"
                  disabled={sampleMutation.isPending}
                  onClick={() =>
                    void runCommittedQuery({
                      cursor: current.page.next_cursor ?? undefined,
                      append: true,
                    })
                  }
                >
                  Load more sample rows
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : (
        <div
          id={`dataset-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`dataset-tab-${activeTab}`}
        >
          <MarketplaceDatasetInformation
            tab={activeTab}
            template={templateQuery.data}
            marketplace={marketplace}
          />
        </div>
      )}

      <aside className="sample-boundary" id="purchase-boundary">
        <div>
          <span className="sample-boundary__index">Access boundary</span>
          <strong>Full dataset purchasing is not enabled yet.</strong>
          <span>
            Sample exploration remains available. Talk to our data team to
            record your requirements; no purchase or provider work starts from
            this page.
          </span>
        </div>
        <span className="sample-boundary__state">Checkout unavailable</span>
      </aside>

      {(openControl === "fields" || openControl === "contacts") && (
        <button
          type="button"
          className="sample-drawer-backdrop"
          aria-label={`Close ${openControl === "fields" ? "field editor" : "contact filters"}`}
          onClick={() => setOpenControl(null)}
        />
      )}

      {openControl === "fields" && (
        <MarketplaceFieldDrawer
          fields={availableFields}
          selectedFields={selectedFields}
          defaultFields={recommendedFields}
          busy={sampleMutation.isPending}
          onSelectedFieldsChange={setSelectedFields}
          onApply={() => void applyTableLayout()}
          onClose={() => setOpenControl(null)}
        />
      )}

      {openControl === "contacts" && (
        <MarketplaceContactDrawer
          modes={contactModes}
          selectedMode={selectedContactMode}
          onSelectedModeChange={setSelectedContactMode}
          onApply={applyContactFilter}
          onReset={() =>
            setSelectedContactMode(firstAvailableContactMode?.code ?? null)
          }
          onClose={() => setOpenControl(null)}
        />
      )}
    </section>
  );
}
