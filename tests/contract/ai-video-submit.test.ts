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
  const sourceJobId = "8f2a1c3e-0b4d-4f6a-9c8e-1d2b3a4c5d6e";
  const fromJob = { kind: "job", jobId: sourceJobId } as const;
  const sourceFile = new File(["clip"], "clip.mp4", { type: "video/mp4" });
  const fromFile = { kind: "file", file: sourceFile } as const;

  it("names no length for an edit", () => {
    // An edit answers with something as long as its source, and the API
    // refuses a request that names a length it cannot honour.
    const submission = buildAiSourceVideoSubmission({
      mode: "edit",
      prompt: "Make it rain",
      source: fromJob,
      durationSeconds: 6,
      model: "video/model-a",
    });

    expect(submission.operation).toBe("videos/edit");
    expect(JSON.parse(submission.body as string)).toEqual({
      prompt: "Make it rain",
      sourceJobId,
      model: "video/model-a",
    });
  });

  it("carries the added segment's length for an extension", () => {
    const submission = buildAiSourceVideoSubmission({
      mode: "extend",
      prompt: "The wave breaks",
      source: fromJob,
      durationSeconds: 6,
      model: "video/model-a",
    });

    expect(submission.operation).toBe("videos/extend");
    expect(JSON.parse(submission.body as string)).toEqual({
      prompt: "The wave breaks",
      sourceJobId,
      durationSeconds: 6,
      model: "video/model-a",
    });
  });

  it("sends a chosen file as multipart on the same route", () => {
    // A video from disk is what makes an arbitrary clip usable. The API tells
    // the two shapes apart by the content type, so the route does not change.
    const submission = buildAiSourceVideoSubmission({
      mode: "extend",
      prompt: "The wave breaks",
      source: fromFile,
      durationSeconds: 6,
      model: "video/model-a",
    });

    expect(submission.operation).toBe("videos/extend");
    const body = submission.body as FormData;
    expect(body.get("sourceVideo")).toBe(sourceFile);
    expect(body.get("sourceJobId")).toBeNull();
    expect(body.get("durationSeconds")).toBe("6");
  });

  it("names no length for an uploaded edit either", () => {
    const body = buildAiSourceVideoSubmission({
      mode: "edit",
      prompt: "Make it rain",
      source: fromFile,
      durationSeconds: 6,
      model: "video/model-a",
    }).body as FormData;

    expect(body.get("sourceVideo")).toBe(sourceFile);
    expect(body.get("durationSeconds")).toBeNull();
  });

  it("sends the character picture with the motion request", () => {
    const characterImage = new File(["face"], "face.png", {
      type: "image/png",
    });
    const submission = buildAiMotionVideoSubmission({
      prompt: "Walk toward the camera",
      source: fromJob,
      characterImage,
      durationSeconds: 5,
      orientation: "image",
      quality: "pro",
      model: "video/model-b",
    });

    expect(submission.operation).toBe("videos/motion");
    const body = submission.body as FormData;
    expect(body.get("characterImage")).toBe(characterImage);
    expect(body.get("sourceJobId")).toBe(sourceJobId);
    expect(body.get("durationSeconds")).toBe("5");
    expect(body.get("orientation")).toBe("image");
    expect(body.get("quality")).toBe("pro");
    expect(body.get("model")).toBe("video/model-b");
  });

  it("names exactly one source on a motion request", () => {
    // The API refuses a request naming both, because which of them was paid
    // for would otherwise depend on which branch ran first.
    const characterImage = new File(["face"], "face.png", {
      type: "image/png",
    });
    const body = buildAiMotionVideoSubmission({
      prompt: "Walk toward the camera",
      source: fromFile,
      characterImage,
      durationSeconds: 5,
      orientation: "video",
      quality: "standard",
      model: "video/model-b",
    }).body as FormData;

    expect(body.get("sourceVideo")).toBe(sourceFile);
    expect(body.get("sourceJobId")).toBeNull();
  });
});
