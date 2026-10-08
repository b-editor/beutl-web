import { describe, expect, it } from "vitest";
import { contentImageSources } from "../../apps/web/src/lib/content-image";

describe("stored image preview URLs", () => {
  it("creates thumbnail or preview requests without mutating the original download URL", () => {
    const file = { url: "/api/contents/private-file?existing=1" };
    const thumbnail = contentImageSources(file.url, "thumbnail");
    const preview = contentImageSources(file.url, "preview");
    expect(thumbnail.src).toBe("/api/contents/private-file?existing=1&image=thumbnail-320");
    expect(thumbnail.srcSet).toContain("image=thumbnail-640 2x");
    expect(preview.src).toBe("/api/contents/private-file?existing=1&image=preview-1024");
    expect(preview.srcSet).toContain("image=preview-2048 2x");
    expect(file.url).toBe("/api/contents/private-file?existing=1");
  });

  it.each([
    "blob:https://beutl.example/local-upload",
    "data:image/png;base64,AA==",
    "/api/repositories/repo-1/content?path=image.png",
    "https://provider.example/result.png?signature=original",
  ])("leaves a browser-local or other-source image unchanged: %s", (src) => {
    expect(contentImageSources(src, "preview")).toEqual({ src });
  });

  it("supports the absolute content URLs returned by AI actions", () => {
    const src = "https://beutl.example/api/contents/ai-file";
    const preview = contentImageSources(src, "preview");
    expect(preview.src).toBe(`${src}?image=preview-1024`);
    expect(preview.srcSet).toBe(`${src}?image=preview-1024 1x, ${src}?image=preview-2048 2x`);
  });
});
