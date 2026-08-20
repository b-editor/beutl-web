import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Forgejo ユーザーの採番。ここで確かめているのは、対応表と Forgejo がずれたときに
// 黙って失敗し続けないこと。

vi.mock("@beutl/db", () => ({
  // 本物は競合時に再試行する。ここでは中身をそのまま実行するだけでよい。
  startRetryableTransaction: async (fn: (tx: unknown) => unknown) =>
    await fn(undefined),
  findGitAccountByUserId: async () => existingAccount,
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
let existingAccount: {
  userId: string;
  forgejoUserId: number;
  forgejoUsername: string;
} | null = null;

const { ForgejoAccountMismatchError, ForgejoEmailInUseError, ensureGitAccount } =
  await import("@beutl/forgejo");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  profileUserName = "someone";
  existingAccount = null;
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

describe("対応表と Forgejo の照合", () => {
  beforeEach(() => {
    existingAccount = {
      userId: "u1",
      forgejoUserId: 7,
      forgejoUsername: "alex",
    };
  });

  it("id まで一致すればそのまま使う", async () => {
    fetchMock = vi.fn(async () => json({ id: 7, login: "alex" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).resolves.toMatchObject({
      forgejoUsername: "alex",
      created: false,
    });
  });

  it("同じ名前が別人になっていたら止める", async () => {
    // 2 つの DB を別の時点に復元すると起きる。名前だけ信じて Sudo すると、
    // その別人の非公開リポジトリを開き、退会時にはその人ごと消してしまう。
    fetchMock = vi.fn(async () => json({ id: 99, login: "alex" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).rejects.toBeInstanceOf(
      ForgejoAccountMismatchError,
    );
  });

  it("Forgejo 側に居なくなっていたら止める", async () => {
    fetchMock = vi.fn(async () => json({ message: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureGitAccount("u1")).rejects.toBeInstanceOf(
      ForgejoAccountMismatchError,
    );
  });
});

describe("対応表が失われた状態での退会", () => {
  it("合成メールで Forgejo 上のユーザーを引き当てる", async () => {
    // beutl-web の DB だけ古い時点に戻ると、対応表は無いが Forgejo には
    // ユーザーが残る。ここで諦めると、退会したのに端末のトークンが生き続ける。
    const { revokeGitAccess } = await import("@beutl/forgejo");
    existingAccount = null;

    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/users/search")) {
        return json({
          data: [
            {
              id: 3,
              login: "orphan",
              email: "u1@users.noreply.git.example.test",
            },
          ],
        });
      }
      if (parsed.pathname.endsWith("/admin/users/orphan/tokens")) {
        return json([{ id: 21 }]);
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeGitAccess("u1")).resolves.toBe("orphan");
    const deletes = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(String(deletes[0][0])).toContain("/admin/users/orphan/tokens/21");
  });

  it("メールが一致するユーザーが居なければ何もしない", async () => {
    const { revokeGitAccess } = await import("@beutl/forgejo");
    existingAccount = null;

    fetchMock = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeGitAccess("u1")).resolves.toBeNull();
  });
});
