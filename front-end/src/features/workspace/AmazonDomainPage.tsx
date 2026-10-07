import { organizationPath } from "../../api/organizationScope";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DhumiApiError } from "../../api/errors";
import type { Service, ServiceTemplate } from "../../api/generated";
import { CurrentRunPanel } from "../runs/components/CurrentRunPanel";
import {
  useCreateRunMutation,
  useCreateServiceMutation,
  useServiceQuery,
} from "../runs/runQueries";
import { cleanCustomerText } from "./customerText";
import {
  useScraperLibraryQuery,
  useServicesQuery,
  useTemplateQuery,
} from "./workspaceQueries";

interface InputRow {
  readonly id: number;
  readonly url: string;
  readonly zipcode: string;
  readonly language: string;
  readonly allVariations: boolean;
}

interface UrlTargetSchema {
  readonly minItems: number;
  readonly maxItems: number;
  readonly hasZipcode: boolean;
  readonly zipcodePattern: string | null;
  readonly hasLanguage: boolean;
  readonly languageOptions: readonly string[];
  readonly hasAllVariations: boolean;
}

type OperationSection = "configuration" | "overview";

function createInputRow(id: number, defaultLanguage: string): InputRow {
  return {
    id,
    url: "",
    zipcode: "",
    language: defaultLanguage,
    allVariations: false,
  };
}

