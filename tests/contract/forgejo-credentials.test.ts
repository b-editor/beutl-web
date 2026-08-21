import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// git 資格情報の発行・失効が Forgejo に投げるリクエストと、レスポンスの読み取りを固定する。
//
// レスポンスの形は Forgejo 16.0.2+gitea-1.22.0 の実機で確認したもの:
//   POST /admin/users/{u}/tokens -> {id, name, sha1(40桁), token_last_eight, scopes, created_at}
// sha1 は発行直後のレスポンスにしか入らず、末尾 8 文字は token_last_eight と一致する。
//
// /admin/ を通すのは、/users/{u}/tokens の方が書き込みに対象ユーザー自身の Basic 認証を
// 要求するため (管理トークンでも Sudo でも 401 auth method not allowed)。

vi.mock("@beutl/db", () => ({
  // 退会処理の墓標。既定では「退会していない」。
  findGitAccountDeletion: async () => {
    const value = pendingDeletion;
    // 発行の途中で退会が始まる状況を作るための仕掛け。
    if (deletionStartsAfterFirstCheck) {
      pendingDeletion = {
        userId: "u1",
        phase: "BLOCKING",
        forgejoUserId: 2,
        forgejoUsername: "someone",
      };
      deletionStartsAfterFirstCheck = false;
    }
    return value;
  },
  startGitAccountDeletion: async ({ intentId }: { intentId: string }) => {
    // 先に立てた方が勝つ。後から来た方には相手の id と owned:false を返す。
    if (deletionIntentOwner === null) deletionIntentOwner = intentId;
    return {
      intentId: deletionIntentOwner,
      owned: deletionIntentOwner === intentId,
    };
  },
  setGitAccountDeletionTarget: async () => undefined,
  markGitAccountDeletionReady: async () => undefined,
  claimGitAccountDeletion: async () => true,
  markGitAccountDeletionNeedsReview: async () => {
    neededReview = true;
  },
  cancelPendingGitAccountDeletion: async () => {
    pendingDeletion = null;
  },
  deleteGitAccountDeletion: async () => {
    pendingDeletion = null;
  },
  listPendingGitAccountDeletions: async () => [],
  recordGitAccountDeletionAttempt: async () => undefined,
  GitAccountDeletionPhase: {
    BLOCKING: "BLOCKING",
    READY_TO_PURGE: "READY_TO_PURGE",
    NEEDS_REVIEW: "NEEDS_REVIEW",
  },
  // 本物は競合時に再試行する。ここでは中身をそのまま実行するだけでよい。
  startRetryableTransaction: async (fn: (tx: unknown) => unknown) =>
    await fn(undefined),
  findGitAccountByUserId: async () => ({
    userId: "u1",
    forgejoUserId: 2,
    forgejoUsername: "someone",
    createdAt: new Date(0),
  }),
  countGitCredentials: async () => {
    const value = credentialCount;
    // 2 回目以降 (トランザクションの中) は別の値を返せるようにして、
    // 検査から書き込みまでの間に他の発行が入った状況を作る。
    if (credentialCountAfterIssue !== null) {
      credentialCount = credentialCountAfterIssue;
    }
    return value;
  },
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
  createGitCredential: async (input: Record<string, unknown>) => {
    if (dbInsertFails) {
      throw Object.assign(new Error("unique constraint"), { code: "P2002" });
    }
    return { id: "c1", createdAt: new Date(0), ...input };
  },
  deleteGitCredential: async () => undefined,
  createGitAccount: async () => {
    throw new Error("unused");
  },
  existsGitAccountUsername: async () => false,
  findProfileForApi: async () => null,
}));

let pendingDeletion:
  | {
      userId: string;
      phase: string;
      forgejoUserId: number | null;
      forgejoUsername?: string | null;
    }
  | null = null;
let deletionStartsAfterFirstCheck = false;
let deletionIntentOwner: string | null = null;
let neededReview = false;
let credentialCount = 0;
let credentialCountAfterIssue: number | null = null;
let existingNames: string[] = [];
let dbInsertFails = false;

