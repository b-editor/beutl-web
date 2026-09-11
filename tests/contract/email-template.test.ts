import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailButton, sendEmail } from "@beutl/email";

type ResendPayload = {
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; content: string; content_id: string }[];
};

const fetchMock = vi.fn();

async function capture(params: Parameters<typeof sendEmail>[0]) {
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
  await sendEmail(params);
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string) as ResendPayload;
}

describe("email template", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("renders the body on the web's dark palette with header and footer", async () => {
    const { html, attachments } = await capture({
      to: "user@example.com",
      subject: "Hello",
      body: "<p>こんにちは</p>",
      lang: "ja",
    });

    // globals.css の .dark --background / --card / --primary と同じ色
    expect(html).toContain('bgcolor="#0a0911"');
    expect(html).toContain('bgcolor="#100f14"');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    // ナビバーと同じロゴ + 見出し。画像はサイトに頼らず cid: のインライン添付
    expect(html).toContain(
      '<img src="cid:beutl-email-logo" width="28" height="28" alt="" style="display: block; border: 0; width: 28px; height: 28px;">',
    );
    expect(html).toMatch(/font-weight: 600; line-height: 28px; [^>]*>[\s\S]*Beutl</);
    // フッター: SNS アイコンは白塗り PNG、規約リンクは言語別、著作権は今年まで
    for (const icon of ["github", "x", "discord"]) {
      expect(html).toContain(
        `<img src="cid:beutl-email-${icon}" width="20" height="20" alt=`,
      );
    }
    expect(attachments.map((a) => a.content_id).sort()).toEqual(
      ["beutl-email-discord", "beutl-email-github", "beutl-email-logo", "beutl-email-x"],
    );
    for (const attachment of attachments) {
      expect(attachment.content.startsWith("iVBORw0KGgo")).toBe(true); // PNG
    }
    // Gmail のダークモード反転対策: 面は gradient、文字は blend ラッパーで包む
    expect(html).toContain("background-image: linear-gradient(#100f14, #100f14)");
    // 罫線とカード枠も border ではなく gradient の面で描く (Gmail は border 色も反転する)
    expect(html).not.toMatch(/border(-top|-bottom)?: 1px solid/);
    expect(html).toContain("background-image: linear-gradient(#242329, #242329)");
    expect(html).toContain(
      '<div class="gmail-blend-screen"><div class="gmail-blend-difference"><p>こんにちは</p></div></div>',
    );
    expect(html).toContain("https://beutl.beditor.net/ja/docs/terms");
    expect(html).toContain(">利用規約<");
    expect(html).toContain(`&copy; 2020-${new Date().getFullYear()} b-editor`);
    expect(html).toContain("<p>こんにちは</p>");
  });

  it("falls back to the default language and translates footer labels", async () => {
    const { html } = await capture({
      to: "user@example.com",
      subject: "Hello",
      body: "<p>Hi</p>",
      lang: "en",
    });
    expect(html).toContain("https://beutl.beditor.net/en/docs/privacy");
    expect(html).toContain(">Privacy Policy<");
    expect(html).toContain('<html lang="en"');
  });

  it("derives a readable text/plain part from the HTML body", async () => {
    const { text } = await capture({
      to: "user@example.com",
      subject: "Hello",
      body: `
        <p>Click the button below to sign in:</p>
        ${emailButton("https://beutl.beditor.net/sign-in?token=a&b=c", "Sign in")}
      `,
    });
    expect(text).toBe(
      "Click the button below to sign in:\n\nSign in: https://beutl.beditor.net/sign-in?token=a&b=c",
    );
  });

  it("renders a primary button and escapes its label and href", () => {
    const button = emailButton('https://x.test/?q="1"', "<b>Go</b>");
    expect(button).toContain('bgcolor="#6c59f7"');
    expect(button).toContain('href="https://x.test/?q=&quot;1&quot;"');
    expect(button).toContain(">&lt;b&gt;Go&lt;/b&gt;</a>");
  });

  it("keeps buttons outside the Gmail text wrappers", async () => {
    const button = emailButton("https://x.test/", "Go");
    const { html } = await capture({
      to: "user@example.com",
      subject: "Hello",
      body: `<p>before</p>${button}<p>after</p>`,
    });
    // ボタンは色付きの面なので blend ラッパーの外に置く。前後の文字だけ包まれる。
    expect(html).toContain(
      `<div class="gmail-blend-screen"><div class="gmail-blend-difference"><p>before</p></div></div>${button}<div class="gmail-blend-screen"><div class="gmail-blend-difference"><p>after</p></div></div>`,
    );
  });
});
