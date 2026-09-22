import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { DhumiApiError } from "../../api/errors";
import type { RunStatus, Service } from "../../api/generated";
import { useServicesQuery } from "../workspace/workspaceQueries";
import { ResultDownloadControl } from "./components/ResultDownloadControl";
import {
  useCancelRunMutation,
  useRetryRunMutation,
  useRunEventsQuery,
  useRunQuery,
  useRunResultMutation,
  useRunsQuery,
} from "./runQueries";

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function statusLabel(status: RunStatus): string {
  return `${status.slice(0, 1).toLocaleUpperCase()}${status.slice(1)}`;
}

function customerError(error: unknown): string {
  return error instanceof DhumiApiError
    ? error.message
    : "Dhumi could not complete this action. Try again.";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function RunInspector({
  runId,
  service,
  onClose,
  onRetried,
}: {
  readonly runId: string;
  readonly service: Service | null;
  readonly onClose: () => void;
  readonly onRetried: (runId: string) => void;
}) {
  const runQuery = useRunQuery(runId);
  const eventsQuery = useRunEventsQuery(runId, runQuery.data?.status);
  const cancelMutation = useCancelRunMutation();
  const retryMutation = useRetryRunMutation();
  const normalizedResultMutation = useRunResultMutation();
  const rawResultMutation = useRunResultMutation();
  const run = runQuery.data;
  const actionError =
    cancelMutation.error ??
    retryMutation.error ??
    normalizedResultMutation.error ??
    rawResultMutation.error;

  return (
    <aside className="run-inspector" aria-labelledby="run-inspector-title">
      <header className="run-inspector__header">
        <div>
          <p className="workspace-eyebrow">Selected collection</p>
          <h3 id="run-inspector-title">
            {service?.name ?? "Collection details"}
          </h3>
        </div>
        <button type="button" aria-label="Close run details" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {runQuery.isPending && (
        <div className="configuration-state" role="status">
          Loading collection…
        </div>
      )}
      {runQuery.isError && (
        <div
          className="configuration-state configuration-state--error"
          role="alert"
        >
          {customerError(runQuery.error)}
        </div>
      )}
      {run && (
        <>
          <div className="run-inspector__identity">
            <span className={`run-status run-status--${run.status}`}>
              {statusLabel(run.status)}
            </span>
            <code>{run.id}</code>
            <strong>{service?.name ?? run.service_id}</strong>
            <small>Updated {formatDate(run.updated_at)}</small>
          </div>
          <section
            className="run-timeline"
            aria-labelledby="run-progress-title"
          >
            <div className="run-section-heading">
              <span>01</span>
              <h4 id="run-progress-title">Safe event history</h4>
            </div>
            {eventsQuery.isPending && <p role="status">Loading events…</p>}
            {eventsQuery.isError && (
              <p role="alert">{customerError(eventsQuery.error)}</p>
            )}
            <ol>
              {(eventsQuery.data?.data ?? []).map((event, index, events) => (
                <li
                  className={`run-event run-event--${index === events.length - 1 ? "current" : "complete"}`}
                  key={event.id}
                >
                  <span aria-hidden="true" />
                  <div>
                    <strong>{event.message}</strong>
                    <small>{formatDate(event.occurred_at)}</small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {run.error_code && (
            <p className="run-inspector__safe-error" role="status">
              Collection stopped with code {run.error_code}.
            </p>
          )}
          <section
            className="run-inspector__actions"
            aria-labelledby="run-actions-title"
          >
            <div className="run-section-heading">
              <span>02</span>
              <h4 id="run-actions-title">Actions</h4>
            </div>
            {actionError && (
              <p className="run-inspector__safe-error" role="alert">
                {customerError(actionError)}
              </p>
            )}
            {(run.status === "queued" || run.status === "running") && (
              <button
                className="run-action run-action--danger"
                type="button"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate(run.id)}
              >
                {cancelMutation.isPending ? "Cancelling…" : "Cancel collection"}
              </button>
            )}
            {(run.status === "failed" || run.status === "expired") &&
              run.retryable && (
                <button
                  className="run-action run-action--primary"
                  type="button"
                  disabled={retryMutation.isPending}
                  onClick={() =>
                    retryMutation.mutate(run.id, {
                      onSuccess: (accepted) => onRetried(accepted.run_id),
                    })
                  }
                >
                  {retryMutation.isPending ? "Retrying…" : "Retry collection"}
                </button>
              )}
            {run.status === "ready" && (
              <fieldset className="result-downloads">
                <legend className="visually-hidden">Result downloads</legend>
                <ResultDownloadControl
                  representation="normalized"
                  result={normalizedResultMutation.data}
                  isPending={normalizedResultMutation.isPending}
                  onPrepare={() =>
                    normalizedResultMutation.mutate({
                      runId: run.id,
                      representation: "normalized",
                    })
                  }
                />
                <ResultDownloadControl
                  representation="raw"
                  result={rawResultMutation.data}
                  isPending={rawResultMutation.isPending}
                  onPrepare={() =>
                    rawResultMutation.mutate({
                      runId: run.id,
                      representation: "raw",
                    })
                  }
                />
              </fieldset>
            )}
            {(run.status === "cancelled" ||
              (run.status === "failed" && !run.retryable)) && (
              <p>
                This collection is closed. Its safe history remains available.
              </p>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

export function RunsWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | RunStatus>("all");
  const selectedRunId = searchParams.get("run");
  const serviceFilter = searchParams.get("service") ?? undefined;
  const runsQuery = useRunsQuery({
    status: status === "all" ? undefined : status,
    serviceId: serviceFilter,
  });
  const servicesQuery = useServicesQuery();
  const servicesById = useMemo(
    () =>
      new Map(
        (servicesQuery.data?.data ?? []).map((service) => [
          service.id,
          service,
        ]),
      ),
    [servicesQuery.data],
  );
  const visibleRuns = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (runsQuery.data?.data ?? []).filter((run) => {
      const serviceName = servicesById.get(run.service_id)?.name ?? "";
      return (
        normalized.length === 0 ||
        serviceName.toLocaleLowerCase().includes(normalized) ||
        run.id.toLocaleLowerCase().includes(normalized)
      );
    });
  }, [query, runsQuery.data, servicesById]);
  const selectedRun = (runsQuery.data?.data ?? []).find(
    (run) => run.id === selectedRunId,
  );
  const selectedService = selectedRun
    ? (servicesById.get(selectedRun.service_id) ?? null)
    : null;

  function selectRun(runId: string | null): void {
    const next = new URLSearchParams(searchParams);
    if (runId) next.set("run", runId);
    else next.delete("run");
    setSearchParams(next, { replace: true });
  }

  return (
    <section className="runs-workspace" aria-labelledby="runs-title">
      <header className="runs-titlebar">
        <div>
          <p className="workspace-eyebrow">Collections</p>
          <h2 id="runs-title">Runs</h2>
          <p>
            Review every collection and open its details without leaving the
            list.
          </p>
        </div>
        <span>{visibleRuns.length} loaded runs</span>
      </header>
      <div
        className={`runs-board${selectedRunId ? " runs-board--inspecting" : ""}`}
      >
        <div className="runs-list-panel">
          <div className="runs-toolbar">
            <label className="runs-search">
              <span className="visually-hidden">Search runs</span>
              <SearchIcon />
              <input
                type="search"
                value={query}
                placeholder="Search collections"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <label className="runs-filter">
              <FilterIcon />
              <span className="visually-hidden">Filter by status</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.currentTarget.value as "all" | RunStatus)
                }
              >
                <option value="all">All statuses</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="ready">Ready</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
                <option value="expired">Expired</option>
              </select>
            </label>
            <button
              className="runs-date"
              type="button"
              disabled
              title="Date filtering is not part of the current Runs API contract."
            >
              Date range<span aria-hidden="true">⌄</span>
            </button>
          </div>
          {runsQuery.isPending && (
            <div className="runs-empty" role="status">
              <strong>Loading runs…</strong>
            </div>
          )}
          {runsQuery.isError && (
            <div className="runs-empty" role="alert">
              <strong>Runs could not be loaded.</strong>
              <p>{customerError(runsQuery.error)}</p>
            </div>
          )}
          {runsQuery.isSuccess && (
            <div className="runs-table-wrap">
              <table className="runs-table">
                <thead>
                  <tr>
                    <th>Saved scraper</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRuns.map((run) => (
                    <tr
                      className={
                        run.id === selectedRunId ? "is-selected" : undefined
                      }
                      key={run.id}
                    >
                      <td>
                        <button type="button" onClick={() => selectRun(run.id)}>
                          <strong>
                            {servicesById.get(run.service_id)?.name ??
                              "Saved scraper"}
                          </strong>
                          <small>{run.id}</small>
                        </button>
                      </td>
                      <td>
                        <span
                          className={`run-status run-status--${run.status}`}
                        >
                          {statusLabel(run.status)}
                        </span>
                      </td>
                      <td>{formatDate(run.created_at)}</td>
                      <td>{formatDate(run.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runsQuery.isSuccess && visibleRuns.length === 0 && (
            <div className="runs-empty" role="status">
              <strong>No runs match these filters.</strong>
              <p>Clear the search or choose another status.</p>
            </div>
          )}
          {runsQuery.isSuccess && (
            <footer className="runs-pagination">
              <span>
                Showing {visibleRuns.length} runs
                {runsQuery.data.page.has_more ? " · more are available" : ""}
              </span>
            </footer>
          )}
        </div>
        {selectedRunId && (
          <RunInspector
            key={selectedRunId}
            runId={selectedRunId}
            service={selectedService}
            onClose={() => selectRun(null)}
            onRetried={selectRun}
          />
        )}
      </div>
    </section>
  );
}