const {
  CredentialLimitReachedError,
  CredentialNameInvalidError,
  CredentialNameTakenError,
  MAX_CREDENTIALS_PER_USER,
  issueGitCredential,
  GitAccountBeingDeletedError,
  GitAccountDeletionInProgressError,
  beginGitAccountDeletion,
  finishGitAccountDeletion,
  revokeGitCredential,
} = await import("@beutl/forgejo");

const TOKEN = "7cc1c470aaaaaaaaaaaaaaaaaaaaaaaaaa536dad7c".slice(0, 40);
// 対応表の照合に使う合成メール (userId + FORGEJO_BASE_URL のホスト)。
const EMAIL = "u1@users.noreply.git.example.test";

const { GITATTRIBUTES_TEMPLATE: GITATTRIBUTES, GITIGNORE_TEMPLATE: GITIGNORE } =
  await import("@beutl/forgejo");

// テンプレートには日本語のコメントが入る。btoa は Latin-1 しか受け付けない。
function utf8Base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

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
  pendingDeletion = null;
  deletionStartsAfterFirstCheck = false;
  deletionIntentOwner = null;
  neededReview = false;
  credentialCount = 0;
  credentialCountAfterIssue = null;
  existingNames = [];
  dbInsertFails = false;
  process.env.FORGEJO_BASE_URL = "https://git.example.test";
  process.env.FORGEJO_ADMIN_TOKEN = "admin-token";
  process.env.FORGEJO_PROXY_SECRET = "proxy-secret";

  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    // ensureGitAccount は対応表の id が Forgejo と一致するかを確かめる。
    if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
      return json({ id: 2, login: "someone", email: EMAIL });
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
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return json({ id: 13, name: "desktop", scopes: [] }, 201);
      }
      return json({ id: 2, login: "someone", email: EMAIL });
    });

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

  it("管理トークンで /admin/users/{u}/tokens に発行させる", async () => {
    await issueGitCredential("u1", "desktop");
    const post = record(fetchMock).find((c) => c.method === "POST")!;

    // /users/{u}/tokens の方は書き込みに対象ユーザーの Basic 認証を要求し、
    // 管理トークンでも Sudo でも 401 になる。/admin/ 側は管理トークンで通る。
    expect(post.url).toContain("/admin/users/someone/tokens");
    expect(post.headers.get("Authorization")).toBe("token admin-token");
    expect(post.body).toMatchObject({ scopes: ["write:repository"] });
  });

  it("ユーザーのパスワードを触らない", async () => {
    await issueGitCredential("u1", "desktop");

    // 以前は発行のたびにパスワードを振り直していた。同じユーザーの操作が
    // 同時に走ると互いの認証を壊すので、二度と戻さない。
    expect(record(fetchMock).filter((c) => c.method === "PATCH")).toHaveLength(
      0,
    );
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
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ message: "token name has been used" }, 422);
      return json({ id: 2, login: "someone", email: EMAIL });
    });

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialNameTakenError,
    );
  });

  it("名前衝突の 400 も衝突として扱う", async () => {
    // Forgejo 16.0.2 が実際に返すのはこれ。409 でも 422 でもない。
    // 見落とすと画面は unknown error、API は 500 になる。
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ message: "access token name has been used already" }, 400);
      return json({ id: 2, login: "someone", email: EMAIL });
    });

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialNameTakenError,
    );
  });

  it("名前と関係ない 400 は衝突にしない", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ message: "invalid scope" }, 400)
        : json({}),
    );

    await expect(issueGitCredential("u1", "desktop")).rejects.not.toBeInstanceOf(
      CredentialNameTakenError,
    );
  });

  it("控えを書けなかったら Forgejo 側のトークンを消す", async () => {
    // 同じラベルで同時に発行すると、Forgejo には 2 本できて片方が DB の
    // ユニーク制約で落ちる。控えに残らないトークンを置き去りにしない。
    dbInsertFails = true;

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialNameTakenError,
    );

    const del = record(fetchMock).find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/users/someone/tokens/13");
  });

  it("退会処理が始まっていたら発行しない", async () => {
    // 失効の後・purge の前に 1 本作られると、それだけが退会後も生き残る。
    pendingDeletion = {
      userId: "u1",
      phase: "BLOCKING",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      GitAccountBeingDeletedError,
    );
    // Forgejo には一切触らない。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("発行の途中で退会が始まったら、作ったトークンを畳んで断る", async () => {
    // 発行の前だけ見ていると、検査から発行までの間に始まった退会をすり抜ける。
    // その 1 本は失効の走査に間に合わず、退会後も生き残る。
    deletionStartsAfterFirstCheck = true;

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      GitAccountBeingDeletedError,
    );

    // 作ったものは置き去りにしない。
    const del = record(fetchMock).find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/admin/users/someone/tokens/13");
  });

  it("上限に達したら弾く", async () => {
    credentialCount = MAX_CREDENTIALS_PER_USER;
    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialLimitReachedError,
    );
  });

  it("検査を通った後で埋まっていたら、控えを書かずに Forgejo 側も畳む", async () => {
    // 19 本の状態で違う名前の発行が同時に走ると、両方が最初の検査を通って
    // 21 本になりうる。控えを書くところで数え直して弾く。
    credentialCount = MAX_CREDENTIALS_PER_USER - 1;
    credentialCountAfterIssue = MAX_CREDENTIALS_PER_USER;

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeInstanceOf(
      CredentialLimitReachedError,
    );

    // 名前の重複と取り違えない。かつ発行済みトークンを置き去りにしない。
    const del = record(fetchMock).find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/users/someone/tokens/13");
  });
});

