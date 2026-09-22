import { useMemo, useState } from "react";
import type { UsageEvent } from "../../api/generated";
import { useUsageEventsQuery, useUsageSummaryQuery } from "./usageQueries";
import "./usageWorkspace.css";

const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

function usageRange(days: number, end: Date) {
  const from = new Date(end);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString(), to: end.toISOString() };
}

function formatQuantity(quantity: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
    quantity,
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function eventLabel(event: UsageEvent): string {
  return event.meter
    .split(".")
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function UsageWorkspacePage() {
  const [days, setDays] = useState(30);
  const [rangeEnd, setRangeEnd] = useState(() => new Date());
  const range = useMemo(() => usageRange(days, rangeEnd), [days, rangeEnd]);
  const summaryQuery = useUsageSummaryQuery(range);
  const eventsQuery = useUsageEventsQuery(range);
  const events =
    eventsQuery.data?.pages.flatMap((page) => page.data) ??
    ([] as UsageEvent[]);

  function selectPeriod(nextDays: number): void {
    setDays(nextDays);
    setRangeEnd(new Date());
  }

  function refresh(): void {
    setRangeEnd(new Date());
  }

  return (
    <section className="usage-page" aria-labelledby="usage-title">
      <header className="usage-page__header">
        <div>
          <p className="workspace-eyebrow">Customer observability</p>
          <h2 id="usage-title">Usage</h2>
          <p>
            Trace the records attributed to this workspace. These figures are
            informational and are not a bill or customer quota.
          </p>
        </div>
        <div className="usage-page__controls">
          <label>
            <span>Period</span>
            <select
              aria-label="Usage period"
              value={days}
              onChange={(event) => selectPeriod(Number(event.target.value))}
            >
              {PERIODS.map((period) => (
                <option key={period.days} value={period.days}>
                  {period.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>

      {summaryQuery.isPending ? (
        <div className="usage-state" role="status">
          Loading usage summary…
        </div>
      ) : summaryQuery.isError ? (
        <div className="usage-state usage-state--error" role="alert">
          Usage summary could not be loaded. Refresh to try again.
        </div>
      ) : (
        <section className="usage-summary" aria-label="Usage summary">
          <article className="usage-summary__period">
            <span>Reporting window</span>
            <strong>{days} days</strong>
            <small>
              {formatDateTime(summaryQuery.data.from)} –{" "}
              {formatDateTime(summaryQuery.data.to)}
            </small>
          </article>
          {summaryQuery.data.items.length === 0 ? (
            <article className="usage-summary__empty">
              <span>Observed usage</span>
              <strong>None yet</strong>
              <small>Completed collections will appear here.</small>
            </article>
          ) : (
            summaryQuery.data.items.map((item) => (
              <article key={`${item.meter}:${item.unit}`}>
                <span>{item.meter}</span>
                <strong>{formatQuantity(item.quantity)}</strong>
                <small>{item.unit}</small>
              </article>
            ))
          )}
          <article className="usage-summary__state">
            <span>Reconciliation</span>
            <strong>{summaryQuery.data.state.replaceAll("_", " ")}</strong>
            <small>
              Updated {formatDateTime(summaryQuery.data.updated_at)}
            </small>
          </article>
        </section>
      )}

      <section className="usage-ledger" aria-labelledby="usage-ledger-title">
        <div className="usage-ledger__heading">
          <div>
            <p className="workspace-eyebrow">Run-level evidence</p>
            <h3 id="usage-ledger-title">Usage history</h3>
          </div>
          <span className="usage-ledger__count">{events.length} loaded</span>
        </div>

        {eventsQuery.isPending ? (
          <div className="usage-state" role="status">
            Loading usage history…
          </div>
        ) : eventsQuery.isError ? (
          <div className="usage-state usage-state--error" role="alert">
            Usage history could not be loaded. Refresh to try again.
          </div>
        ) : events.length === 0 ? (
          <div className="usage-state">
            <strong>No usage events in this period.</strong>
            <span>Try a longer period or complete a collection.</span>
          </div>
        ) : (
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Observed</th>
                  <th>Measurement</th>
                  <th>Quantity</th>
                  <th>Outcome</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.observed_at)}</td>
                    <td>
                      <strong>{eventLabel(event)}</strong>
                      <small>{event.product_family.replaceAll("_", " ")}</small>
                    </td>
                    <td>
                      {formatQuantity(event.quantity)} {event.unit}
                    </td>
                    <td>
                      <span
                        className={`usage-outcome usage-outcome--${event.outcome}`}
                      >
                        {event.outcome}
                      </span>
                    </td>
                    <td>
                      <code title={event.run_id}>
                        {event.run_id.slice(0, 8)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {eventsQuery.hasNextPage && (
          <button
            className="usage-ledger__more"
            type="button"
            disabled={eventsQuery.isFetchingNextPage}
            onClick={() => void eventsQuery.fetchNextPage()}
          >
            {eventsQuery.isFetchingNextPage ? "Loading…" : "Load more events"}
          </button>
        )}
      </section>
    </section>
  );
}
