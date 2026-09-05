import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
  MAX_TRANSLATION_CHARACTERS,
  translationCharacterCount,
} from "@beutl/api";
import { fileFingerprint } from "../../apps/web/src/lib/ai-screen";

const translateFormSource = readFileSync(
  new URL(
    "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/translate-form.tsx",
    import.meta.url,
  ),
  "utf8",
);
const videoFormSource = readFileSync(
  new URL(
    "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/video-form.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("dashboard AI form input limits", () => {
  it("counts translation segments and glossary text against one shared limit", () => {
    const glossary = { term: "translation" };
    const segments = [{ text: "a".repeat(MAX_TRANSLATION_CHARACTERS - 20) }];

    expect(translationCharacterCount({ segments, style: { glossary } })).toBe(
      MAX_TRANSLATION_CHARACTERS - 5,
    );
    expect(translateFormSource).toContain("translationCharacterCount");
    expect(translateFormSource).toContain("translationTooLong");
    expect(translateFormSource).toContain("MAX_TRANSLATION_CHARACTERS");
    expect(
      translationCharacterCount({
        segments: [{ text: "a".repeat(MAX_TRANSLATION_CHARACTERS - 14) }],
        style: { glossary },
      }),
    ).toBe(MAX_TRANSLATION_CHARACTERS + 1);
  });

  it("does not fingerprint or block on a hidden frame after a model switch", async () => {
    const valid = new File(
      [new Uint8Array(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)],
      "valid.png",
      { type: "image/png" },
    );
    const oversized = new File(
      [new Uint8Array(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES + 1)],
      "oversized.png",
      { type: "image/png" },
    );

    expect(await fileFingerprint(valid, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)).not.toBe("");
    expect(await fileFingerprint(oversized, MAX_AI_VIDEO_FRAME_UPLOAD_BYTES)).toBe("");
    // Switching to a model without frame support makes both sent values null;
    // the form must use those effective values, not the stale picker state.
    expect(videoFormSource).toContain("const sentFirstFrame = options.firstFrame ? firstFrame : null;");
    expect(videoFormSource).toContain("const sentLastFrame =");
    expect(videoFormSource).toContain("() => [sentFirstFrame, sentLastFrame].filter");
    expect(videoFormSource).toContain("const oversizedFrame = [sentFirstFrame, sentLastFrame].some(");
    expect(videoFormSource.indexOf("const sentFirstFrame")).toBeLessThan(
      videoFormSource.indexOf("const frames = useMemo"),
    );
    expect(videoFormSource).toContain("const signature = oversizedFrame ? \"\" :");
    expect(videoFormSource).toContain("busy: isPending || readingFrames || oversizedFrame");
    expect(videoFormSource).toContain("composedPromptTooLong || oversizedFrame");
    expect(videoFormSource).toContain("oversizedFrame ||");
  });
});