describe("リポジトリの作成", () => {
  it("テンプレートを入れられなかったら、消さずに入れ直す", async () => {
    // 外から作られたリポジトリを消す判断は安全に下せない。作成の 201 と
    // 「作成直後の状態」を原子的に得る手段が無く、空に見えるだけの誰かの
    // リポジトリを消しかねない。足りないものを入れ直す方に倒す。
    const { createRepository } = await import("@beutl/forgejo");
    let commitAttempts = 0;
    let repoLookups = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/user/repos")) {
        return json({ id: 1, name: "proj", default_branch: "main" }, 201);
      }
      if (init?.method === "POST" && path.endsWith("/contents")) {
        commitAttempts += 1;
        return json({ message: "boom" }, 500);
      }
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        repoLookups += 1;
        if (repoLookups === 1) return json({ message: "not found" }, 404);
        return json({ id: 1, name: "proj", default_branch: "main" });
      }
      if (path.includes("/contents/.git")) {
        return json({ message: "not found" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    // 消さない。入れ直しを試みる。
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
    expect(commitAttempts).toBeGreaterThan(1);
  });

  it("入れ直す相手が別のリポジトリになっていたら触らない", async () => {
    const { createRepository } = await import("@beutl/forgejo");
    let commitAttempts = 0;
    let repoLookups = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/user/repos")) {
        return json({ id: 1, name: "proj", default_branch: "main" }, 201);
      }
      if (init?.method === "POST" && path.endsWith("/contents")) {
        commitAttempts += 1;
        return json({ message: "boom" }, 500);
      }
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        repoLookups += 1;
        if (repoLookups === 1) return json({ message: "not found" }, 404);
        // リネームされて空いた名前に別のものが入った。
        return json({ id: 99, name: "proj", default_branch: "main" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
    // 最初の 1 回だけ。別物には書きにいかない。
    expect(commitAttempts).toBe(1);
  });

  it("既にテンプレートが入っていれば触らない", async () => {
    // 相手が最後まで作り切っている場合。二重にコミットしない。
    const { createRepository } = await import("@beutl/forgejo");
    let repoLookups = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/user/repos")) {
        return new Response("gateway timeout", { status: 504 });
      }
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        repoLookups += 1;
        if (repoLookups === 1) return json({ message: "not found" }, 404);
        return json({ id: 1, name: "proj", default_branch: "main" });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ name: "proj" });

    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
    expect(
      record(fetchMock).filter(
        (c) => c.method === "POST" && c.url.endsWith("/contents"),
      ),
    ).toHaveLength(0);
  });

  it("既にあるリポジトリには手を付けない", async () => {
    // 作成 API が 502 や 504 で落ちたとき、衝突だったのか応答を落としただけなのかは
    // 区別できない。実在するというだけで消すと、既存のリポジトリを巻き添えにする。
    const { createRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 1, name: "proj", default_branch: "main" });
      }
      // 既定ファイルが揃っている = 本当の名前衝突。
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      return new Response("gateway timeout", { status: 504 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toMatchObject({ status: 409 });

    // 作成もしないし、消しもしない。
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
    expect(
      record(fetchMock).filter((c) => c.method === "POST"),
    ).toHaveLength(0);
  });

  it("途中で終わった同名リポジトリは、やり直しで修復する", async () => {
    // 409 のままだと二度と直せる経路が無くなり、LFS の効かないリポジトリに
    // push され続ける。
    const { createRepository } = await import("@beutl/forgejo");
    let committed = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 1, name: "proj", default_branch: "main" });
      }
      if (init?.method === "POST" && path.endsWith("/contents")) {
        committed = true;
        return json({}, 201);
      }
      if (path.includes("/contents/.gitattributes")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) })
          : json({ message: "not found" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITIGNORE) })
          : json({ message: "not found" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ name: "proj" });
    expect(committed).toBe(true);
  });

  it("名前が衝突しただけなら畳みにいかない", async () => {
    // 既に他人 (あるいは自分) が使っている名前。作られていないので消すものもなく、
    // ここで DELETE を投げると同名の既存リポジトリを壊しかねない。
    const { createRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        return json({ message: "repository already exists" }, 409);
      }
      if (path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });
});

