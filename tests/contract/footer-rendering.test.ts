import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@beutl/i18n", () => ({ getTranslation: async () => ({ t: (key: string) => key }) }));

let Footer: typeof import("../../apps/web/src/components/footer").default;
const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = fromWeb("react-dom/server");

beforeAll(async () => {
  ({ default: Footer } = await import("../../apps/web/src/components/footer"));
});

describe("footer language links", () => {
  it("renders a fallback when middleware was skipped, as for /_next", async () => {
    state.headers = new Headers();
    const html = renderToStaticMarkup(await Footer({ lang: "ja" }));
    expect(html).toContain('href="/ja"');
    expect(html).toContain('href="/en"');
  });

  it.each(["ja", "en"])("preserves the page path when switching from %s", async (lang) => {
    state.headers = new Headers({
      "x-pathname": `/${lang}/store/ja-plugin/en-plugin`,
      "x-url": `https://beutl.example/${lang}/store/ja-plugin/en-plugin`,
    });
    const html = renderToStaticMarkup(await Footer({ lang }));
    expect(html).toContain('href="/ja/store/ja-plugin/en-plugin"');
    expect(html).toContain('href="/en/store/ja-plugin/en-plugin"');
  });
});
