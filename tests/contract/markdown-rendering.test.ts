// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { Markdown } from "@beutl/ui/ui/markdown";

function render(markdown: string) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(createElement(Markdown, null, markdown));
  return container;
}

describe("user-authored Markdown", () => {
  it("renders headings, emphasis, lists, quotes, code and images", () => {
    const container = render(
      [
        "# Package guide",
        "",
        "**Bold** and *italic* with `inline code`.",
        "",
        "- First item",
        "- Second item",
        "",
        "> Quoted text",
        "",
        "```js",
        "const safe = '<script>';",
        "```",
        "",
        "![Screenshot](https://example.com/screenshot.png)",
      ].join("\n"),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Package guide");
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toContain("Quoted text");
    expect(container.querySelector("pre code")?.textContent).toBe("const safe = '<script>';\n");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/screenshot.png",
    );
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Screenshot");
  });

  it("renders GFM tables, task lists, strikethrough and autolinks", () => {
    const container = render(
      [
        "| Change | Status |",
        "| --- | --- |",
        "| Markdown | Ready |",
        "",
        "- [x] Fixed",
        "- [ ] Pending",
        "",
        "~~Removed~~",
        "",
        "https://example.com/docs",
      ].join("\n"),
    );
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelector("td")?.textContent).toBe("Markdown");
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...checkboxes].map((input) => [input.checked, input.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(container.querySelector("del")?.textContent).toBe("Removed");
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("preserves single line breaks in existing plain-text descriptions", () => {
    const container = render("First line\nSecond line\n\nAnother paragraph");
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector("p")?.querySelectorAll("br")).toHaveLength(1);
  });

  it("skips embedded HTML instead of creating executable elements", () => {
    const container = render(
      [
        "<script>alert('xss')</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        '<iframe src="https://example.com"></iframe>',
        "",
        "Safe **Markdown**",
      ].join("\n"),
    );
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(container.querySelector("[onerror], [onclick]")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("Markdown");
  });

  it.each([
    "javascript:alert%281%29",
    "vbscript:msgbox%281%29",
    "data:text/html;base64,PHNjcmlwdD4=",
  ])("filters unsafe link and image URLs: %s", (url) => {
    const container = render(`[Unsafe](${url})\n\n![Unsafe image](${url})`);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Unsafe image");
  });

  it("keeps relative links and in-page anchors usable", () => {
    const container = render("[Docs](/en/docs) and [Details](#details)");
    const links = container.querySelectorAll("a");
    expect(links[0].getAttribute("href")).toBe("/en/docs");
    expect(links[1].getAttribute("href")).toBe("#details");
    expect(links[1].getAttribute("target")).toBeNull();
  });
});