function customerError(error: unknown): string {
  return error instanceof DhumiApiError
    ? error.message
    : "Dhumi could not complete this action. Try again.";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readUrlTargetSchema(
  inputSchema: Record<string, unknown>,
): UrlTargetSchema | null {
  const rootProperties = asRecord(inputSchema.properties);
  const targets = asRecord(rootProperties?.targets);
  const itemSchema = asRecord(targets?.items);
  const itemProperties = asRecord(itemSchema?.properties);
  const requiredFields = Array.isArray(itemSchema?.required)
    ? itemSchema.required
    : [];
  const minItems = targets?.minItems;
  const maxItems = targets?.maxItems;
  const zipcode = asRecord(itemProperties?.zipcode);
  const language = asRecord(itemProperties?.language);
  const languageOptions = Array.isArray(language?.enum)
    ? language.enum.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (
    targets?.type !== "array" ||
    itemSchema?.type !== "object" ||
    !asRecord(itemProperties?.url) ||
    !requiredFields.includes("url") ||
    !Number.isInteger(minItems) ||
    !Number.isInteger(maxItems) ||
    (minItems as number) < 1 ||
    (maxItems as number) < (minItems as number)
  )
    return null;
  return {
    minItems: minItems as number,
    maxItems: maxItems as number,
    hasZipcode: zipcode !== null,
    zipcodePattern:
      zipcode !== null && typeof zipcode.pattern === "string"
        ? zipcode.pattern
        : null,
    hasLanguage: language !== null,
    languageOptions,
    hasAllVariations: asRecord(itemProperties?.all_variations) !== null,
  };
}

function buildRunInput(rows: readonly InputRow[]): Record<string, unknown> {
  return {
    targets: rows.map((row) => ({
      url: row.url.trim(),
      ...(row.zipcode.trim() ? { zipcode: row.zipcode.trim() } : {}),
      ...(row.language.trim() ? { language: row.language.trim() } : {}),
      all_variations: row.allVariations,
    })),
  };
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

function UrlCollectionWorkbench({
  template,
  schema,
  services,
  servicesPending,
}: {
  readonly template: ServiceTemplate;
  readonly schema: UrlTargetSchema;
  readonly services: readonly Service[];
  readonly servicesPending: boolean;
}) {
  const nextRowId = useRef(schema.minItems + 1);
  const hasAutoSelectedService = useRef(false);
  const [rows, setRows] = useState<InputRow[]>(() =>
    Array.from({ length: schema.minItems }, (_, index) =>
      createInputRow(index + 1, schema.languageOptions[0] ?? ""),
    ),
  );
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  );
  const [showCreateService, setShowCreateService] = useState(
    services.length === 0,
  );
  const [draftServiceName, setDraftServiceName] = useState("");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const serviceQuery = useServiceQuery(selectedServiceId);
  const createServiceMutation = useCreateServiceMutation();
  const createRunMutation = useCreateRunMutation();

  useEffect(() => {
    if (
      !hasAutoSelectedService.current &&
      services.length === 1 &&
      selectedServiceId === null
    ) {
      setSelectedServiceId(services[0]?.id ?? null);
      setShowCreateService(false);
      hasAutoSelectedService.current = true;
    }
    if (!servicesPending && services.length === 0) {
      setShowCreateService(true);
      hasAutoSelectedService.current = true;
    }
  }, [selectedServiceId, services, servicesPending]);

  function updateRow(
    rowId: number,
    field: keyof Omit<InputRow, "id">,
    value: string | boolean,
  ): void {
    setActionMessage(null);
    setRows((current) =>
      current.map((row) =>
        row.id === rowId ? { ...row, [field]: value } : row,
      ),
    );
  }

  function addRow(): void {
    if (rows.length >= schema.maxItems) return;
    const rowId = nextRowId.current++;
    setRows((current) => [
      ...current,
      createInputRow(rowId, schema.languageOptions[0] ?? ""),
    ]);
  }

  function removeRow(rowId: number): void {
    setRows((current) =>
      current.length <= schema.minItems
        ? current.map((row) =>
            row.id === rowId
              ? createInputRow(row.id, schema.languageOptions[0] ?? "")
              : row,
          )
        : current.filter((row) => row.id !== rowId),
    );
  }

  function resetRows(): void {
    setRows(
      Array.from({ length: schema.minItems }, () =>
        createInputRow(nextRowId.current++, schema.languageOptions[0] ?? ""),
      ),
    );
    setActionMessage(null);
  }

  async function saveService(): Promise<void> {
    const name = draftServiceName.trim();
    if (!name) return setActionMessage("Enter a name for the saved scraper.");
    try {
      const service = await createServiceMutation.mutateAsync({
        templateSlug: template.slug,
        name,
        configuration: {},
      });
      setSelectedServiceId(service.id);
      setShowCreateService(false);
      setDraftServiceName("");
      setActionMessage(`${service.name} was saved.`);
    } catch (error) {
      setActionMessage(customerError(error));
    }
  }

  async function startCollection(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const service = serviceQuery.data;
    if (!service || service.id !== selectedServiceId) {
      setActionMessage(
        "Choose an active saved scraper and wait for it to be confirmed.",
      );
      return;
    }
    if (
      service.state !== "active" ||
      service.template_slug !== template.slug ||
      service.template_version !== template.version
    ) {
      setActionMessage(
        "This saved scraper does not match the published operation version.",
      );
      return;
    }
    try {
      const accepted = await createRunMutation.mutateAsync({
        serviceId: service.id,
        input: buildRunInput(rows),
      });
      setCurrentRunId(accepted.run_id);
      setActionMessage(
        `${rows.length} ${rows.length === 1 ? "input was" : "inputs were"} accepted.`,
      );
    } catch (error) {
      setActionMessage(customerError(error));
    }
  }

  const confirmedService = serviceQuery.data ?? null;
  return (
    <form className="input-workbench" onSubmit={startCollection}>
      <div className="input-workbench__heading">
        <div>
          <p className="workspace-eyebrow">Run input</p>
          <h3 id="collector-inputs">{template.presentation.operation_name}</h3>
          <p>{cleanCustomerText(template.description)}</p>
        </div>
        <span>
          {rows.length} / {schema.maxItems} inputs
        </span>
      </div>
      <div className="input-table">
        <div className="input-table__header" aria-hidden="true">
          <span>URL · Required</span>
          {schema.hasZipcode && <span>ZIP code · Optional</span>}
          {schema.hasLanguage && <span>Language · Optional</span>}
          {schema.hasAllVariations && <span>All variations · Optional</span>}
          <span />
        </div>
        <div className="input-table__rows">
          {rows.map((row, index) => (
            <div className="input-row" key={row.id}>
              <label>
                <span className="input-row__mobile-label">
                  Product URL · Required
                </span>
                <input
                  type="url"
                  required
                  value={row.url}
                  placeholder="https://www.amazon.com/dp/..."
                  aria-label={`Product URL ${index + 1}`}
                  onChange={(event) =>
                    updateRow(row.id, "url", event.currentTarget.value)
                  }
                />
              </label>
              {schema.hasZipcode && (
                <label>
                  <span className="input-row__mobile-label">
                    ZIP code · Optional
                  </span>
                  <input
                    type="text"
                    value={row.zipcode}
                    placeholder={
                      schema.zipcodePattern === "^[0-9]{5}$"
                        ? "12345"
                        : "Postal code"
                    }
                    aria-label={`ZIP code ${index + 1}`}
                    autoComplete="postal-code"
                    inputMode="numeric"
                    maxLength={10}
                    pattern={schema.zipcodePattern ?? undefined}
                    title={
                      schema.zipcodePattern
                        ? "Enter a value accepted by the published ZIP-code contract."
                        : undefined
                    }
                    onChange={(event) =>
                      updateRow(row.id, "zipcode", event.currentTarget.value)
                    }
                  />
                </label>
              )}
              {schema.hasLanguage && (
                <label htmlFor={`language-${row.id}`}>
                  <span className="input-row__mobile-label">
                    Language · Optional
                  </span>
                  {schema.languageOptions.length > 0 ? (
                    <select
                      id={`language-${row.id}`}
                      value={row.language}
                      aria-label={`Language ${index + 1}`}
                      onChange={(event) =>
                        updateRow(row.id, "language", event.currentTarget.value)
                      }
                    >
                      <option value="">Marketplace default</option>
                      {schema.languageOptions.map((language) => (
                        <option value={language} key={language}>
                          {language === "EN" ? "English (EN)" : language}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`language-${row.id}`}
                      type="text"
                      value={row.language}
                      aria-label={`Language ${index + 1}`}
                      onChange={(event) =>
                        updateRow(row.id, "language", event.currentTarget.value)
                      }
                    />
                  )}
                </label>
              )}
              {schema.hasAllVariations && (
                <label className="variation-toggle">
                  <input
                    type="checkbox"
                    checked={row.allVariations}
                    aria-label={`Collect all variations ${index + 1}`}
                    onChange={(event) =>
                      updateRow(
                        row.id,
                        "allVariations",
                        event.currentTarget.checked,
                      )
                    }
                  />
                  <span>Include</span>
                </label>
              )}
              <button
                className="remove-input"
                type="button"
                aria-label={`Remove product input ${index + 1}`}
                onClick={() => removeRow(row.id)}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="input-table__footer">
          <span>Count: {rows.length}</span>
          <div>
            <button
              type="button"
              disabled={rows.length >= schema.maxItems}
              onClick={addRow}
            >
              + Add input
            </button>
            <button type="button" onClick={resetRows}>
              Remove all
            </button>
          </div>
        </div>
      </div>

      <section className="service-step" aria-labelledby="service-step-title">
        <div className="service-step__heading">
          <span>02</span>
          <div>
            <p className="workspace-eyebrow">Saved scraper</p>
            <h3 id="service-step-title">
              Choose where this collection belongs
            </h3>
            <p>Reuse a saved scraper or save this operation with a new name.</p>
          </div>
        </div>
        {servicesPending && (
          <p className="service-step__state">Loading saved scrapers…</p>
        )}
        {!servicesPending && services.length > 0 && (
          <div className="service-options">
            {services.map((service) => (
              <label
                className={`service-choice${service.id === selectedServiceId ? " is-selected" : ""}`}
                key={service.id}
              >
                <input
                  type="radio"
                  name="saved-service"
                  value={service.id}
                  checked={service.id === selectedServiceId}
                  onChange={() => {
                    setSelectedServiceId(service.id);
                    setShowCreateService(false);
                    setActionMessage(null);
                  }}
                />
                <span>
                  <strong>{service.name}</strong>
                  <small>Active · Version {service.version}</small>
                </span>
              </label>
            ))}
          </div>
        )}
        {selectedServiceId && serviceQuery.isPending && (
          <p className="service-step__state" role="status">
            Confirming saved scraper…
          </p>
        )}
        {serviceQuery.isError && (
          <p
            className="service-step__state service-step__state--error"
            role="alert"
          >
            {customerError(serviceQuery.error)}
          </p>
        )}
        <button
          className="service-create-toggle"
          type="button"
          aria-expanded={showCreateService}
          onClick={() => {
            setShowCreateService((current) => !current);
            setSelectedServiceId(null);
            setActionMessage(null);
          }}
        >
          + Save this scraper with a new name
        </button>
        {showCreateService && (
          <div className="service-create-panel">
            <label>
              Saved scraper name
              <input
                type="text"
                value={draftServiceName}
                placeholder="My Amazon Products Scraper"
                onChange={(event) =>
                  setDraftServiceName(event.currentTarget.value)
                }
              />
            </label>
            <button
              type="button"
              disabled={
                createServiceMutation.isPending || !draftServiceName.trim()
              }
              onClick={saveService}
            >
              {createServiceMutation.isPending ? "Saving…" : "Save scraper"}
            </button>
          </div>
        )}
      </section>

      <div className="review-panel">
        <div>
          <span className="review-panel__number">03</span>
          <div>
            <h3>Review and start</h3>
            <p>
              {confirmedService
                ? `${rows.length} ${rows.length === 1 ? "input" : "inputs"} will use ${confirmedService.name}.`
                : "Select a saved scraper before starting this collection."}
            </p>
          </div>
        </div>
        <button
          type="submit"
          disabled={!confirmedService || createRunMutation.isPending}
        >
          {createRunMutation.isPending ? "Starting…" : "Start collection"}
        </button>
      </div>
      {actionMessage && (
        <p className="review-success" role="status">
          {actionMessage}
        </p>
      )}
      {currentRunId && confirmedService && (
        <CurrentRunPanel
          key={currentRunId}
          runId={currentRunId}
          serviceName={confirmedService.name}
          operationName={template.presentation.operation_name}
          onClose={() => setCurrentRunId(null)}
          onRetried={setCurrentRunId}
        />
      )}
    </form>
  );
}

function OperationOverview({
  template,
  schema,
  serviceCount,
}: {
  readonly template: ServiceTemplate;
  readonly schema: UrlTargetSchema;
  readonly serviceCount: number;
}) {
  return (
    <section
      className="operation-overview"
      aria-labelledby="operation-overview-title"
    >
      <p className="workspace-eyebrow">Operation overview</p>
      <h3 id="operation-overview-title">{cleanCustomerText(template.name)}</h3>
      <p>{cleanCustomerText(template.description)}</p>
      <dl>
        <div>
          <dt>Availability</dt>
          <dd>{template.availability}</dd>
        </div>
        <div>
          <dt>Inputs per Run</dt>
          <dd>
            {schema.minItems}–{schema.maxItems}
          </dd>
        </div>
        <div>
          <dt>Saved scrapers</dt>
          <dd>{serviceCount}</dd>
        </div>
        <div>
          <dt>Required field</dt>
          <dd>URL</dd>
        </div>
      </dl>
    </section>
  );
}

export function AmazonDomainPage() {
  const { domainSlug = "", templateSlug } = useParams();
  const navigate = useNavigate();
  const [operationQuery, setOperationQuery] = useState("");
  const [activeSection, setActiveSection] =
    useState<OperationSection>("configuration");
  const catalogueQuery = useScraperLibraryQuery();
  const servicesQuery = useServicesQuery();

  const domainOperations = useMemo(
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
  const activeSummary =
    domainOperations.find((template) => template.slug === templateSlug) ??
    domainOperations[0] ??
    null;
  const activeSlug = activeSummary?.slug ?? null;
  const templateQuery = useTemplateQuery(activeSlug);
  const template = templateQuery.data ?? null;
  const schema = template ? readUrlTargetSchema(template.input_schema) : null;

  const visibleOperations = useMemo(() => {
    const normalized = operationQuery.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? domainOperations
      : domainOperations.filter(
          (operation) =>
            operation.presentation.operation_name
              .toLocaleLowerCase()
              .includes(normalized) ||
            operation.presentation.operation_group
              .toLocaleLowerCase()
              .includes(normalized),
        );
  }, [domainOperations, operationQuery]);
  const operationGroups = useMemo(() => {
    const groups = new Map<string, ServiceTemplate[]>();
    for (const operation of visibleOperations) {
      const group = operation.presentation.operation_group;
      groups.set(group, [...(groups.get(group) ?? []), operation]);
    }
    return [...groups.entries()];
  }, [visibleOperations]);
  const activeServices = useMemo(
    () =>
      (servicesQuery.data?.data ?? []).filter(
        (service) =>
          service.state === "active" &&
          service.template_slug === activeSlug &&
          service.template_version === activeSummary?.version,
      ),
    [activeSlug, activeSummary?.version, servicesQuery.data],
  );

  useEffect(() => {
    if (!templateSlug && activeSlug) {
      navigate(organizationPath(`/workspace/scrapers/${domainSlug}/${activeSlug}`), {
        replace: true,
      });
    }
  }, [activeSlug, domainSlug, navigate, templateSlug]);

  const domainName = cleanCustomerText(
    activeSummary?.presentation.domain_name ??
      (catalogueQuery.isPending ? "Loading scraper…" : domainSlug),
  );
  const pageTitle = template
    ? `${cleanCustomerText(template.presentation.operation_group)} — ${cleanCustomerText(template.presentation.operation_name)}`
    : "Select an operation";

  return (
    <section className="collector-page" aria-labelledby="collector-title">
      <div className="collector-breadcrumb">
        <Link to={organizationPath("/workspace/scrapers")}>Scrapers Library</Link>
        <span aria-hidden="true">/</span>
        <strong>{domainName}</strong>
      </div>
      <header className="collector-titlebar">
        <div>
          <span className="operation-method">Available</span>
          <h2 id="collector-title">{pageTitle}</h2>
        </div>
        <Link className="back-to-library" to={organizationPath("/workspace/scrapers")}>
          <span aria-hidden="true">←</span>Back to library
        </Link>
      </header>

      <div className="collector-layout">
        <aside className="endpoint-panel" aria-labelledby="available-title">
          <div className="endpoint-panel__heading">
            <p className="workspace-eyebrow">{domainName}</p>
            <h3 id="available-title">Published operations</h3>
          </div>
          <label className="endpoint-search">
            <span className="visually-hidden">Search operations</span>
            <SearchIcon />
            <input
              type="search"
              value={operationQuery}
              placeholder="Search operations"
              onChange={(event) => setOperationQuery(event.currentTarget.value)}
            />
          </label>
          <div>
            {catalogueQuery.isPending && (
              <p role="status">Loading operations…</p>
            )}
            {catalogueQuery.isError && (
              <p className="endpoint-error" role="alert">
                Published operations could not be loaded.
              </p>
            )}
            {catalogueQuery.isSuccess && domainOperations.length === 0 && (
              <p className="endpoint-error" role="status">
                No published operation is available for this domain.
              </p>
            )}
            {operationGroups.map(([groupName, operations]) => (
              <div className="endpoint-group" key={groupName}>
                <div className="endpoint-group__heading">
                  <span>{cleanCustomerText(groupName)}</span>
                  <small>{String(operations.length).padStart(2, "0")}</small>
                </div>
                {operations.map((operation) => (
                  <button
                    className={`endpoint-item${operation.slug === activeSlug ? " endpoint-item--active" : ""}`}
                    type="button"
                    key={operation.slug}
                    onClick={() => {
                      setActiveSection("configuration");
                      navigate(
                        organizationPath(`/workspace/scrapers/${domainSlug}/${operation.slug}`),
                      );
                    }}
                  >
                    {cleanCustomerText(operation.presentation.operation_name)}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="endpoint-panel__note">
            {schema && (
              <>
                <span>
                  {schema.minItems}–{schema.maxItems}
                </span>
                <p>Inputs are rendered from the published Template schema.</p>
              </>
            )}
          </div>
        </aside>

        <div className="configuration-panel">
          <nav className="configuration-tabs" aria-label="Operation sections">
            <button
              className={
                activeSection === "configuration" ? "is-active" : undefined
              }
              type="button"
              onClick={() => setActiveSection("configuration")}
            >
              Configuration
            </button>
            <Link
              to={organizationPath(`/workspace/runs${activeServices[0] ? `?service=${encodeURIComponent(activeServices[0].id)}` : ""}`)}
            >
              Runs
            </Link>
            <button
              className={activeSection === "overview" ? "is-active" : undefined}
              type="button"
              onClick={() => setActiveSection("overview")}
            >
              Overview
            </button>
          </nav>
          <div className="saved-services" aria-live="polite">
            {servicesQuery.isPending && <span>Loading saved services…</span>}
            {servicesQuery.isError && (
              <span role="alert">Saved services could not be loaded.</span>
            )}
            {servicesQuery.isSuccess && (
              <>
                <strong>
                  {activeServices.length} active saved{" "}
                  {activeServices.length === 1 ? "service" : "services"}
                </strong>
                {activeServices.map((service) => (
                  <span key={service.id}>{service.name}</span>
                ))}
              </>
            )}
          </div>
          {templateQuery.isPending && activeSlug && (
            <div className="configuration-state" role="status">
              Loading the published input schema…
            </div>
          )}
          {templateQuery.isError && (
            <div
              className="configuration-state configuration-state--error"
              role="alert"
            >
              This operation's published schema could not be loaded.
            </div>
          )}
          {template && schema && activeSection === "configuration" && (
            <UrlCollectionWorkbench
              key={`${template.slug}:${template.version}`}
              template={template}
              schema={schema}
              services={activeServices}
              servicesPending={servicesQuery.isFetching}
            />
          )}
          {template && schema && activeSection === "overview" && (
            <OperationOverview
              template={template}
              schema={schema}
              serviceCount={activeServices.length}
            />
          )}
          {template && !schema && (
            <div className="configuration-state" role="status">
              This published schema is not supported by the current form
              renderer yet. No input has been assumed.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
