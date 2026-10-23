import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "../../apps/web/node_modules/react-dom/server";
import { setDbProvider } from "@beutl/db";
import {
  createSessionPrisma,
  type NativeAppAuthRecord,
} from "../stubs/session-prisma";

const staticMarkup = async (source: unknown): Promise<string> => {
  // ページ配下には async component (AuthLegalLinks) があるため legacy
  // renderer は使えない。React 19 の prerender 系に載せる。
  const stream = await renderToReadableStream(source);
  return await new Response(stream as ReadableStream<Uint8Array>).text();
};

vi.mock("@beutl/i18n", () => ({
  availableLanguages: ["ja", "en"],
  getTranslation: async () => ({ t: (key: string) => key }),
}));

const session = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/better-auth", () => ({
  auth: { api: { getSession: session.getSession } },
}));

const navigation = vi.hoisted(() => ({ redirects: [] as string[] }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    navigation.redirects.push(url);
    throw new Error(`redirect: ${url}`);
  },
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-url": "https://beutl.beditor.net/ja/account/native-auth/continue" }),
}));

vi.mock("next/image", () => ({
  default: (props: { src: string; alt?: string }) => `<img src="${props.src}" alt="${props.alt}">`,
}));

// useActionState を持つ client component はこのテストのレンダラでは扱いにく
// いため、受け取った props を記録するスタブに差し替える。関数 component の
// 戻り値は文字列でも構わないので react の import は不要。
const consentForm = vi.hoisted(() => ({ mocked: vi.fn() }));
vi.mock(
  "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/handler/components",
  () => ({
    NativeAuthConsentForm: (props: Record<string, unknown>) => {
      consentForm.mocked(props);
      return "consent-form-stub";
    },
  }),
);

import Page from "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/handler/page";
import ContinuePage from "../../apps/web/src/app/[lang]/(auth-flow)/account/native-auth/continue/page";

const row = (): NativeAppAuthRecord => ({
  id: "auth-id",
  sessionId: "native-session",
  userId: null,
  code: null,
  continueUrl: "http://localhost:43123/callback",
  codeExpires: null,
});

const langParams = (identifier: string | undefined) =>
  ({
    params: Promise.resolve({ lang: "ja" }),
    searchParams: Promise.resolve({ identifier: identifier ?? "" }),
  }) as React.ComponentProps<typeof Page>;

const consentUser = {
  id: "consenter",
  email: "me@example.com",
  name: "Me",
  image: null,
};

const consentRedirectTarget = (handlerUrl: string): string => {
  // continue 画面は挟まない。返り先は handler 自身に直結する。
  return `/ja/account/sign-in?returnUrl=${encodeURIComponent(handlerUrl)}`;
};

