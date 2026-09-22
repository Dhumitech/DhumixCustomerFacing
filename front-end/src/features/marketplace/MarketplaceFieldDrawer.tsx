import { useMemo, useState } from "react";
import type { MarketplaceField } from "../../api/generated";
import { marketplaceFieldLabel } from "./marketplaceViewModel";

interface MarketplaceFieldDrawerProps {
  readonly fields: readonly MarketplaceField[];
  readonly selectedFields: readonly string[];
  readonly defaultFields: readonly string[];
  readonly busy: boolean;
  readonly onSelectedFieldsChange: (fields: string[]) => void;
  readonly onApply: () => void;
  readonly onClose: () => void;
}

export function MarketplaceFieldDrawer({
  fields,
  selectedFields,
  defaultFields,
  busy,
  onSelectedFieldsChange,
  onApply,
  onClose,
}: MarketplaceFieldDrawerProps) {
  const [search, setSearch] = useState("");
  const matchingFields = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return fields.filter((field) =>
      `${field.name} ${field.description}`.toLocaleLowerCase().includes(query),
    );
  }, [fields, search]);

  function toggleField(name: string): void {
    onSelectedFieldsChange(
      selectedFields.includes(name)
        ? selectedFields.filter((field) => field !== name)
        : [...selectedFields, name],
    );
  }

  function moveField(name: string, direction: -1 | 1): void {
    const currentIndex = selectedFields.indexOf(name);
    const nextIndex = currentIndex + direction;
    if (
      currentIndex < 0 ||
      nextIndex < 0 ||
      nextIndex >= selectedFields.length
    ) {
      return;
    }
    const reordered = [...selectedFields];
    [reordered[currentIndex], reordered[nextIndex]] = [
      reordered[nextIndex] as string,
      reordered[currentIndex] as string,
    ];
    onSelectedFieldsChange(reordered);
  }

  return (
    <aside
      className="sample-drawer sample-fields-drawer"
      aria-labelledby="field-title"
      aria-modal="true"
      role="dialog"
    >
      <div className="sample-drawer__heading">
        <div>
          <p className="workspace-eyebrow">Table configuration</p>
          <h3 id="field-title">Customize fields</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close field editor">
          ×
        </button>
      </div>

      <label className="sample-field-search">
        <span className="visually-hidden">Search fields</span>
        <input
          type="search"
          value={search}
          placeholder="Search for a field…"
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>

      <div className="sample-fields-drawer__summary">
        <strong>{selectedFields.length} visible fields</strong>
        <button
          className="sample-fields-drawer__reset"
          type="button"
          onClick={() => onSelectedFieldsChange([...defaultFields])}
        >
          Reset recommended
        </button>
      </div>

      <div className="sample-fields-panel__list">
        {matchingFields.map((field) => {
          const selectedIndex = selectedFields.indexOf(field.name);
          const selected = selectedIndex >= 0;
          return (
            <div className="sample-field-item" key={field.name}>
              <label>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleField(field.name)}
                />
                <span>
                  <strong>{marketplaceFieldLabel(field.name)}</strong>
                  <small>
                    {field.type} · {field.sample_visibility}
                  </small>
                </span>
              </label>
              {selected && (
                <span className="sample-field-item__order">
                  <button
                    className="sample-field-item__order-button"
                    type="button"
                    aria-label={`Move ${marketplaceFieldLabel(field.name)} up`}
                    disabled={selectedIndex === 0}
                    onClick={() => moveField(field.name, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="sample-field-item__order-button"
                    type="button"
                    aria-label={`Move ${marketplaceFieldLabel(field.name)} down`}
                    disabled={selectedIndex === selectedFields.length - 1}
                    onClick={() => moveField(field.name, 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="sample-drawer__footer">
        {selectedFields.length === 0 && (
          <p role="alert">Keep at least one reviewed field visible.</p>
        )}
        <button
          className="sample-primary-action"
          type="button"
          disabled={selectedFields.length === 0 || busy}
          onClick={onApply}
        >
          {busy ? "Applying…" : "Apply table layout"}
        </button>
      </div>
    </aside>
  );
}
