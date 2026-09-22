import { describe, expect, it } from "vitest";
import type { MarketplaceField } from "../../api/generated";
import {
  defaultMarketplaceFields,
  MARKETPLACE_DEFAULT_VISIBLE_FIELD_COUNT,
  marketplaceRowKey,
} from "./marketplaceViewModel";

function field(index: number): MarketplaceField {
  return {
    name: `field_${index}`,
    type: "text",
    active: true,
    required: false,
    description: `Field ${index}`,
    sample_visibility: "visible",
    allowed_operators: ["includes"],
  };
}

describe("Marketplace presentation model", () => {
  it("uses a readable bounded default projection in reviewed dictionary order", () => {
    const fields = Array.from({ length: 12 }, (_, index) => field(index));
    fields[2] = { ...fields[2], active: false };
    fields[4] = { ...fields[4], sample_visibility: "suppressed" };

    const selected = defaultMarketplaceFields(fields);

    expect(selected).toHaveLength(MARKETPLACE_DEFAULT_VISIBLE_FIELD_COUNT);
    expect(selected).toEqual([
      "field_0",
      "field_1",
      "field_3",
      "field_5",
      "field_6",
      "field_7",
      "field_8",
    ]);
  });

  it("does not use masked row values as React identity", () => {
    expect(marketplaceRowKey(3, 0)).not.toBe(marketplaceRowKey(3, 1));
    expect(marketplaceRowKey(3, 0)).toBe("sample-3-row-0");
  });
});
