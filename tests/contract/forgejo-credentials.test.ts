import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// git 資格情報の発行・失効が Forgejo に投げるリクエストと、レスポンスの読み取りを固定する。
//
// レスポンスの形は Forgejo 16.0.2+gitea-1.22.0 の実機で確認したもの:
//   POST /users/{u}/tokens -> {id, name, sha1(40桁), token_last_eight, scopes, created_at}
// sha1 は発行直後のレスポンスにしか入らず、末尾 8 文字は token_last_eight と一致する。

vi.mock("@beutl/db", () => ({
  findGitAccountByUserId: async () => ({
    userId: "u1",
    forgejoUserId: 2,
    forgejoUsername: "someone",
    createdAt: new Date(0),
  }),
  countGitCredentials: async () => credentialCount,
  listGitCredentialsByUserId: async () => [],
  findGitCredentialByName: async ({ name }: { name: string }) =>
    existingNames.includes(name) ? { id: "c0", name } : null,
  findGitCredential: async ({ id }: { id: string }) =>
    id === "c1"
      ? {
          id: "c1",
          userId: "u1",
          name: "desktop",
          forgejoTokenId: 42,
          lastEight: "deadbeef",
          createdAt: new Date(0),
        }
      : null,
  createGitCredential: async (input: Record<string, unknown>) => ({
    id: "c1",
    createdAt: new Date(0),
    ...input,
  }),
  deleteGitCredential: async () => undefined,
  createGitAccount: async () => {
    throw new Error("unused");
  },
  existsGitAccountUsername: async () => false,
  findProfileForApi: async () => null,
}));

let credentialCount = 0;
let existingNames: string[] = [];

const {
  CredentialLimitReachedError,
  CredentialNameInvalidError,
  CredentialNameTakenError,
  MAX_CREDENTIALS_PER_USER,
  issueGitCredential,
  revokeGitCredential,
} = await import("@beutl/forgejo");

const TOKEN = "7cc1c470aaaaaaaaaaaaaaaaaaaaaaaaaa536dad7c".slice(0, 40);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Call = { url: string; method: string; headers: Headers; body?: unknown };

function record(fetchMock: ReturnType<typeof vi.fn>): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method ?? "GET",
    headers: init?.headers as Headers,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  credentialCount = 0;
  existingNames = [];
  process.env.FORGEJO_BASE_URL = "https://git.example.test";
  process.env.FORGEJO_ADMIN_TOKEN = "admin-token";
  process.env.FORGEJO_PROXY_SECRET = "proxy-secret";

  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "PATCH" && path.startsWith("/api/v1/admin/users/")) {
      return json({});
    }
    if (init?.method === "POST" && path.endsWith("/tokens")) {
      return json(
        {
          id: 13,
          name: JSON.parse(init.body as string).name,
          sha1: TOKEN,
          token_last_eight: TOKEN.slice(-8),
          scopes: ["write:repository"],
        },
        201,
      );
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FORGEJO_BASE_URL;
  delete process.env.FORGEJO_ADMIN_TOKEN;
  delete process.env.FORGEJO_PROXY_SECRET;
});

describe("トークンの発行", () => {
  it("sha1 を平文として返し、末尾 8 文字は token_last_eight を使う", async () => {
    const issued = await issueGitCredential("u1", "desktop");

    expect(issued.token).toBe(TOKEN);
    expect(issued.username).toBe("someone");
    expect(issued.credential.lastEight).toBe(TOKEN.slice(-8));
    expect(issued.credential.name).toBe("desktop");
  });

  it("sha1 が返らなければ落とす (使えない控えを残さない)", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ id: 13, name: "desktop", scopes: [] }, 201)
        : json({}),
    );

    await expect(issueGitCredential("u1", "desktop")).rejects.toThrow(
      /returned no token/,
    );
  });

  it("既存トークンを消さない", async () => {
    await issueGitCredential("u1", "desktop");

    // ここに DELETE が現れたら、他の端末の資格情報を切る退行。
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("使い捨てパスワードを設定してから Basic 認証で発行する", async () => {
    await issueGitCredential("u1", "desktop");
    const calls = record(fetchMock);

    const patch = calls[0];
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toContain("/admin/users/someone");
    // source_id と login_name を省くと Forgejo は 422 を返す。
    expect(patch.body).toMatchObject({ source_id: 0, login_name: "someone" });
    expect(String((patch.body as { password: string }).password)).toHaveLength(
      64,
    );
    expect(patch.headers.get("Authorization")).toBe("token admin-token");

    const post = calls.at(-1)!;
    expect(post.method).toBe("POST");
    expect(post.url).toContain("/users/someone/tokens");
    // トークン管理エンドポイントは Sudo 代理を受け付けない。
    expect(post.headers.get("Sudo")).toBeNull();
    expect(post.headers.get("Authorization")).toMatch(/^Basic /);
    expect(post.body).toMatchObject({ scopes: ["write:repository"] });
  });

  it("同時操作でパスワードを追い越されたら引き直してやり直す", async () => {
    // 別の操作が先にパスワードを差し替えると、こちらの Basic 認証が 401 になる。
    let posts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return json({});
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) return new Response("unauthorized", { status: 401 });
        return json(
          {
            id: 13,
            name: "desktop",
            sha1: TOKEN,
            token_last_eight: TOKEN.slice(-8),
            scopes: [],
          },
          201,
        );
      }
      return json({});
    });

    const issued = await issueGitCredential("u1", "desktop");
    expect(issued.token).toBe(TOKEN);
    // やり直しの前にパスワードを引き直している。
    expect(record(fetchMock).filter((c) => c.method === "PATCH")).toHaveLength(
      2,
    );
  });

  it("401 が続けば諦めて投げる", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("unauthorized", { status: 401 })
        : json({}),
    );

    await expect(issueGitCredential("u1", "desktop")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("ラベルが空なら Forgejo に投げずに弾く", async () => {
    await expect(issueGitCredential("u1", "   ")).rejects.toBeInstanceOf(
      CredentialNameInvalidError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同じラベルは弾く", async () => {
    existingNames = ["desktop"];
    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialNameTakenError,
    );
  });

  it("Forgejo 側の名前衝突も同じ扱いにする", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ message: "token name has been used" }, 422)
        : json({}),
    );

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialNameTakenError,
    );
  });

  it("上限に達したら弾く", async () => {
    credentialCount = MAX_CREDENTIALS_PER_USER;
    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialLimitReachedError,
    );
  });
});

describe("トークンの失効", () => {
  it("名前ではなく Forgejo のトークン id で消す", async () => {
    const revoked = await revokeGitCredential("u1", "c1");

    expect(revoked?.name).toBe("desktop");
    const del = record(fetchMock).find((c) => c.method === "DELETE")!;
    // 名前には空白やスラッシュが入りうるので、パスには載せない。
    expect(del.url).toContain("/users/someone/tokens/42");
  });

  it("Forgejo 側に既に無くても控えを消して成功にする", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("not found", { status: 404 })
        : json({}),
    );

    await expect(revokeGitCredential("u1", "c1")).resolves.toMatchObject({
      name: "desktop",
    });
  });

  it("知らない id は null", async () => {
    await expect(revokeGitCredential("u1", "nope")).resolves.toBeNull();
  });
});