describe("退会時の後始末", () => {
  it("端末に配ったトークンを全部失効させる", async () => {
    // 消しながら読み直すので、2 巡目は空を返す。
    let listed = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (
        path.endsWith("/admin/users/someone/tokens") &&
        (init?.method ?? "GET") === "GET"
      ) {
        listed += 1;
        return listed === 1 ? json([{ id: 11 }, { id: 12 }]) : json([]);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: 2, login: "someone", email: EMAIL });
    });

    await expect(beginGitAccountDeletion("u1")).resolves.toMatchObject({
      forgejoUsername: "someone",
    });

    const deletes = record(fetchMock).filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url.split("/").at(-1))).toEqual(["11", "12"]);
  });

  it("一覧をページ指定で読む (無指定の全件返しに頼らない)", async () => {
    let listed = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (
        path.endsWith("/admin/users/someone/tokens") &&
        (init?.method ?? "GET") === "GET"
      ) {
        listed += 1;
        return listed === 1 ? json([{ id: 11 }]) : json([]);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: 2, login: "someone", email: EMAIL });
    });

    await beginGitAccountDeletion("u1");

    const list = record(fetchMock).find(
      (c) => c.method === "GET" && c.url.includes("/tokens?"),
    )!;
    expect(list.url).toContain("limit=50");
  });

  it("対応表が別人を指していたら消しに行かない", async () => {
    // 削除は取り返しがつかない。id が食い違ったまま進むと、別人のトークンを
    // 全部失効させてリポジトリごと消してしまう。
    fetchMock.mockImplementation(async () =>
      json({ id: 99, login: "someone", email: EMAIL }),
    );

    await expect(beginGitAccountDeletion("u1")).rejects.toBeTruthy();
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("メールが別人のものなら消しに行かない", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: 2, login: "someone", email: "someone-else@example.test" }),
    );

    await expect(beginGitAccountDeletion("u1")).rejects.toBeTruthy();
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("失効に失敗したら投げる (退会自体を止めるため)", async () => {
    // ここを握り潰すと、Beutl 側だけ消えて生きたトークンが残る。
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (
        path.endsWith("/admin/users/someone/tokens") &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json([{ id: 11 }]);
      }
      if (init?.method === "DELETE") return json({ message: "boom" }, 500);
      return json({ id: 2, login: "someone", email: EMAIL });
    });

    await expect(beginGitAccountDeletion("u1")).rejects.toBeTruthy();
  });

  it("Beutl 側がまだ消えていなければ purge しない", async () => {
    // ローカルのユーザー削除が失敗すると、利用者は生きたまま墓標だけが残る。
    // ここで消すと、その人の Forgejo アカウントとリポジトリを落とすことになる。
    pendingDeletion = {
      userId: "u1",
      phase: "BLOCKING",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("待っている間に別人へ渡っていたら purge しない", async () => {
    // 復元で id が振り直されると、同じ名前が別のアカウントになる。
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    fetchMock.mockImplementation(async () =>
      json({ id: 999, login: "someone", email: EMAIL }),
    );

    // 消しにいかない。かといって元のユーザーを消せた証拠も無いので完了にもしない。
    await expect(finishGitAccountDeletion("u1")).resolves.toBe(false);
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("控えの相手が消えていれば完了 (404 だけが完了)", async () => {
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    fetchMock.mockImplementation(async () => json({ message: "not found" }, 404));

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(true);
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("メールが本人のものでなければ人の確認に回す", async () => {
    // ホスト名の変更や復元で、名前は同じでも別人になっていることがある。
    // 消しに行かないのはもちろん、消せた証拠も無いので完了にもしない。
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    fetchMock.mockImplementation(async () =>
      json({ id: 2, login: "someone", email: "other@example.test" }),
    );

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(false);
    expect(neededReview).toBe(true);
    expect(record(fetchMock).filter((c) => c.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("既に別の退会が走っていたら、その印に乗らない", async () => {
    // 印は利用者ごとに 1 つ。相手の印に乗って進めると、相手が失敗して取り消した
    // ときに、後始末できないままユーザーだけが消える。
    deletionIntentOwner = "someone-elses-intent";

    await expect(beginGitAccountDeletion("u1")).rejects.toBeInstanceOf(
      GitAccountDeletionInProgressError,
    );
    // 相手の印を消しにいかない。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("準備の段階で失敗したら印を取り消す", async () => {
    // 利用者はまだ生きている。印が残ると二度と資格情報を発行できない。
    fetchMock.mockImplementation(async () => json({ message: "boom" }, 500));

    await expect(beginGitAccountDeletion("u1")).rejects.toBeTruthy();
    expect(pendingDeletion).toBeNull();
  });

  it("purge の直前にもう一度トークンを掃く", async () => {
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    // 失効から Beutl 側の削除までの間に発行された分がありうる。purge が失敗した
    // ときに生き残るのはまさにそれ。
    let listed = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (
        path.endsWith("/admin/users/someone/tokens") &&
        (init?.method ?? "GET") === "GET"
      ) {
        listed += 1;
        return listed === 1 ? json([{ id: 77 }]) : json([]);
      }
      if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      return new Response(null, { status: 204 });
    });

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(true);

    const deletes = record(fetchMock).filter((c) => c.method === "DELETE");
    expect(deletes[0].url).toContain("/tokens/77");
    const purge = deletes.at(-1)!;
    // 付けないとリポジトリ所有者は 422 で拒まれる。
    expect(purge.url).toContain("purge=true");
  });

  it("purge が成功したら墓標を消す", async () => {
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if ((init?.method ?? "GET") === "GET") return json([]);
      return new Response(null, { status: 204 });
    });

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(true);

    const purge = record(fetchMock).find((c) => c.method === "DELETE")!;
    expect(purge.url).toContain("purge=true");
  });

  it("purge が失敗したら false を返す (投げない)", async () => {
    pendingDeletion = {
      userId: "u1",
      phase: "READY_TO_PURGE",
      forgejoUserId: 2,
      forgejoUsername: "someone",
    };
    // アクセスは既に断ってある。ここで投げても Beutl 側の削除は戻せない。
    // 呼び出し元が消し残りを監査に記録できるよう、成否だけ返す。
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if ((init?.method ?? "GET") === "GET") return json([]);
      return json({ message: "boom" }, 500);
    });

    await expect(finishGitAccountDeletion("u1")).resolves.toBe(false);
  });
});

describe("トークンの失効", () => {
  it("名前ではなく Forgejo のトークン id で消す", async () => {
    const revoked = await revokeGitCredential("u1", "c1");

    expect(revoked?.name).toBe("desktop");
    const del = record(fetchMock).find((c) => c.method === "DELETE")!;
    // 名前には空白やスラッシュが入りうるので、パスには載せない。
    expect(del.url).toContain("/admin/users/someone/tokens/42");
  });

  it("Forgejo 側に既に無くても控えを消して成功にする", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("not found", { status: 404 })
        : json({ id: 2, login: "someone", email: EMAIL }),
    );

    await expect(revokeGitCredential("u1", "c1")).resolves.toMatchObject({
      name: "desktop",
    });
  });

  it("知らない id は null", async () => {
    await expect(revokeGitCredential("u1", "nope")).resolves.toBeNull();
  });
});