// 修正の核は「ハンドラーの GET 描画ではコードを発行しない」。同意カードが
// 描かれること、行への書き込みが一切ないこと (drive-by 訪問でも何も残ら
// ない)、遷移先が不健全な行は同意先にも表示しないことを HTML と DB の
// 両面で固定する。
describe("native-auth handler page", () => {
  let store: ReturnType<typeof createSessionPrisma>;
  beforeEach(() => {
    store = createSessionPrisma();
    setDbProvider(async () => store.prisma as never);
    navigation.redirects.length = 0;
    consentForm.mocked.mockClear();
    session.getSession.mockReset();
  });

  it("sends an anonymous visit to sign-in without touching the row", async () => {
    store.putNativeAppAuth(row());
    session.getSession.mockResolvedValueOnce(null);

    const visited = () => Page(langParams("auth-id"));
    await expect(visited()).rejects.toThrow(
      `redirect: ${consentRedirectTarget("/ja/account/native-auth/handler?identifier=auth-id")}`,
    );

    // GET は発行しない。行は無傷。
    const [unchanged] = store.allNativeAppAuth();
    expect(unchanged).toMatchObject({ userId: null, code: null, codeExpires: null });
  });

  it("renders the expired card when the identifier is unknown", async () => {
    session.getSession.mockResolvedValueOnce({ user: consentUser });

    const html = await staticMarkup(await Page(langParams("auth-id")));
    expect(html).toContain("auth:nativeAuth.linkExpired");
    expect(store.allNativeAppAuth()).toEqual([]);
    // 行を先に検証するため、無効な identifier ではセッション照会すら
    // 行わない (サインインへ誘導しない)。
    expect(session.getSession).not.toHaveBeenCalled();
  });

  it("shows the expired card to an anonymous visit with an unknown identifier", async () => {
    session.getSession.mockResolvedValueOnce(null);

    const html = await staticMarkup(await Page(langParams("auth-id")));
    expect(html).toContain("auth:nativeAuth.linkExpired");
    expect(navigation.redirects).toEqual([]);
    expect(session.getSession).not.toHaveBeenCalled();
  });

  it("never shows or mints a code for an unsafe stored callback", async () => {
    store.putNativeAppAuth({ ...row(), continueUrl: "https://attacker.example/" });
    session.getSession.mockResolvedValueOnce({ user: consentUser });

    const html = await staticMarkup(await Page(langParams("auth-id")));
    expect(html).toContain("auth:nativeAuth.linkExpired");
    expect(html).not.toContain("attacker.example");
    // 宛先が検証を通らない行も、セッション照会の前に落ちる。
    expect(session.getSession).not.toHaveBeenCalled();
    const [unchanged] = store.allNativeAppAuth();
    expect(unchanged).toMatchObject({ userId: null, code: null, codeExpires: null });
  });

  it("renders the consent card instead of issuing on GET", async () => {
    store.putNativeAppAuth(row());
    session.getSession.mockResolvedValueOnce({ user: consentUser });

    const html = await staticMarkup(await Page(langParams("auth-id")));
    expect(html).toContain("auth:confirmation");
    expect(html).toContain("auth:doYouWantToContinue");
    expect(html).toContain("me@example.com");
    expect(html).toContain("auth:nativeAuth.codeDestination");
    // 同意先は検証を通る宛先のみ。
    expect(html).toContain("localhost:43123");
    // 同意フォームには検証済み identifier と文言がそのまま渡る。
    expect(consentForm.mocked).toHaveBeenCalledWith({
      identifier: "auth-id",
      userId: consentUser.id,
      submitLabel: "continue",
      failureText: "auth:nativeAuth.issueFailed",
    });
    expect(html).toContain("auth:useAnotherAccount");
    // アカウント切替も continue を挟まず handler 自身へ返す。
    expect(html).toContain("sign-up?returnUrl=");
    // GET 描画にコードは出ない (ミントもされない)。
    expect(html).not.toContain("code=");
    const [unchanged] = store.allNativeAppAuth();
    expect(unchanged).toMatchObject({ userId: null, code: null, codeExpires: null });
  });

  it.each([undefined, "", ["one", "two"]])("rejects a missing or repeated identifier: %s", async (identifier) => {
    const html = await staticMarkup(await Page({
      params: Promise.resolve({ lang: "ja" }), searchParams: Promise.resolve({ identifier }),
    }));
    expect(html).toContain("auth:nativeAuth.linkExpired");
    expect(session.getSession).not.toHaveBeenCalled();
  });

  it.each([
    "/account/native-auth/handler?identifier=auth-id",
    "/ja/account/native-auth/handler?identifier=auth-id",
    "/en/account/native-auth/handler?identifier=auth-id",
    "https://beutl.beditor.net/ja/account/native-auth/handler?identifier=auth-id",
  ])("passes the old continuation route to the single consent page: %s", async (returnUrl) => {
    store.putNativeAppAuth(row());
    const destination = returnUrl.replace("https://beutl.beditor.net", "");
    await expect(ContinuePage({
      params: Promise.resolve({ lang: "ja" }), searchParams: Promise.resolve({ returnUrl }),
    })).rejects.toThrow(`redirect: ${destination}`);
    expect(session.getSession).not.toHaveBeenCalled();
    expect(store.allNativeAppAuth()[0]).toMatchObject({ userId: null, code: null });
  });

  it("retains the existing confirmation for direct loopback callbacks", async () => {
    session.getSession.mockResolvedValue({ user: consentUser });
    const html = await staticMarkup(await ContinuePage({
      params: Promise.resolve({ lang: "ja" }),
      searchParams: Promise.resolve({ returnUrl: "http://localhost:43123/callback" }),
    }));
    expect(html).toContain("auth:confirmation");
    expect(html).toContain('href="http://localhost:43123/callback"');
    expect(consentForm.mocked).not.toHaveBeenCalled();
    expect(navigation.redirects).toEqual([]);
  });
});
