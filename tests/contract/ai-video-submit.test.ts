import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAiMotionVideoSubmission,
  buildAiSourceVideoSubmission,
  buildAiVideoSubmission,
} from "../../apps/web/src/lib/ai-video-submit";

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

describe("dashboard video submission from reference pictures", () => {
  const references = [
    new File(["one"], "one.png", { type: "image/png" }),
    new File(["two"], "two.png", { type: "image/png" }),
  ];

  it("sends references as repeated parts on the multipart route", () => {
    const submission = buildAiVideoSubmission({ ...base, references });

    expect(submission.operation).toBe("videos/frames");
    const body = submission.body as FormData;
    expect(body.getAll("reference[]")).toEqual(references);
    expect(body.get("firstFrame")).toBeNull();
    expect(body.get("prompt")).toBe(base.prompt);
  });

  it("keeps the order the prompt refers to them in", () => {
    const body = buildAiVideoSubmission({ ...base, references })
      .body as FormData;

    expect(
      body.getAll("reference[]").map((entry) => (entry as File).name),
    ).toEqual(["one.png", "two.png"]);
  });

  it("never sends references alongside a frame", () => {
    // The API refuses the combination outright, because a provider given both
    // ignores the references and warns. Sending them would buy a refusal.
    const firstFrame = new File(["first"], "first.png", { type: "image/png" });
    const body = buildAiVideoSubmission({ ...base, firstFrame, references })
      .body as FormData;

    expect(body.get("firstFrame")).toBe(firstFrame);
    expect(body.getAll("reference[]")).toEqual([]);
  });
});

describe("dashboard source video submission", () => {
  const source = new File(["clip"], "clip.mp4", { type: "video/mp4" });
  it.each(["edit", "extend"] as const)("uploads the source for %s", (mode) => {
    const submission = buildAiSourceVideoSubmission({ mode, prompt: "change", source, durationSeconds: 6, model: "video/model" });
    expect(submission.operation).toBe(`videos/${mode}`);
    const body = submission.body as FormData;
    expect(body.get("sourceVideo")).toBe(source);
    expect(body.get("sourceJobId")).toBeNull();
    expect(body.get("durationSeconds")).toBe(mode === "edit" ? null : "6");
  });
  it("uploads the motion source and character together", () => {
    const characterImage = new File(["face"], "face.png", { type: "image/png" });
    const submission = buildAiMotionVideoSubmission({ prompt: "walk", source, characterImage, durationSeconds: 5, orientation: "image", quality: "pro", model: "video/model" });
    expect(submission.operation).toBe("videos/motion");
    const body = submission.body as FormData;
    expect(body.get("sourceVideo")).toBe(source);
    expect(body.get("sourceJobId")).toBeNull();
    expect(body.get("characterImage")).toBe(characterImage);
    expect(body.get("orientation")).toBe("image");
    expect(body.get("quality")).toBe("pro");
  });
});
