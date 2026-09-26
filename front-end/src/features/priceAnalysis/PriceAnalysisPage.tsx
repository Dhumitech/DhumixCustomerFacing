import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PublicHeader } from "../../components/layout/PublicHeader";
import {
  type AnalysisRow,
  buildRows,
  type CatalogProduct,
  discoverProducts,
  isSampleStore,
  PLATFORMS,
  type PlatformId,
  pricePosition,
  productFromManualPdp,
  validatePrompt,
  validateWebsite,
  validateZip,
} from "./mockAnalysis";

type Step = "intake" | "products" | "platforms" | "dashboard";
type Phase = "running" | "partial" | "complete" | "empty";

interface FrozenRun {
  readonly id: string;
  readonly zip: string;
  readonly products: readonly CatalogProduct[];
  readonly platformIds: readonly PlatformId[];
  readonly includeOwnListings: boolean;
  readonly rows: readonly AnalysisRow[];
}

const STEPS: readonly { id: Step; label: string }[] = [
  { id: "intake", label: "Starting inputs" },
  { id: "products", label: "Your products" },
  { id: "platforms", label: "Platforms" },
  { id: "dashboard", label: "Dashboard" },
];

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function positionLabel(row: AnalysisRow): string {
  const position = pricePosition(row.customerPriceUsd, row.competitorPriceUsd);
  if (position.kind === "unavailable") {
    return "Unavailable";
  }
  const absolute = formatMoney(Math.abs(position.absolute));
  const percent = `${Math.abs(position.percent).toFixed(1)}%`;
  if (position.kind === "parity") {
    return `Parity within 5% (${absolute}, ${percent})`;
  }
  return position.absolute > 0
    ? `Higher by ${absolute} (${percent})`
    : `Lower by ${absolute} (${percent})`;
}

