import type { RunResultRepresentation } from "../../../api/customerRuns";
import type { RunResult } from "../../../api/generated";

const RESULT_COPY: Record<
  RunResultRepresentation,
  { readonly label: string; readonly description: string }
> = {
  normalized: {
    label: "Normalized JSON",
    description: "Clean, validated records prepared for everyday use.",
  },
  raw: {
    label: "Raw JSON",
    description: "The original provider response retained by Dhumi.",
  },
};

function formatBytes(byteCount: number): string {
  if (byteCount < 1_000) return `${byteCount} B`;
  if (byteCount < 1_000_000) return `${(byteCount / 1_000).toFixed(1)} KB`;
  return `${(byteCount / 1_000_000).toFixed(1)} MB`;
}

export function ResultDownloadControl({
  representation,
  result,
  isPending,
  onPrepare,
}: {
  readonly representation: RunResultRepresentation;
  readonly result: RunResult | undefined;
  readonly isPending: boolean;
  readonly onPrepare: () => void;
}) {
  const copy = RESULT_COPY[representation];
  const customerLabel = representation === "normalized" ? "normalized" : "raw";

  return (
    <article
      className={`result-download result-download--${representation}${result ? " result-download--ready" : ""}`}
    >
      <div className="result-download__copy">
        <div className="result-download__heading">
          <span aria-hidden="true" className="result-download__mark">
            {result ? "✓" : representation === "normalized" ? "N" : "R"}
          </span>
          <div>
            <strong>{copy.label}</strong>
            <p>{copy.description}</p>
          </div>
        </div>
        {result && (
          <p className="result-download__ready" role="status">
            {copy.label} is ready · {formatBytes(result.byte_count)}
          </p>
        )}
      </div>

      {result ? (
        <a
          aria-label={`Download ${customerLabel}`}
          className="result-download__action result-download__action--link"
          href={result.download_url}
        >
          <span>Download</span>
          <span aria-hidden="true">↓</span>
        </a>
      ) : (
        <button
          aria-busy={isPending}
          aria-label={`Prepare ${customerLabel} download`}
          className="result-download__action"
          type="button"
          disabled={isPending}
          onClick={onPrepare}
        >
          <span>{isPending ? "Preparing…" : "Prepare download"}</span>
          <span aria-hidden="true">{isPending ? "···" : "→"}</span>
        </button>
      )}
    </article>
  );
}
