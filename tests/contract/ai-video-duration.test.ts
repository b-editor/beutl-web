import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVideoDurationSeconds, videoDurationStatus } from "../../apps/web/src/lib/ai-video-duration";

describe("reading video duration in the browser", () => {
  let video: {
    duration: number; src: string; preload: string; muted: boolean; style: object;
    onloadedmetadata: (() => void) | null; onerror: (() => void) | null;
    setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>;
  };
  const file = new File(["clip"], "clip.mp4", { type: "video/mp4" });

  beforeEach(() => {
    vi.useFakeTimers();
    video = {
      duration: 2.5, src: "", preload: "", muted: false, style: {},
      onloadedmetadata: null, onerror: null,
      setAttribute: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn(),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => video), body: { appendChild: vi.fn() } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function expectReleased() {
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(video.remove).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:video-test");
    expect(vi.getTimerCount()).toBe(0);
    expect(video.onloadedmetadata).toBeNull();
    expect(video.onerror).toBeNull();
  }

  it("preserves fractional seconds and releases the element and object URL", async () => {
    const result = readVideoDurationSeconds(file, new AbortController().signal);
    expect(document.body.appendChild).toHaveBeenCalledWith(video);
    video.onloadedmetadata?.();
    await expect(result).resolves.toBe(2.5);
    expectReleased();
  });

  it.each([NaN, Infinity, 0])("reports invalid duration %s as unreadable", async (duration) => {
    video.duration = duration;
    const result = readVideoDurationSeconds(file, new AbortController().signal);
    video.onloadedmetadata?.();
    await expect(result).resolves.toBeNull();
    expectReleased();
  });

  it("releases failed metadata reads", async () => {
    const result = readVideoDurationSeconds(file, new AbortController().signal);
    video.onerror?.();
    await expect(result).resolves.toBeNull();
    expectReleased();
  });

  it("times out and ignores a late metadata event", async () => {
    const result = readVideoDurationSeconds(file, new AbortController().signal);
    const late = video.onloadedmetadata;
    await vi.advanceTimersByTimeAsync(10_000);
    late?.();
    await expect(result).resolves.toBeNull();
    expectReleased();
  });

  it("cancels an obsolete selection without leaving a video decoder alive", async () => {
    const controller = new AbortController();
    const result = readVideoDurationSeconds(file, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expectReleased();
  });

  it("does not allocate a URL for an already canceled selection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readVideoDurationSeconds(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("video duration admission for the selected files and model", () => {
  const first = new File(["clip"], "first.mp4");
  const second = new File(["clip"], "second.mp4");

  it("keeps a new file pending even when it has the previous file's name and size", () => {
    const replacement = new File(["next"], first.name);
    const durations = new Map([[first, 2.5]]);
    expect(videoDurationStatus([replacement], durations, 2, 3)).toEqual({ reading: true, error: null });
    expect(videoDurationStatus([], durations, 2, 3)).toEqual({ reading: false, error: null });
  });

  it("revalidates cached metadata when the selected model changes", () => {
    const durations = new Map([[first, 2.5]]);
    expect(videoDurationStatus([first], durations, 2, 3).error).toBeNull();
    expect(videoDurationStatus([first], durations, 3, 5).error).toMatchObject({ reason: "tooShort", limit: 3 });
    expect(videoDurationStatus([first], durations, 1, 2).error).toMatchObject({ reason: "tooLong", limit: 2 });
  });

  it("accepts exact boundaries without rounding", () => {
    expect(videoDurationStatus([first, second], new Map([[first, 2], [second, 2.2]]), 2, 2.2)).toEqual({ reading: false, error: null });
  });

  it("checks every reference and reports the offending filename", () => {
    expect(videoDurationStatus([first, second], new Map([[first, 2], [second, 2.3]]), 2, 2.2).error)
      .toEqual({ fileName: second.name, reason: "tooLong", limit: 2.2 });
    expect(videoDurationStatus([first], new Map([[first, null]]), 2, 3).error)
      .toEqual({ fileName: first.name, reason: "unreadable" });
  });
});