export function PriceAnalysisPage({
  isAuthenticated,
}: {
  readonly isAuthenticated: boolean;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("intake");
  const [website, setWebsite] = useState("");
  const [prompt, setPrompt] = useState("");
  const [zip, setZip] = useState("");
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [shortfallAccepted, setShortfallAccepted] = useState(false);
  const [manualPdp, setManualPdp] = useState("");
  const [productError, setProductError] = useState<string | null>(null);
  const [replacementById, setReplacementById] = useState<
    Record<string, string>
  >({});
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformId[]>([]);
  const [bestBuyStoreId, setBestBuyStoreId] = useState("");
  const [includeOwnListings, setIncludeOwnListings] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [run, setRun] = useState<FrozenRun | null>(null);
  const [phase, setPhase] = useState<Phase>("running");

  const sampleStore = isSampleStore(website);
  const confirmed = products.filter((product) =>
    confirmedIds.includes(product.id),
  );
  const needsShortfallAcceptance =
    products.length === 0 || (!sampleStore && products.length < 5);
  const visibleRows =
    phase === "partial"
      ? (run?.rows.slice(0, 1) ?? [])
      : phase === "complete"
        ? (run?.rows ?? [])
        : [];

  useEffect(() => {
    if (step !== "dashboard" || run === null) {
      return;
    }
    if (run.rows.length === 0) {
      setPhase("empty");
      return;
    }
    setPhase("running");
    const partialTimer = window.setTimeout(() => setPhase("partial"), 500);
    const completeTimer = window.setTimeout(() => setPhase("complete"), 1200);
    return () => {
      window.clearTimeout(partialTimer);
      window.clearTimeout(completeTimer);
    };
  }, [run, step]);

  function reviewProducts(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const websiteError = validateWebsite(website);
    const zipError = validateZip(zip);
    const promptError = validatePrompt(prompt);
    const error = websiteError ?? zipError ?? promptError;
    if (error) {
      setIntakeError(error);
      return;
    }
    setIntakeError(null);
    setProducts(discoverProducts(website));
    setConfirmedIds([]);
    setShortfallAccepted(false);
    setProductError(null);
    setStep("products");
  }

  function toggleConfirmed(productId: string): void {
    setConfirmedIds((current) => {
      if (current.includes(productId)) {
        return current.filter((id) => id !== productId);
      }
      if (current.length >= 5) {
        setProductError("Confirm at most 5 products.");
        return current;
      }
      setProductError(null);
      return [...current, productId];
    });
  }

  function removeProduct(productId: string): void {
    setProducts((current) =>
      current.filter((product) => product.id !== productId),
    );
    setConfirmedIds((current) => current.filter((id) => id !== productId));
  }

  function replaceProduct(product: CatalogProduct): void {
    const nextPdp = replacementById[product.id] ?? "";
    const error = validateWebsite(nextPdp);
    if (error) {
      setProductError(error);
      return;
    }
    const replacement = productFromManualPdp(nextPdp);
    if (!replacement) {
      setProductError("Enter a public product page.");
      return;
    }
    setProducts((current) =>
      current.map((item) =>
        item.id === product.id
          ? { ...replacement, id: product.id, name: product.name }
          : item,
      ),
    );
    setConfirmedIds((current) => current.filter((id) => id !== product.id));
    setProductError(null);
  }

  function addManualProduct(): void {
    const created = productFromManualPdp(manualPdp);
    if (!created) {
      setProductError(
        validateWebsite(manualPdp) ?? "Enter a public product page.",
      );
      return;
    }
    if (products.some((product) => product.pdp === created.pdp)) {
      setProductError("That product page is already in the review.");
      return;
    }
    if (products.length >= 5) {
      setProductError("A review can hold at most 5 products.");
      return;
    }
    setProducts((current) => [...current, created]);
    setManualPdp("");
    setProductError(null);
  }

  function continueToPlatforms(): void {
    if (confirmed.length < 1 || confirmed.length > 5) {
      setProductError("Confirm 1 to 5 products before choosing platforms.");
      return;
    }
    if (needsShortfallAcceptance && !shortfallAccepted) {
      setProductError("Accept the smaller product set, or add a product page.");
      return;
    }
    setProductError(null);
    setStep("platforms");
  }

  function togglePlatform(platformId: PlatformId): void {
    setSelectedPlatforms((current) => {
      if (current.includes(platformId)) {
        return current.filter((id) => id !== platformId);
      }
      if (current.length >= 5) {
        setPlatformError("Select at most 5 platforms.");
        return current;
      }
      setPlatformError(null);
      return [...current, platformId];
    });
  }

  function startAnalysis(): void {
    if (run) {
      setStep("dashboard");
      return;
    }
    if (selectedPlatforms.length < 1) {
      setPlatformError(
        "Select at least one platform. Choosing a platform does not start analysis.",
      );
      return;
    }
    if (selectedPlatforms.includes("bestbuy") && bestBuyStoreId.trim() === "") {
      setPlatformError("Best Buy needs a store id. A ZIP is not a store id.");
      return;
    }
    const rows = buildRows(confirmed, selectedPlatforms, includeOwnListings);
    setRun({
      id: "analysis-1",
      zip,
      products: confirmed,
      platformIds: selectedPlatforms,
      includeOwnListings,
      rows,
    });
    setPlatformError(null);
    setStep("dashboard");
  }

  function resetAnalysis(): void {
    setStep("intake");
    setProducts([]);
    setConfirmedIds([]);
    setSelectedPlatforms([]);
    setBestBuyStoreId("");
    setIncludeOwnListings(false);
    setRun(null);
    setPhase("running");
    setIntakeError(null);
    setProductError(null);
    setPlatformError(null);
  }

  return (
    <div className="analysis-page">
      <a className="skip-link" href="#analysis-main">
        Skip to main content
      </a>
      <PublicHeader
        isAuthenticated={isAuthenticated}
        onLogin={() => navigate("/sign-in")}
      />

      <main id="analysis-main" className="analysis-main">
        <ol className="analysis-steps" aria-label="Analysis progress">
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              aria-current={item.id === step ? "step" : undefined}
            >
              <span>{index + 1}</span>
              {item.label}
            </li>
          ))}
        </ol>

        {step === "intake" && (
          <section aria-labelledby="intake-title">
            <h1 id="intake-title">Start with your store, request, and ZIP.</h1>
            <p>
              Version 1 compares United States prices in USD. This preview uses
              sample data and does not call a scraper or a model.
            </p>
            <form className="analysis-form" onSubmit={reviewProducts}>
              <label>
                Website
                <input
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  autoComplete="url"
                  placeholder="https://northwind.example"
                />
              </label>
              <label>
                What should we compare?
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={4}
                  placeholder="Compare trail running shoes"
                />
              </label>
              <label>
                US ZIP
                <input
                  value={zip}
                  onChange={(event) => setZip(event.target.value)}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="02110"
                />
              </label>
              {intakeError && (
                <p className="analysis-notice" role="alert">
                  {intakeError}
                </p>
              )}
              <button className="button button--primary" type="submit">
                Review products
              </button>
            </form>
          </section>
        )}

        {step === "products" && (
          <section aria-labelledby="products-title">
            <h1 id="products-title">Confirm the products to compare.</h1>
            <p>
              {products.length === 0
                ? "No products were found. Add a product page, or correct the website."
                : sampleStore
                  ? "Sample discovery returned these products. Confirm 1 to 5."
                  : "Discovery returned fewer products than an open request. Accept that shortfall or add a product page."}
            </p>
            <ul className="analysis-cards">
              {products.map((product) => {
                const selected = confirmedIds.includes(product.id);
                return (
                  <li
                    key={product.id}
                    className={selected ? "is-selected" : undefined}
                  >
                    <div className="analysis-card__head">
                      <div>
                        <h2>{product.name}</h2>
                        <p>{product.variant}</p>
                      </div>
                      <strong>
                        {product.priceUsd === null
                          ? "Price unavailable"
                          : formatMoney(product.priceUsd)}
                      </strong>
                    </div>
                    <dl className="analysis-meta">
                      <div>
                        <dt>Identifier</dt>
                        <dd>{product.identifier}</dd>
                      </div>
                      <div>
                        <dt>Product page</dt>
                        <dd>
                          <a href={product.pdp}>{product.pdp}</a>
                        </dd>
                      </div>
                    </dl>
                    <label className="analysis-select">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleConfirmed(product.id)}
                      />
                      Confirm {product.name}
                    </label>
                    <label>
                      Replacement product page
                      <input
                        value={replacementById[product.id] ?? ""}
                        onChange={(event) =>
                          setReplacementById((current) => ({
                            ...current,
                            [product.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="analysis-card__actions">
                      <button
                        type="button"
                        className="analysis-text-button"
                        onClick={() => replaceProduct(product)}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className="analysis-text-button"
                        onClick={() => removeProduct(product.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="analysis-panel">
              <form
                className="analysis-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  addManualProduct();
                }}
              >
                <label>
                  Add a product page
                  <input
                    value={manualPdp}
                    onChange={(event) => setManualPdp(event.target.value)}
                    placeholder="https://northwind.example/products/trail-runner"
                  />
                </label>
                <button className="button button--secondary" type="submit">
                  Add product
                </button>
              </form>
              {needsShortfallAcceptance && (
                <label className="analysis-check">
                  <input
                    type="checkbox"
                    checked={shortfallAccepted}
                    onChange={(event) =>
                      setShortfallAccepted(event.target.checked)
                    }
                  />
                  Accept this smaller product set
                </label>
              )}
            </div>
            {productError && (
              <p className="analysis-notice" role="alert">
                {productError}
              </p>
            )}
            <div className="analysis-footer">
              <p>{confirmed.length} of 5 confirmed</p>
              <div className="analysis-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setStep("intake")}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={continueToPlatforms}
                >
                  Choose platforms
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "platforms" && (
          <section aria-labelledby="platforms-title">
            <h1 id="platforms-title">Choose platforms, then start analysis.</h1>
            <p>
              ZIP {zip} stays as entered. Selecting a platform does not start
              work. The next screen is the dashboard. Competitors stay read-only
              after start, with at most 3 per product.
            </p>
            <ul className="analysis-cards">
              {PLATFORMS.map((platform) => {
                const selected = selectedPlatforms.includes(platform.id);
                return (
                  <li
                    key={platform.id}
                    className={selected ? "is-selected" : undefined}
                  >
                    <label className="analysis-select">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => togglePlatform(platform.id)}
                      />
                      {platform.name}
                    </label>
                    {platform.id === "bestbuy" && selected && (
                      <label>
                        Best Buy store id
                        <input
                          value={bestBuyStoreId}
                          onChange={(event) =>
                            setBestBuyStoreId(event.target.value)
                          }
                        />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="analysis-panel">
              <p>
                ZIP <strong>{zip}</strong> stays as entered. {confirmed.length}{" "}
                product
                {confirmed.length === 1 ? "" : "s"} confirmed.
              </p>
              <label className="analysis-check">
                <input
                  type="checkbox"
                  checked={includeOwnListings}
                  onChange={(event) =>
                    setIncludeOwnListings(event.target.checked)
                  }
                />
                Include own listings (off unless you turn this on)
              </label>
              <p>
                Requested metrics: item price and stock. Missing facts stay
                unavailable.
              </p>
            </div>
            {platformError && (
              <p className="analysis-notice" role="alert">
                {platformError}
              </p>
            )}
            <div className="analysis-actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setStep("products")}
              >
                Back
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={startAnalysis}
              >
                Start analysis
              </button>
            </div>
          </section>
        )}

        {step === "dashboard" && run && (
          <section aria-labelledby="dashboard-title">
            <h1 id="dashboard-title">Analysis dashboard</h1>
            <p className={`analysis-status is-${phase}`} role="status">
              {phase === "running"
                ? "Finding competitors…"
                : phase === "partial"
                  ? "Partially updated. More results are still arriving."
                  : phase === "empty"
                    ? "No selected competitor had a verified listing. Nothing was collected, and competitors cannot be edited here."
                    : "Analysis complete. Competitors and sellers are read-only."}
            </p>
            <dl className="analysis-facts">
              <div>
                <dt>ZIP</dt>
                <dd>{run.zip}</dd>
              </div>
              <div>
                <dt>Products</dt>
                <dd>{run.products.length}</dd>
              </div>
              <div>
                <dt>Platforms</dt>
                <dd>
                  {run.platformIds
                    .map(
                      (platformId) =>
                        PLATFORMS.find((platform) => platform.id === platformId)
                          ?.name ?? platformId,
                    )
                    .join(", ") || "None"}
                </dd>
              </div>
            </dl>
            {visibleRows.length > 0 && (
              <div className="analysis-table-wrap">
                <table>
                  <caption>Read-only competitor and seller results</caption>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Competitor</th>
                      <th>Seller</th>
                      <th>Platform</th>
                      <th>Price position</th>
                      <th>Stock</th>
                      <th>Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr key={row.id}>
                        <td data-label="Product">{row.productName}</td>
                        <td data-label="Competitor">{row.competitor}</td>
                        <td data-label="Seller">{row.seller}</td>
                        <td data-label="Platform">{row.platformName}</td>
                        <td data-label="Price position">
                          {positionLabel(row)}
                        </td>
                        <td data-label="Stock">{row.stock ?? "Unavailable"}</td>
                        <td data-label="Coverage">
                          {row.coverage}
                          <a href={row.pdp}> Source</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button
              type="button"
              className="button button--secondary"
              onClick={resetAnalysis}
            >
              New analysis
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
