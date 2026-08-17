import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Forgejo クライアントの組み立てを固定する。
// ここで検証しているのは「Forgejo に何をどう送るか」であって、Forgejo の挙動ではない。
// 実サーバーとの疎通は git-server/docs/local-setup.md の手順で確認する。

import {
  CREDENTIAL_NAME_MAX_LENGTH,
  ForgejoError,
  MAX_LFS_POINTER_BYTES,
  forgejoRequest,
  getForgejoConfig,
  isForgejoConfigured,
  normalizeCredentialName,
  normalizeUsername,
  parseLfsPointer,
} from "@beutl/forgejo";

const BASE_URL = "https://git.example.test";
const ADMIN_TOKEN = "admin-token";
const PROXY_SECRET = "proxy-secret";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("設定の読み取り", () => {
  beforeEach(() => {
    process.env.FORGEJO_BASE_URL = `${BASE_URL}/`;
    process.env.FORGEJO_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.FORGEJO_PROXY_SECRET = PROXY_SECRET;
  });

  afterEach(() => {
    delete process.env.FORGEJO_BASE_URL;
    delete process.env.FORGEJO_ADMIN_TOKEN;
    delete process.env.FORGEJO_PROXY_SECRET;
  });

  it("末尾のスラッシュを落とす", () => {
    expect(getForgejoConfig().baseUrl).toBe(BASE_URL);
  });

  it("どれか 1 つでも欠けたら未設定として扱う", () => {
    expect(isForgejoConfigured()).toBe(true);
    delete process.env.FORGEJO_ADMIN_TOKEN;
    expect(isForgejoConfigured()).toBe(false);
    expect(() => getForgejoConfig()).toThrow(/FORGEJO_ADMIN_TOKEN/);
  });
});

describe("リクエストの組み立て", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.FORGEJO_BASE_URL = BASE_URL;
    process.env.FORGEJO_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.FORGEJO_PROXY_SECRET = PROXY_SECRET;
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FORGEJO_BASE_URL;
    delete process.env.FORGEJO_ADMIN_TOKEN;
    delete process.env.FORGEJO_PROXY_SECRET;
  });

  it("管理トークンと Caddy 用の共有シークレットを必ず付ける", async () => {
    await forgejoRequest("/version");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE_URL}/api/v1/version`);
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe(`token ${ADMIN_TOKEN}`);
    expect(headers.get("X-Beutl-Proxy-Secret")).toBe(PROXY_SECRET);
  });

  it("sudo を渡すと Sudo ヘッダで代理実行する", async () => {
    await forgejoRequest("/user/repos", { sudo: "someone" });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Sudo")).toBe("someone");
  });

  it("basicAuth を渡したら管理トークンではなく Basic 認証にする", async () => {
    // トークン管理エンドポイントは Sudo 代理を受け付けず、本人の Basic 認証を要求する。
    await forgejoRequest("/users/someone/tokens", {
      basicAuth: { username: "someone", password: "pw" },
    });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("someone:pw")}`);
    expect(headers.get("Sudo")).toBeNull();
  });

  it("undefined のクエリパラメータは付けない", async () => {
    await forgejoRequest("/repos/a/b/commits", {
      searchParams: { page: 2, path: undefined },
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("path")).toBe(false);
  });

  it("失敗時は ForgejoError に status を残す", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

    await expect(forgejoRequest("/repos/a/b")).rejects.toMatchObject({
      status: 404,
    });
    await expect(forgejoRequest("/repos/a/b")).rejects.toBeInstanceOf(
      ForgejoError,
    );
  });

  it("409 と 422 はどちらも衝突として扱う", () => {
    expect(new ForgejoError(409, "POST", "/x", "").isConflict).toBe(true);
    expect(new ForgejoError(422, "POST", "/x", "").isConflict).toBe(true);
    expect(new ForgejoError(500, "POST", "/x", "").isConflict).toBe(false);
  });
});

describe("ユーザー名の正規化", () => {
  it("Forgejo が受け付けない文字を落とす", () => {
    expect(normalizeUsername("Yuto Terada")).toBe("yuto-terada");
    expect(normalizeUsername("ユーザー")).toBe("beutl-user");
    expect(normalizeUsername("a..b")).toBe("a..b");
    expect(normalizeUsername("--lead--")).toBe("lead");
  });

  it("記号だけの入力でも先頭・末尾に記号を残さない", () => {
    expect(normalizeUsername("---")).toBe("beutl-user");
    expect(normalizeUsername("name-")).toBe("name");
  });

  it("30 文字を超えたら切り詰める", () => {
    const long = normalizeUsername("a".repeat(60));
    expect(long).toHaveLength(30);
  });
});

describe("端末ラベルの正規化", () => {
  // Forgejo のトークン名は空白も日本語もスラッシュも受け付ける (実機で確認済み)。
  // 一方、空文字は 422、255 文字超は 500 を返すので、その手前で落とす。
  it("空白や日本語はそのまま通す", () => {
    expect(normalizeCredentialName("My MacBook Pro")).toBe("My MacBook Pro");
    expect(normalizeCredentialName("ノート PC")).toBe("ノート PC");
    expect(normalizeCredentialName("home/desktop")).toBe("home/desktop");
  });

  it("前後の空白と制御文字を落とす", () => {
    expect(normalizeCredentialName("  desktop  ")).toBe("desktop");
    expect(normalizeCredentialName("desk\u0000top\u007f")).toBe("desktop");
  });

  it("空になる入力は空文字にする (呼び出し側が弾く)", () => {
    expect(normalizeCredentialName("   ")).toBe("");
    expect(normalizeCredentialName("\u0000")).toBe("");
  });

  it("上限で切り詰めても末尾に空白を残さない", () => {
    const name = normalizeCredentialName(
      `${"a".repeat(CREDENTIAL_NAME_MAX_LENGTH - 1)} tail`,
    );
    expect(name.length).toBeLessThanOrEqual(CREDENTIAL_NAME_MAX_LENGTH);
    expect(name).toBe(name.trim());
  });
});

describe("LFS ポインタの解釈", () => {
  const pointer = [
    "version https://git-lfs.github.com/spec/v1",
    "oid sha256:9db027891f9281dcbb4ce1d4bb945710b42048470737d890b98a70f3e9860662",
    "size 12582912",
    "",
  ].join("\n");

  it("実サイズと oid を取り出す", () => {
    expect(parseLfsPointer(pointer)).toEqual({
      oid: "9db027891f9281dcbb4ce1d4bb945710b42048470737d890b98a70f3e9860662",
      size: 12582912,
    });
  });

  it("ポインタでないものは null", () => {
    expect(parseLfsPointer('{"$type":"Beutl.Project"}')).toBeNull();
    expect(parseLfsPointer("")).toBeNull();
  });

  it("size が欠けていたら null", () => {
    expect(
      parseLfsPointer(pointer.split("\n").slice(0, 2).join("\n")),
    ).toBeNull();
  });

  it("1KiB を超える入力はポインタとして扱わない", () => {
    const padded = `${pointer}${"x".repeat(MAX_LFS_POINTER_BYTES)}`;
    expect(parseLfsPointer(padded)).toBeNull();
  });
});
