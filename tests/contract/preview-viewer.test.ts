// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../apps/web/node_modules/react";
import { createRoot, type Root } from "../../apps/web/node_modules/react-dom/client";
import type { PreviewUpdate } from "../../apps/web/src/features/preview/connection";

const session = vi.hoisted(() => ({ update: (_update: PreviewUpdate) => {}, control: vi.fn() }));
vi.mock("../../apps/web/src/features/preview/connection", () => ({
  PreviewConnection: class {
    constructor(_video: HTMLVideoElement, _path: string, update: typeof session.update) { session.update = update; }
    async connect() {
      session.update({ type: "connected" });
      session.update({ type: "playback", enabled: true, duration: 120 });
    }
    close() {}
    control(...args: unknown[]) { return session.control(...args); }
  },
}));
vi.mock("@beutl/ui/i18n-client", () => ({
  useTranslation: () => ({ i18n: { getFixedT: () => (key: string) => key } }),
}));

import { PreviewViewer } from "../../apps/web/src/features/preview/viewer";

describe("preview viewer interaction", () => {
  let container: HTMLDivElement;
  let root: Root;
  const element = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const hidden = () => element("controls").hasAttribute("inert");
  const click = (id: string) => act(() => element(id).click());
  const idle = () => act(() => vi.advanceTimersByTime(3000));
  const property = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { configurable: true, writable: true, value });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    session.control.mockReset().mockResolvedValue(true);
    property(document, "fullscreenElement", null);
    property(document, "fullscreenEnabled", false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(() => root.render(createElement(PreviewViewer, { lang: "en", basePath: "/preview/test/" })));
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    for (const key of ["fullscreenElement", "fullscreenEnabled", "exitFullscreen"])
      Reflect.deleteProperty(document, key);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("hides on a tap and after inactivity while playing=%s", async playing => {
    await act(() => session.update({ type: "playback", playing }));
    await click("frame");
    expect(hidden()).toBe(true);
    await click("frame");
    expect(hidden()).toBe(false);
    await act(() => vi.advanceTimersByTime(2000));
    await act(() => session.update({ type: "playback", position: 2 }));
    await act(() => vi.advanceTimersByTime(1000));
    expect(hidden()).toBe(true);
    await click("frame");
    expect(hidden()).toBe(false);
  });

  it("keeps controls available during a command and starts the timer after it finishes", async () => {
    let finish!: (ok: boolean) => void;
    session.control.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await click("play");
    await idle();
    expect(hidden()).toBe(false);
    await act(() => finish(true));
    await idle();
    expect(hidden()).toBe(true);
    expect(element("viewer").tabIndex).toBe(0);
    await act(() => element("viewer").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(hidden()).toBe(false);
  });

  it("restarts the hide timer when an audio prompt reveals the controls", async () => {
    await idle();
    expect(hidden()).toBe(true);
    await act(() => session.update({ type: "audioFailed" }));
    expect(hidden()).toBe(false);
    await idle();
    expect(hidden()).toBe(true);
  });

  it("uses the iPhone video API and follows native fullscreen entry and exit", async () => {
    const video = element("frame");
    const enter = vi.fn();
    const unsupportedContainer = vi.fn().mockRejectedValue(new Error("Unsupported"));
    property(video, "webkitEnterFullscreen", enter);
    property(element("viewer"), "requestFullscreen", unsupportedContainer);
    await click("fullscreen");
    expect(enter).toHaveBeenCalledOnce();
    expect(unsupportedContainer).not.toHaveBeenCalled();
    await act(() => video.dispatchEvent(new Event("webkitbeginfullscreen")));
    expect(element("fullscreen").getAttribute("aria-label")).toBe("preview:exitFullscreen");
    await idle();
    await act(() => video.dispatchEvent(new Event("webkitendfullscreen")));
    expect(element("fullscreen").getAttribute("aria-label")).toBe("preview:fullscreen");
    expect(hidden()).toBe(false);
  });

  it("uses container fullscreen when available and follows browser exits", async () => {
    const enterVideo = vi.fn();
    property(element("frame"), "webkitEnterFullscreen", enterVideo);
    property(document, "fullscreenEnabled", true);
    const change = (target: Element | null) => {
      property(document, "fullscreenElement", target);
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    const enter = vi.fn(async () => change(element("viewer")));
    const exit = vi.fn(async () => change(null));
    property(element("viewer"), "requestFullscreen", enter);
    property(document, "exitFullscreen", exit);
    await click("fullscreen");
    expect(enter).toHaveBeenCalledOnce();
    expect(enterVideo).not.toHaveBeenCalled();
    expect(element("fullscreen").getAttribute("aria-label")).toBe("preview:exitFullscreen");
    await click("fullscreen");
    expect(exit).toHaveBeenCalledOnce();
    await click("fullscreen");
    await act(() => change(null));
    expect(element("fullscreen").getAttribute("aria-label")).toBe("preview:fullscreen");
  });

  it("does not claim to be fullscreen when the browser rejects it", async () => {
    property(element("frame"), "webkitEnterFullscreen", () => { throw new Error("Not ready"); });
    await click("fullscreen");
    expect(element("fullscreen").getAttribute("aria-label")).toBe("preview:fullscreen");
    expect(element("connection").textContent).toBe("preview:fullscreenFailed");
    expect(hidden()).toBe(false);
  });
});
