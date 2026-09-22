import type {
  MarketplaceField,
  MarketplaceFilterGroup,
  MarketplaceFilterOperator,
  MarketplaceFilterPredicate,
} from "../../api/generated";
import { marketplaceFieldLabel } from "./marketplaceViewModel";

export const MAX_MARKETPLACE_FILTER_RULES = 4;

let filterRuleSequence = 0;

export interface MarketplaceFilterRuleDraft {
  readonly id: string;
  readonly field: string;
  readonly operator: MarketplaceFilterOperator;
  readonly value: string;
}

export function createMarketplaceFilterRule(
  fields: readonly MarketplaceField[],
): MarketplaceFilterRuleDraft {
  const field = fields[0];
  filterRuleSequence += 1;
  const operator = field?.allowed_operators.includes("includes")
    ? "includes"
    : (field?.allowed_operators[0] ?? "includes");
  return {
    id: `marketplace-filter-${filterRuleSequence}`,
    field: field?.name ?? "",
    operator,
    value: "",
  };
}

function definitionForRule(
  rule: MarketplaceFilterRuleDraft,
  fields: readonly MarketplaceField[],
): MarketplaceField | undefined {
  return fields.find((field) => field.name === rule.field);
}

export function marketplaceFilterRuleIsReady(
  rule: MarketplaceFilterRuleDraft,
  fields: readonly MarketplaceField[],
): boolean {
  const definition = definitionForRule(rule, fields);
  if (
    definition?.sample_visibility !== "visible" ||
    !definition.allowed_operators.includes(rule.operator)
  ) {
    return false;
  }
  return (
    rule.operator === "is_null" ||
    rule.operator === "is_not_null" ||
    rule.value.trim().length > 0
  );
}

function serializeRule(
  rule: MarketplaceFilterRuleDraft,
): MarketplaceFilterPredicate {
  if (rule.operator === "is_null" || rule.operator === "is_not_null") {
    return { name: rule.field, operator: rule.operator };
  }
  return {
    name: rule.field,
    operator: rule.operator,
    value:
      rule.operator === "in" || rule.operator === "not_in"
        ? rule.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : rule.value.trim(),
  };
}

export function buildMarketplaceFilter(
  rules: readonly MarketplaceFilterRuleDraft[],
  fields: readonly MarketplaceField[],
  groupOperator: MarketplaceFilterGroup["operator"],
): MarketplaceFilterPredicate | MarketplaceFilterGroup | undefined {
  if (
    rules.length === 0 ||
    rules.length > MAX_MARKETPLACE_FILTER_RULES ||
    !rules.every((rule) => marketplaceFilterRuleIsReady(rule, fields))
  ) {
    return undefined;
  }
  const predicates = rules.map(serializeRule);
  return predicates.length === 1
    ? predicates[0]
    : { operator: groupOperator, filters: predicates };
}

interface MarketplaceFilterBuilderProps {
  readonly fields: readonly MarketplaceField[];
  readonly rules: readonly MarketplaceFilterRuleDraft[];
  readonly groupOperator: MarketplaceFilterGroup["operator"];
  readonly busy: boolean;
  readonly onRulesChange: (rules: MarketplaceFilterRuleDraft[]) => void;
  readonly onGroupOperatorChange: (
    operator: MarketplaceFilterGroup["operator"],
  ) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}

