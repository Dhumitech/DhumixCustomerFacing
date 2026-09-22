import type { MarketplaceContactMode } from "../../api/generated";
import { marketplaceFieldLabel } from "./marketplaceViewModel";

interface MarketplaceContactDrawerProps {
  readonly modes: readonly MarketplaceContactMode[];
  readonly selectedMode: MarketplaceContactMode["code"] | null;
  readonly onSelectedModeChange: (
    mode: MarketplaceContactMode["code"] | null,
  ) => void;
  readonly onApply: () => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}

export function MarketplaceContactDrawer({
  modes,
  selectedMode,
  onSelectedModeChange,
  onApply,
  onReset,
  onClose,
}: MarketplaceContactDrawerProps) {
  const selectedDefinition = modes.find((mode) => mode.code === selectedMode);
  const canApply = selectedDefinition?.preview_state === "available";

  return (
    <aside
      className="sample-drawer contact-mode-drawer"
      aria-labelledby="contact-mode-title"
      aria-modal="true"
      role="dialog"
    >
      <div className="sample-drawer__heading">
        <div>
          <p className="workspace-eyebrow">LinkedIn People</p>
          <h3 id="contact-mode-title">Contact filters</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close contact filters"
        >
          ×
        </button>
      </div>

      <p className="contact-mode-drawer__intro">
        Choose the profile-data mode for this preview. Availability comes from
        Dhumi&apos;s reviewed Marketplace contract.
      </p>

      <div className="contact-mode-list">
        {modes.map((mode) => {
          const isAvailable = mode.preview_state === "available";
          const descriptionId = `contact-mode-${mode.code}-description`;
          return (
            <label
              className={`contact-mode-card${isAvailable ? " is-available" : " is-disabled"}`}
              key={mode.code}
            >
              <span className="contact-mode-card__choice">
                <input
                  type="radio"
                  name="contact-mode"
                  aria-label={marketplaceFieldLabel(mode.code)}
                  checked={mode.code === selectedMode}
                  disabled={!isAvailable}
                  onChange={() => onSelectedModeChange(mode.code)}
                  aria-describedby={descriptionId}
                />
                <strong>{marketplaceFieldLabel(mode.code)}</strong>
                <small>
                  {isAvailable ? "Available for preview" : "Not enabled"}
                </small>
              </span>
              <span id={descriptionId}>{mode.customer_meaning}</span>
              <span className="contact-mode-card__states">
                Fulfillment: {marketplaceFieldLabel(mode.fulfillment_state)}
              </span>
            </label>
          );
        })}
      </div>

      <div className="contact-mode-drawer__boundary">
        Contact-enabled choices stay disabled until their purchase and
        fulfillment contracts are approved. This selection is never sent to a
        provider by the sample APIs.
      </div>

      <div className="sample-drawer__footer sample-drawer__footer--actions">
        <button
          className="sample-secondary-action"
          type="button"
          onClick={onReset}
        >
          Reset
        </button>
        <button
          className="sample-primary-action"
          type="button"
          disabled={!canApply}
          onClick={onApply}
        >
          Apply contact filter
        </button>
      </div>
    </aside>
  );
}
