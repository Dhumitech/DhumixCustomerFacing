import { Link } from "react-router";
import { organizationPath } from "../../../api/organizationScope";
import { DhumiApiError } from "../../../api/errors";
import type { RunEvent, RunStatus } from "../../../api/generated";
import {
  useCancelRunMutation,
  useRetryRunMutation,
  useRunEventsQuery,
  useRunQuery,
  useRunResultMutation,
} from "../runQueries";
import { ResultDownloadControl } from "./ResultDownloadControl";

const EVENT_PROGRESS: Partial<Record<RunEvent["type"], number>> = {
  accepted: 10,
  queued: 15,
  started: 35,
  progress: 60,
  result_received: 80,
  completed: 100,
};

function customerError(error: unknown): string {
  return error instanceof DhumiApiError
    ? error.message
    : "Dhumi could not complete this action. Try again.";
}

function statusLabel(status: RunStatus): string {
  return `${status.slice(0, 1).toLocaleUpperCase()}${status.slice(1)}`;
}

export function lifecycleProgress(
  status: RunStatus,
  events: readonly RunEvent[],
): number {
  if (status === "ready") return 100;
  const statusFloor = status === "running" ? 35 : status === "queued" ? 15 : 0;
  return Math.max(
    statusFloor,
    ...events.map((event) => EVENT_PROGRESS[event.type] ?? 0),
  );
}

export function CurrentRunPanel({
  runId,
  serviceName,
  operationName,
  onClose,
  onRetried,
}: {
  readonly runId: string;
  readonly serviceName: string;
  readonly operationName: string;
  readonly onClose: () => void;
  readonly onRetried: (runId: string) => void;
}) {
  const runQuery = useRunQuery(runId);
  const status = runQuery.data?.status ?? "queued";
  const eventsQuery = useRunEventsQuery(runId, runQuery.data?.status);
  const cancelMutation = useCancelRunMutation();
  const retryMutation = useRetryRunMutation();
  const normalizedResultMutation = useRunResultMutation();
  const rawResultMutation = useRunResultMutation();
  const events = eventsQuery.data?.data ?? [];
  const progress = lifecycleProgress(status, events);
  const actionError =
    cancelMutation.error ??
    retryMutation.error ??
    normalizedResultMutation.error ??
    rawResultMutation.error;

  return (
    <section className="current-run" aria-labelledby="current-run-title">
      <header className="current-run__header">
        <div>
          <p className="workspace-eyebrow">Current collection</p>
          <h3 id="current-run-title">{operationName}</h3>
          <p>{serviceName}</p>
        </div>
        <div className="current-run__header-actions">
          <span className={`run-status run-status--${status}`}>
            {statusLabel(status)}
          </span>
          <button type="button" onClick={onClose}>
            Hide
          </button>
        </div>
      </header>

      <div className="current-run__progress">
        <div>
          <span>Lifecycle progress</span>
          <strong>{progress}%</strong>
        </div>
        <span
          className="current-run__progress-track"
          role="progressbar"
          aria-label="Collection lifecycle progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </span>
      </div>

      <div className="current-run__body">
        <div>
          {runQuery.isPending && (
            <p role="status">Loading collection status…</p>
          )}
          {runQuery.isError && (
            <>
              <p className="current-run__error" role="alert">
                {customerError(runQuery.error)}
              </p>
              <button
                type="button"
                disabled={runQuery.isFetching}
                onClick={() => void runQuery.refetch()}
              >
                Reconnect
              </button>
            </>
          )}
          {status === "failed" && (
            <p className="current-run__error" role="alert">
              {runQuery.data?.error_code === "ALL_INPUTS_FAILED"
                ? "No inputs could be collected. The collection has failed."
                : runQuery.data?.error_code === "PROVIDER_TIMEOUT"
                  ? "The collection exceeded its processing deadline."
                  : "The collection failed. Check the events for details."}
            </p>
          )}
          <ol className="current-run__events">
            {events.map((event, index) => (
              <li
                className={
                  index === events.length - 1 ? "is-current" : "is-complete"
                }
                key={event.id}
              >
                <span aria-hidden="true" />
                <div>
                  <strong>{event.message}</strong>
                  <small>{new Date(event.occurred_at).toLocaleString()}</small>
                </div>
              </li>
            ))}
          </ol>
          {eventsQuery.isFetching && <p role="status">Loading safe events…</p>}
        </div>

        <div className="current-run__actions">
          <p>
            Status and result controls stay on this page. The Runs page reads
            the same Dhumi Run and event records.
          </p>
          {actionError && (
            <p className="current-run__error" role="alert">
              {customerError(actionError)}
            </p>
          )}
          <div className="current-run__controls">
            {(status === "queued" || status === "running") && (
              <button
                className="current-run__secondary"
                type="button"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate(runId)}
              >
                {cancelMutation.isPending ? "Cancelling…" : "Cancel collection"}
              </button>
            )}
            {(status === "failed" || status === "expired") &&
              runQuery.data?.retryable && (
                <button
                  className="current-run__secondary"
                  type="button"
                  disabled={retryMutation.isPending}
                  onClick={() =>
                    retryMutation.mutate(runId, {
                      onSuccess: (run) => onRetried(run.run_id),
                    })
                  }
                >
                  {retryMutation.isPending ? "Retrying…" : "Retry collection"}
                </button>
              )}
            {status === "ready" && (
              <fieldset className="result-downloads">
                <legend className="visually-hidden">Result downloads</legend>
                <ResultDownloadControl
                  representation="normalized"
                  result={normalizedResultMutation.data}
                  isPending={normalizedResultMutation.isPending}
                  onPrepare={() =>
                    normalizedResultMutation.mutate({
                      runId,
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
                      runId,
                      representation: "raw",
                    })
                  }
                />
              </fieldset>
            )}
            <Link
              className="current-run__all-runs"
              to={organizationPath(`/workspace/runs?run=${encodeURIComponent(runId)}`)}
            >
              View all runs
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