export function MarketplaceFilterBuilder({
  fields,
  rules,
  groupOperator,
  busy,
  onRulesChange,
  onGroupOperatorChange,
  onApply,
  onClear,
  onClose,
}: MarketplaceFilterBuilderProps) {
  const ready =
    rules.length > 0 &&
    rules.every((rule) => marketplaceFilterRuleIsReady(rule, fields));

  function updateRule(
    id: string,
    update: (rule: MarketplaceFilterRuleDraft) => MarketplaceFilterRuleDraft,
  ): void {
    onRulesChange(rules.map((rule) => (rule.id === id ? update(rule) : rule)));
  }

  function removeRule(id: string): void {
    const remaining = rules.filter((rule) => rule.id !== id);
    onRulesChange(
      remaining.length > 0 ? remaining : [createMarketplaceFilterRule(fields)],
    );
  }

  return (
    <section className="sample-control-panel" aria-labelledby="filter-title">
      <div className="sample-control-panel__heading">
        <div>
          <p className="workspace-eyebrow">Stored-sample query</p>
          <h3 id="filter-title">Build sample filters</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close filters">
          ×
        </button>
      </div>

      <div className="sample-filter-builder__logic">
        <span>Return rows that match</span>
        <select
          aria-label="Filter group logic"
          value={groupOperator}
          disabled={rules.length < 2}
          onChange={(event) =>
            onGroupOperatorChange(
              event.currentTarget.value as MarketplaceFilterGroup["operator"],
            )
          }
        >
          <option value="and">all rules</option>
          <option value="or">any rule</option>
        </select>
        <small>Up to {MAX_MARKETPLACE_FILTER_RULES} rules</small>
      </div>

      <div className="sample-filter-rules">
        {rules.map((rule, index) => {
          const definition = definitionForRule(rule, fields);
          const operators = definition?.allowed_operators ?? [];
          const needsValue =
            rule.operator !== "is_null" && rule.operator !== "is_not_null";
          return (
            <div className="sample-filter-rule" key={rule.id}>
              <span className="sample-filter-rule__index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <label>
                <span>Field</span>
                <select
                  value={rule.field}
                  onChange={(event) => {
                    const nextField = fields.find(
                      (field) => field.name === event.currentTarget.value,
                    );
                    updateRule(rule.id, (current) => ({
                      ...current,
                      field: event.currentTarget.value,
                      operator: nextField?.allowed_operators.includes(
                        "includes",
                      )
                        ? "includes"
                        : (nextField?.allowed_operators[0] ?? current.operator),
                      value: "",
                    }));
                  }}
                >
                  {fields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {marketplaceFieldLabel(field.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Condition</span>
                <select
                  value={rule.operator}
                  disabled={operators.length === 0}
                  onChange={(event) =>
                    updateRule(rule.id, (current) => ({
                      ...current,
                      operator: event.currentTarget
                        .value as MarketplaceFilterOperator,
                      value: "",
                    }))
                  }
                >
                  {operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              {needsValue ? (
                <label className="sample-filter-rule__value">
                  <span>Value</span>
                  <input
                    value={rule.value}
                    inputMode={
                      definition?.type === "number" ? "decimal" : undefined
                    }
                    onChange={(event) =>
                      updateRule(rule.id, (current) => ({
                        ...current,
                        value: event.currentTarget.value,
                      }))
                    }
                    placeholder={
                      rule.operator === "in" || rule.operator === "not_in"
                        ? "Separate values with commas"
                        : "Enter a sample value"
                    }
                  />
                </label>
              ) : (
                <span className="sample-filter-rule__no-value">
                  No value needed
                </span>
              )}
              <button
                className="sample-filter-rule__remove"
                type="button"
                aria-label={`Remove filter rule ${index + 1}`}
                onClick={() => removeRule(rule.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="sample-control-panel__footer">
        <button
          className="sample-add-rule"
          type="button"
          disabled={
            rules.length >= MAX_MARKETPLACE_FILTER_RULES || fields.length === 0
          }
          onClick={() =>
            onRulesChange([...rules, createMarketplaceFilterRule(fields)])
          }
        >
          + Add rule
        </button>
        <span className="sample-control-panel__spacer" />
        <button
          className="sample-secondary-action"
          type="button"
          aria-label="Clear"
          onClick={onClear}
        >
          Clear all
        </button>
        <button
          className="sample-primary-action"
          type="button"
          aria-label="Apply filter"
          disabled={busy || !ready}
          onClick={onApply}
        >
          {busy ? "Applying…" : "Apply filters"}
        </button>
      </div>
      <p>
        These rules query only Dhumi&apos;s governed stored sample. They never
        request provider data or create a purchase.
      </p>
    </section>
  );
}
