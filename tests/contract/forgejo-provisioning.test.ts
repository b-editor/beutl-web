import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Forgejo ユーザーの採番。ここで確かめているのは、対応表と Forgejo がずれたときに
// 黙って失敗し続けないこと。

vi.mock("@beutl/db", () => ({
  // 本物は競合時に再試行する。ここでは中身をそのまま実行するだけでよい。
  startRetryableTransaction: async (fn: (tx: unknown) => unknown) =>
    await fn(undefined),
  findGitAccountByUserId: async () => null,
  findProfileForApi: async () => ({ userName: profileUserName }),
  existsGitAccountUsername: async () => false,
  createGitAccount: async (input: Record<string, unknown>) => input,
  countGitCredentials: async () => 0,
  listGitCredentialsByUserId: async () => [],
  findGitCredentialByName: async () => null,
  findGitCredential: async () => null,
  createGitCredential: async () => ({ id: "c1" }),
  deleteGitCredential: async () => undefined,
}));

let profileUserName = "someone";

const { ForgejoEmailInUseError, ensureGitAccount } = await import(
  "@beutl/forgejo"
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  profileUserName = "someone";
  process.env.FORGEJO_BASE_URL = "https://git.example.test";
  process.env.FORGEJO_ADMIN_TOKEN = "admin-token";
  process.env.FORGEJO_PROXY_SECRET = "proxy-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FORGEJO_BASE_URL;
  delete process.env.FORGEJO_ADMIN_TOKEN;
  delete process.env.FORGEJO_PROXY_SECRET;
});

describe("Forgejo ユーザーの採番", () => {
  it("ユーザー名が埋まっていれば次の候補を試す", async () => {
    let attempts = 0;
    fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return json({ message: "user already exists [name: someone]" }, 422);
      }
      return json({ id: 5, login: "someone-2" }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).resolves.toMatchObject({
      forgejoUsername: "someone-2",
      created: true,
    });
  });

  it("メールが埋まっていたら即座に諦める", async () => {
    // メールは userId から決まるので全候補で同じ。回しても同じ理由で失敗するだけで、
    // 20 回目に出るのは「ユーザー名が見つからない」という無関係なエラーになる。
    // beutl-web の DB と Forgejo が別の時点に復元されると起きる。
    fetchMock = vi.fn(async () =>
      json({ message: "e-mail already in use [email: u1@...]" }, 422),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).rejects.toBeInstanceOf(
      ForgejoEmailInUseError,
    );
    // 1 回目で判る。20 回投げない。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("記号が続く名前でも Forgejo が受け付ける形に畳む", async () => {
    // Forgejo は [-._] が 2 つ以上続く名前を 422 で拒む。畳まないと全候補が
    // 拒否され、そのユーザーは Git を一切使えない。
    profileUserName = "a__b";
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return json({ id: 6, login: body.username }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).resolves.toMatchObject({
      forgejoUsername: "a-b",
    });
  });
});
