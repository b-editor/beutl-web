import { describe, expect, it } from "vitest";
import {
  reduceModelDrafts,
  serializeModelDrafts,
  type AiModelDraftRow,
} from "../../apps/admin/src/lib/ai-model-draft-state";
import type { AiOperationModelSnapshot } from "../../apps/admin/src/lib/ai-configuration-changes";

const row = (overrides: Partial<AiModelDraftRow> = {}): AiModelDraftRow => ({
  modelId: "model-a",
  priceUnits: 10,
  displayName: null,
  enabled: true,
  ...overrides,
});

const snapshot = (
  overrides: Partial<AiOperationModelSnapshot> = {},
): AiOperationModelSnapshot => ({
  modelId: "model-a",
  priceUnits: 10,
  displayName: null,
  enabled: true,
  sortOrder: 0,
  updatedAt: "2026-09-06T00:00:00.000Z",
  ...overrides,
});

describe("AI model draft state", () => {
  it("keeps the first expected snapshot across a stale refresh and retry", () => {
    const baseline = [snapshot()];
    const concurrent = [
      ...baseline,
      snapshot({ modelId: "model-b", sortOrder: 1 }),
    ];
    let drafts = reduceModelDrafts(new Map(), {
      type: "set",
      operation: "image.generate",
      rows: [row({ priceUnits: 20 })],
      saved: [row()],
      snapshot: baseline,
    });

    drafts = reduceModelDrafts(drafts, {
      type: "set",
      operation: "image.generate",
      rows: [row({ priceUnits: 30 })],
      saved: concurrent.map(({ modelId, priceUnits, displayName, enabled }) => ({
        modelId,
        priceUnits,
        displayName,
        enabled,
      })),
      snapshot: concurrent,
    });

    expect(serializeModelDrafts(drafts)[0]!.expected).toEqual(baseline);
  });

  it("captures each other operation independently and clears on rebase, discard, and success", () => {
    const first = snapshot();
    const second = snapshot({ modelId: "model-b", updatedAt: "2026-09-06T00:01:00.000Z" });
    let drafts = reduceModelDrafts(new Map(), {
      type: "set",
      operation: "image.generate",
      rows: [row({ priceUnits: 20 })],
      saved: [row()],
      snapshot: [first],
    });
    drafts = reduceModelDrafts(drafts, {
      type: "set",
      operation: "video.generate",
      rows: [row({ modelId: "model-b", priceUnits: 30 })],
      saved: [],
      snapshot: [],
    });
    expect(serializeModelDrafts(drafts).map((entry) => entry.operation)).toEqual([
      "image.generate",
      "video.generate",
    ]);

    drafts = reduceModelDrafts(drafts, {
      type: "set",
      operation: "image.generate",
      rows: [row()],
      saved: [row()],
      snapshot: [first],
    });
    expect(drafts.has("image.generate")).toBe(false);
    expect(reduceModelDrafts(drafts, { type: "clear" })).toEqual(new Map());
    expect(reduceModelDrafts(
      reduceModelDrafts(new Map(), {
        type: "set",
        operation: "image.generate",
        rows: [row({ priceUnits: 20 })],
        saved: [row()],
        snapshot: [first],
      }),
      {
        type: "set",
        operation: "image.generate",
        rows: [row({ priceUnits: 10 })],
        saved: [row()],
        snapshot: [second],
      },
    ).has("image.generate")).toBe(false);
  });
});
