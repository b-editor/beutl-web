import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAiVideoSubmission } from "../../apps/web/src/lib/ai-video-submit";

const base = {
  prompt: "Waves crossing a quiet shore",
  durationSeconds: 4,
  resolution: "720p",
  aspectRatio: "16:9",
  generateAudio: true,
  model: "video/model-a",
  seedEnabled: true,
  seedText: "01",
  firstFrame: null,
  lastFrame: null,
};

describe("dashboard video submission", () => {
  it("builds a normalized JSON request when no frame is selected", () => {
    const submission = buildAiVideoSubmission(base);

    expect(submission.operation).toBe("videos");
    expect(JSON.parse(submission.body as string)).toEqual({
      prompt: base.prompt,
      durationSeconds: 4,
      resolution: "720p",
      aspectRatio: "16:9",
      generateAudio: true,
      model: "video/model-a",
      seed: 1,
    });
  });

  it("builds multipart data with the selected frame objects", () => {
    const firstFrame = new File(["first"], "first.png", { type: "image/png" });
    const lastFrame = new File(["last"], "last.png", { type: "image/png" });
    const submission = buildAiVideoSubmission({
      ...base,
      firstFrame,
      lastFrame,
    });

    expect(submission.operation).toBe("videos/frames");
    const body = submission.body as FormData;
    expect(body.get("prompt")).toBe(base.prompt);
    expect(body.get("seed")).toBe("1");
    expect(body.get("firstFrame")).toBe(firstFrame);
    expect(body.get("lastFrame")).toBe(lastFrame);
  });

  it.each([
    ["text", null],
    ["frames", new File(["first"], "first.png", { type: "image/png" })],
  ])("omits a stale disabled seed from %s requests", (_kind, firstFrame) => {
    const submission = buildAiVideoSubmission({
      ...base,
      seedEnabled: false,
      seedText: "42",
      firstFrame,
    });

    if (typeof submission.body === "string") {
      expect(JSON.parse(submission.body)).not.toHaveProperty("seed");
    } else {
      expect(submission.body.has("seed")).toBe(false);
    }
  });

  it("preserves an invalid enabled seed so the API can reject it before charging", () => {
    const submission = buildAiVideoSubmission({ ...base, seedText: "1.5" });

    expect(JSON.parse(submission.body as string)).toHaveProperty("seed", 1.5);
  });

  it("uses a cancellable route request instead of a Server Action", () => {
    const source = readFileSync(
      new URL(
        "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/video-form.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const actions = readFileSync(
      new URL(
        "../../apps/web/src/app/[lang]/(dashboard)/dashboard/ai/actions.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("runAiRequest<VideoJobResponse>");
    expect(source).toContain("signal: controller.signal");
    expect(source).toContain("activeRequestRef.current?.abort()");
    expect(source).toContain("submittingRef.current");
    expect(source).toContain('<form method="post"');
    expect(source).toMatch(/disabled=\{[\s\S]*?!names\.ready/);
    expect(source).not.toContain("useActionState");
    expect(source).not.toContain("createVideoAction");
    expect(actions).not.toContain("export async function createVideoAction");
  });
});
