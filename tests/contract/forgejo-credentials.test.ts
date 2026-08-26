import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 本物の reserveGitRepositoryName は一意制約の違反をこの型に畳んで投げる。
// 名前を押さえる側はこの型を見て「今その名前は動いている」と判断する。
class FakeNameTaken extends Error {
  constructor(owner: string, name: string) {
    super(`${owner}/${name} is taken`);
    this.name = "GitRepositoryNameTakenError";
  }
}

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
      tookOver: false,
    };
  },
  // 期限の延長。握ったままである限り true。
  renewGitAccountDeletionLease: async ({ intentId }: { intentId: string }) =>
    deletionIntentOwner === null || deletionIntentOwner === intentId,
  // 本物は「自分が握っている行に書けたか」を返す。
  setGitAccountDeletionTarget: async () => true,
  markGitAccountDeletionReady: async () => undefined,
  claimGitAccountDeletion: async () => true,
  markGitAccountDeletionNeedsReview: async () => {
    neededReview = true;
    return true;
  },
  cancelPendingGitAccountDeletion: async () => {
    pendingDeletion = null;
  },
  deleteGitAccountDeletion: async () => {
    pendingDeletion = null;
    // 本物は「自分の印の行を消せたか」を返す。
    return true;
  },
  // purge の成功時は行を消さず、消した相手を控えた墓標として残す。
  markGitAccountDeletionPurged: async () => {
    purgedTombstone = true;
    pendingDeletion = null;
    return true;
  },
  listPurgedGitAccountDeletions: async () => [],
  touchGitAccountDeletion: async () => true,
  // 直せなかったリポジトリの控え。id で持つ (名前は改名で変わる)。
  enqueueGitRepositoryRepair: async ({
    forgejoRepoId,
    ownerUsername,
    name,
    intendedOwner,
    intendedName,
    reservationId,
  }: {
    forgejoRepoId: number;
    ownerUsername: string;
    name: string;
    intendedOwner?: string;
    intendedName?: string;
    reservationId?: string;
  }) => {
    if (enqueueFails) throw new Error("db is down");
    repairQueue.set(forgejoRepoId, {
      forgejoRepoId,
      ownerUsername,
      name,
      intendedOwner: intendedOwner ?? null,
      intendedName: intendedName ?? null,
      reservationId: reservationId ?? null,
    });
  },
  listGitRepositoryRepairs: async () =>
    [...repairQueue.values()]
      .filter((entry) => !entry.needsReview)
      .map((entry) => ({
        intendedOwner: null,
        intendedName: null,
        reservationId: null,
        ...entry,
      })),
  claimGitRepositoryRepair: async () => leaseHeld,
  recordGitRepositoryRepairAttempt: async () => undefined,
  deleteGitRepositoryRepair: async ({
    forgejoRepoId,
  }: {
    forgejoRepoId: number;
  }) => repairQueue.delete(forgejoRepoId),
  // 予約 (Forgejo を触る前に取る名前の押さえ)。
  reserveGitRepositoryName: async ({
    ownerUsername,
    name,
    holdingName,
    leaseUntil,
  }: {
    ownerUsername: string;
    name: string;
    holdingName: string;
    leaseUntil: Date;
  }) => {
    const key = `${ownerUsername}/${name.toLowerCase()}`;
    if (reservations.has(key)) {
      // 本物は一意制約の違反をこの型に畳んでから投げる。
      throw new FakeNameTaken(ownerUsername, name);
    }
    reservations.set(key, {
      id: key,
      holdingName,
      forgejoRepoId: null,
      leaseUntil,
    });
    return key;
  },
  attachGitRepositoryCreationId: async ({
    id,
    forgejoRepoId,
  }: {
    id: string;
    forgejoRepoId: number;
  }) => {
    // 引き取られた行には書けない状況を作れるようにする。
    if (attachFailsFor.includes(id)) return false;
    const entry = reservations.get(id);
    if (!entry) return false;
    entry.forgejoRepoId = forgejoRepoId;
    // 本物は「自分の印の行に書けたか」を返す。
    return true;
  },
  releaseGitRepositoryReservation: async ({ id }: { id: string }) => {
    releasedIds.push(id);
    return reservations.delete(id);
  },
  releaseGitRepositoryReservationsByIntent: async () => {
    // 実物は同じ 1 回の操作で取った行をまとめて外す。テストでは 1 操作ぶんしか
    // 積まないので、全部消せば同じこと。
    reservations.clear();
  },
  listExpiredGitRepositoryCreations: async ({
    limit = 20,
    after,
  }: { limit?: number; after?: string } = {}) => {
    const rows = [
    ...staleReservations.map((entry) => ({
      operation: "CREATE",
      sourceName: null,
      // 既定は「たった今積まれた」。削除の猶予を試す側で古い時刻を渡す。
      createdAt: new Date(),
      ...entry,
    })),
    // **実物は残っている予約も期限で拾う。** 拾わない模擬にすると、片付けが
    // 予約を掴んで期限を伸ばし、直し側が引き継げなくなる失敗を見逃す。
    // 期限を控えていない行 (テストが手で置いたもの) は判断材料が無いので外す。
    ...[...reservations.values()]
      .filter(
        (entry) =>
          entry.leaseUntil != null &&
          entry.leaseUntil.getTime() <= Date.now(),
      )
      .map((entry) => ({
        id: entry.id,
        ownerUsername: entry.id.split("/")[0],
        name: entry.id.split("/")[1],
        holdingName: entry.holdingName,
        forgejoRepoId: entry.forgejoRepoId,
        operation: "CREATE",
        sourceName: null,
        createdAt: new Date(),
      })),
    ];
    // 本物は位置 (行) で続きを読む。ここで無視すると、飛ばされた行が先頭に
    // 居座り続けたときに同じ頁を読み直すだけになり、飢餓を試せない。
    const start = after === undefined ? 0 : rows.findIndex((r) => r.id === after) + 1;
    return rows.slice(start, start + limit);
  },
  GitRepositoryOperation: {
    CREATE: "CREATE",
    RENAME: "RENAME",
    DELETE: "DELETE",
  },
  markGitRepositoryCreationMissing: async () => new Date(),
  clearGitRepositoryCreationMissing: async () => undefined,
  findGitRepositoryRepair: async ({
    forgejoRepoId,
  }: {
    forgejoRepoId: number;
  }) => repairQueue.get(forgejoRepoId) ?? null,
  findGitRepositoryReservationByName: async ({
    ownerUsername,
    name,
  }: {
    ownerUsername: string;
    name: string;
  }) => reservations.get(`${ownerUsername}/${name.toLowerCase()}`) ?? null,
  // 本物は**期限が切れている行にしか**書けない。動いている処理から横取り
  // させないため。ここを常に true にすると、期限を伸ばしただけの周回が
  // 引き継ぎを塞ぐ失敗が通ってしまう。
  claimGitRepositoryCreation: async ({
    id,
    leaseUntil,
  }: {
    id: string;
    leaseUntil: Date;
  }) => {
    const entry = reservations.get(id);
    // 期限切れの一覧から来た行は、この模擬では map に載っていない。
    if (!entry) return true;
    if (entry.leaseUntil && entry.leaseUntil.getTime() > Date.now()) {
      return false;
    }
    entry.leaseUntil = leaseUntil;
    return true;
  },
  renewGitRepositoryCreationLease: async ({
    id,
    leaseUntil,
  }: {
    id: string;
    leaseUntil: Date;
  }) => {
    const entry = reservations.get(id);
    if (entry) entry.leaseUntil = leaseUntil;
    return true;
  },
  releaseGitRepositoryReservationFor: async ({
    ownerUsername,
    name,
  }: {
    ownerUsername: string;
    name: string;
  }) => {
    reservations.delete(`${ownerUsername}/${name}`);
  },
  normalizeRepositoryName: (name: string) => name.toLowerCase(),
  countGitRepositoryCreations: async () =>
    reservations.size + staleReservations.length,
  countGitRepositoryRepairs: async () =>
    [...repairQueue.values()].filter((entry) => !entry.needsReview).length,
  countGitRepositoryRepairsNeedingReview: async () =>
    [...repairQueue.values()].filter((entry) => entry.needsReview).length,
  markGitRepositoryRepairNeedsReview: async ({
    forgejoRepoId,
  }: {
    forgejoRepoId: number;
  }) => {
    const entry = repairQueue.get(forgejoRepoId);
    if (!entry) return false;
    entry.needsReview = true;
    return true;
  },
  // 握りを失った状態を作れるようにする。
  renewGitRepositoryRepairLease: async () => leaseHeld,
  listPendingGitAccountDeletions: async () => [],
  recordGitAccountDeletionAttempt: async () => undefined,
  GitAccountDeletionPhase: {
    BLOCKING: "BLOCKING",
    READY_TO_PURGE: "READY_TO_PURGE",
    NEEDS_REVIEW: "NEEDS_REVIEW",
  },
  auditLogActions: {
    git: {
      credentialOrphaned: "git.credentialOrphaned",
      accountNeedsReview: "git.accountNeedsReview",
      deletionMarkerReleased: "git.deletionMarkerReleased",
      repositoryLocked: "git.repositoryLocked",
    },
  },
  createAuditLog: async ({
    action,
    details,
  }: {
    action: string;
    details?: string | null;
  }) => {
    audited.push({ action, details: details ?? null });
    return undefined;
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
  // 生き返りの控え。失効も削除もこちら側に何も残さないので、消し直す相手は
  // ここにしか残らない。
  recordGitCredentialRevocation: async (input: Record<string, unknown>) => {
    revocationTombstones.push(input);
  },
  recordGitRepositoryDeletion: async (input: Record<string, unknown>) => {
    deletionTombstones.push(input);
  },
  currentGitRestoreGeneration: async () => restoreGeneration,
  listGitCredentialRevocations: async () =>
    revocationRows.filter((row) => row.checkedGeneration !== restoreGeneration),
  listGitRepositoryDeletions: async () =>
    deletionRows.filter(
      (row) => !row.needsReview && row.checkedGeneration !== restoreGeneration,
    ),
  markGitCredentialRevocationChecked: async ({ id }: { id: string }) => {
    const row = revocationRows.find((entry) => entry.id === id);
    if (row) row.checkedGeneration = restoreGeneration;
  },
  markGitRepositoryDeletionChecked: async ({
    forgejoRepoId,
  }: {
    forgejoRepoId: number;
  }) => {
    const row = deletionRows.find(
      (entry) => entry.forgejoRepoId === forgejoRepoId,
    );
    if (row) row.checkedGeneration = restoreGeneration;
  },
  markGitRepositoryDeletionNeedsReview: async ({
    forgejoRepoId,
  }: {
    forgejoRepoId: number;
  }) => {
    const row = deletionRows.find(
      (entry) => entry.forgejoRepoId === forgejoRepoId,
    );
    if (row) row.needsReview = true;
  },
  recordGitCredentialRevocationAttempt: async () => undefined,
  recordGitRepositoryDeletionAttempt: async () => undefined,
  pruneGitResurrectionTombstones: async () => ({
    credentials: 0,
    repositories: 0,
  }),
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
  GitRepositoryNameTakenError: FakeNameTaken,
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
let audited: { action: string; details: string | null }[] = [];
let repairQueue = new Map<
  number,
  {
    forgejoRepoId: number;
    ownerUsername: string;
    name: string;
    intendedOwner?: string | null;
    intendedName?: string | null;
    reservationId?: string | null;
    needsReview?: boolean;
  }
>();
let reservations = new Map<
  string,
  {
    id: string;
    holdingName: string;
    forgejoRepoId: number | null;
    // 期限。**引き継ぎは期限切れだけを条件にする**ので、ここを持たないと
    // 「掴んで期限を伸ばしただけ」の周回が引き継ぎを塞ぐ失敗を見逃す。
    leaseUntil?: Date;
  }
>();
let staleReservations: {
  id: string;
  ownerUsername: string;
  name: string;
  holdingName: string;
  forgejoRepoId: number | null;
  operation?: string;
  sourceName?: string | null;
  createdAt?: Date;
}[] = [];
let attachFailsFor: string[] = [];
let releasedIds: string[] = [];
let leaseHeld = true;
let enqueueFails = false;
let purgedTombstone = false;
let deletionIntentOwner: string | null = null;
let neededReview = false;
let credentialCount = 0;
let credentialCountAfterIssue: number | null = null;
let existingNames: string[] = [];
let dbInsertFails = false;
let revocationTombstones: Record<string, unknown>[] = [];
let deletionTombstones: Record<string, unknown>[] = [];
let restoreGeneration: string | null = null;
let revocationRows: {
  id: string;
  forgejoUsername: string;
  forgejoTokenId: number;
  lastEight: string;
  checkedGeneration: string | null;
}[] = [];
let deletionRows: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
  needsReview: boolean;
  checkedGeneration: string | null;
}[] = [];

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
  audited = [];
  pendingDeletion = null;
  deletionStartsAfterFirstCheck = false;
  deletionIntentOwner = null;
  purgedTombstone = false;
  leaseHeld = true;
  enqueueFails = false;
  reservations = new Map();
  staleReservations = [];
  revocationTombstones = [];
  deletionTombstones = [];
  restoreGeneration = null;
  revocationRows = [];
  deletionRows = [];
  attachFailsFor = [];
  releasedIds = [];
  repairQueue = new Map();
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
    // 消せているので、置き去りの記録は要らない。
    expect(audited).toHaveLength(0);
  });

  it("その取り消しにも失敗したら、手で消せるように記録を残す", async () => {
    // ここで黙ると、一覧に出ないトークンが誰にも気付かれずに残る。利用者は
    // 失効できず、退会が取りやめになった場合は掃き直しも走らない。
    dbInsertFails = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if (init?.method === "DELETE") return json({ message: "boom" }, 500);
      if (init?.method === "POST" && path.endsWith("/tokens")) {
        return json(
          {
            id: 13,
            name: "desktop",
            sha1: TOKEN,
            token_last_eight: TOKEN.slice(-8),
          },
          201,
        );
      }
      return json({});
    });

    await expect(issueGitCredential("u1", "desktop")).rejects.toBeTruthy();

    expect(audited).toEqual([
      {
        action: "git.credentialOrphaned",
        details: expect.stringContaining("tokenId: 13"),
      },
    ]);
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
  // 利用者の名前空間には作らない。管理者の名前空間で作り、既定値を入れ切ってから
  // 譲渡する。入る前に push される隙間を残すと、そこへ入った動画は普通の git
  // オブジェクトとして履歴に残り、後から .gitattributes を足しても移らない。

  /** 管理者側で作る → コミット → 譲渡、という流れを組み立てる。 */
  function creationMock({
    commitFails = false,
    transferFails = false,
  }: { commitFails?: boolean; transferFails?: boolean } = {}) {
    const state = { committed: false, deleted: false, transferred: false };
    let holdingName = "";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      // 利用者の名前空間は空。
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        holdingName = JSON.parse(String(init?.body)).name;
        return json({ id: 7, name: holdingName, default_branch: "main" }, 201);
      }
      if (method === "POST" && path.endsWith("/contents")) {
        if (commitFails) return json({ message: "boom" }, 500);
        state.committed = true;
        return json({}, 201);
      }
      if (path.includes("/contents/.gitattributes")) {
        return state.committed
          ? json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) })
          : json({ message: "nope" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return state.committed
          ? json({ encoding: "base64", content: utf8Base64(GITIGNORE) })
          : json({ message: "nope" }, 404);
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        if (transferFails) return json({ message: "boom" }, 500);
        state.transferred = true;
        return json({
          id: 7,
          name: holdingName,
          owner: { id: 2, login: "someone" },
        });
      }
      // 譲渡の後、本来の名前に直す。
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        return json({ id: 7, name: "proj", owner: { id: 2, login: "someone" } });
      }
      // 畳むときも、名前で送る直前の照合でも、id で今の姿を引く。
      // 譲渡が済んでいれば所有者は変わっている (預かり名のまま渡る)。
      if (method === "GET" && path.endsWith("/repositories/7")) {
        return json({
          id: 7,
          name: holdingName,
          default_branch: "main",
          owner: state.transferred
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (method === "DELETE" && path.includes("/repos/beutl-admin/")) {
        state.deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    return state;
  }

  it("管理者の名前空間で作り、既定値を入れてから譲渡する", async () => {
    const { createRepository } = await import("@beutl/forgejo");
    const state = creationMock();

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ id: 7 });

    const calls = record(fetchMock);
    const create = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/user/repos"),
    )!;
    // Sudo を付けない = 管理者自身のものとして作る。利用者からは見えない。
    expect(create.headers.get?.("Sudo") ?? null).toBeNull();

    // コミットは譲渡より前。
    const order = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    const committedAt = order.findIndex((c) => c.endsWith("/contents"));
    const transferredAt = order.findIndex((c) => c.endsWith("/transfer"));
    expect(committedAt).toBeGreaterThanOrEqual(0);
    expect(transferredAt).toBeGreaterThan(committedAt);
    expect(state.transferred).toBe(true);
  });

  it("既定値を入れられなければ譲渡せず、預かったまま畳む", async () => {
    // 利用者はまだ触れないので、ここで消すのは他人のものを消すのとは違う。
    const { createRepository } = await import("@beutl/forgejo");
    const state = creationMock({ commitFails: true });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(state.transferred).toBe(false);
    expect(state.deleted).toBe(true);
  });

  it("譲渡に失敗しても、利用者の手には渡さない", async () => {
    const { createRepository } = await import("@beutl/forgejo");
    const state = creationMock({ transferFails: true });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(state.transferred).toBe(false);
    expect(state.deleted).toBe(true);
  });

  it("利用者の側に同じ名前があれば衝突として返す", async () => {
    const { createRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 3, name: "proj", default_branch: "main" });
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
    ).rejects.toMatchObject({ status: 409 });
  });

  it("同名で作り直すと、読み取り専用を外してから直す", async () => {
    // 直せずに読み取り専用にしたリポジトリの、唯一の戻し方。ここで解除を
    // 忘れると contents API が 423 を返し続け、二度と直せない。
    const { createRepository } = await import("@beutl/forgejo");
    // 読み出しは archived でも通る。書き込みだけが 423 (16.0.2 で実測)。
    let archived = true;
    let committed = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      // 名前で送る直前の照合。名前がまだこの id を指していることを返す。
      if (path.endsWith("/repositories/1")) {
        return json({ id: 1, name: "proj", owner: { id: 2, login: "someone" } });
      }
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 1, name: "proj", default_branch: "main", archived });
      }
      if (init?.method === "PATCH" && path.endsWith("/repos/someone/proj")) {
        archived = JSON.parse(String(init.body)).archived;
        return json({ id: 1, name: "proj", default_branch: "main", archived });
      }
      if (path.includes("/contents/.gitattributes")) {
        if (!committed) return json({ message: "not found" }, 404);
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        if (!committed) return json({ message: "not found" }, 404);
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (init?.method === "POST" && path.endsWith("/contents")) {
        if (archived) return json({ message: "archived" }, 423);
        committed = true;
        return json({}, 201);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ id: 1 });

    const unlock = record(fetchMock).find((c) => c.method === "PATCH");
    expect(unlock?.body).toEqual({ archived: false });
    expect(archived).toBe(false);
  });

  it("作成の応答を落とした場合、管理者側に出来ていれば引き継ぐ", async () => {
    // 502/504 では、作られたのか作られていないのかが分からない。管理者の
    // 名前空間を見て、在れば続きから進める。
    const { createRepository } = await import("@beutl/forgejo");
    let transferred = false;
    let holdingName = "";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (path.endsWith("/repositories/7")) {
        return json({
          id: 7,
          name: holdingName,
          owner: transferred
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        holdingName = JSON.parse(String(init?.body)).name;
        return new Response("gateway timeout", { status: 504 });
      }
      // 管理者側には**この呼び出しの名前で**出来ている。
      if (
        method === "GET" &&
        holdingName &&
        path.endsWith(`/repos/beutl-admin/${holdingName}`)
      ) {
        return json({ id: 7, name: holdingName, default_branch: "main" });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        transferred = true;
        return json({
          id: 7,
          name: holdingName,
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        return json({ id: 7, name: "proj", owner: { id: 2, login: "someone" } });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ id: 7 });

    expect(transferred).toBe(true);
    // 既に揃っているので二重にコミットしない。
    expect(
      record(fetchMock).filter(
        (c) => c.method === "POST" && c.url.endsWith("/contents"),
      ),
    ).toHaveLength(0);
    // 自分で作ったと言い切れないので畳まない。
    expect(
      record(fetchMock).filter((c) => c.method === "DELETE"),
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
      if (path.endsWith("/repositories/1")) {
        return json({ id: 1, name: "proj", owner: { id: 2, login: "someone" } });
      }
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

  it("purge が成功しても行は消さず、墓標として残す", async () => {
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
    // 行ごと消すと、Forgejo だけを退会前へ戻したときに復活を誰も検出できない。
    expect(purgedTombstone).toBe(true);
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

describe("直せなかったリポジトリの片付け", () => {
  // その場で直せず読み取り専用にもできなかった場合、記録が無ければ
  // .gitattributes の無いリポジトリが push を受けられるまま誰にも気付かれない。

  it("読み取り専用にすらできなかったら控えに積む", async () => {
    const { createRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST" && path.endsWith("/user/repos")) {
        return json({ id: 5, name: "proj", default_branch: "main" }, 201);
      }
      if ((init?.method ?? "GET") === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 5, name: "proj", default_branch: "main" });
      }
      // 直すことも読み取り専用にすることもできない。
      if (init?.method === "POST" && path.endsWith("/contents")) {
        return json({ message: "boom" }, 500);
      }
      if (init?.method === "PATCH") return json({ message: "boom" }, 500);
      if (path.includes("/contents/.git")) return json({ message: "nope" }, 404);
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect([...repairQueue.keys()]).toEqual([5]);
  });

  it("預かっている間も控える (譲渡前に落ちても追える)", async () => {
    // 利用者はまだ触れないので push はされないが、預かったまま残るのを
    // 見えなくしない。譲渡まで通れば控えは外す。
    const { createRepository } = await import("@beutl/forgejo");
    let queuedBeforeTransfer: number[] = [];
    let committed = false;
    // Forgejo は作成の応答に**要求した名前**を返す。預かり名のまま持っている間に
    // 名前で送る呼び出しがあるので、テストでもそこを合わせる。
    let holdingName = "";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (path.endsWith("/repositories/9")) {
        return json({
          id: 9,
          name: holdingName,
          owner: queuedBeforeTransfer.length
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        holdingName = JSON.parse(String(init?.body)).name;
        return json({ id: 9, name: holdingName, default_branch: "main" }, 201);
      }
      if (method === "POST" && path.endsWith("/contents")) {
        committed = true;
        return json({}, 201);
      }
      if (path.includes("/contents/.gitattributes")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) })
          : json({ message: "nope" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITIGNORE) })
          : json({ message: "nope" }, 404);
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        queuedBeforeTransfer = [...repairQueue.keys()];
        return json({ id: 9, name: "proj", owner: { id: 2, login: "someone" } });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).resolves.toMatchObject({ id: 9 });

    expect(queuedBeforeTransfer).toEqual([9]);
    expect(repairQueue.size).toBe(0);
  });


  it("控えは id で引き直す (名前が変わっていても別物を止めない)", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    // 控えた名前は古い。id で引くと今の名前が返る。
    repairQueue.set(5, { forgejoRepoId: 5, ownerUsername: "someone", name: "old" });
    let committedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "renamed",
          default_branch: "main",
          archived: false,
          owner: { id: 2, login: "someone" },
        });
      }
      if (init?.method === "POST" && path.endsWith("/contents")) {
        committedTo = path;
        return json({}, 201);
      }
      if (path.includes("/contents/.gitattributes")) {
        return committedTo
          ? json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) })
          : json({ message: "nope" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return committedTo
          ? json({ encoding: "base64", content: utf8Base64(GITIGNORE) })
          : json({ message: "nope" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
      pending: 0,
    });
    // 控えた "old" ではなく、今の名前に書く。
    expect(committedTo).toContain("/repos/someone/renamed/contents");
    expect(repairQueue.size).toBe(0);
  });

  it("消えているリポジトリの控えは外す", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, { forgejoRepoId: 5, ownerUsername: "someone", name: "gone" });
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/repositories/5")) return json({ message: "nope" }, 404);
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
      pending: 0,
    });
    expect(repairQueue.size).toBe(0);
  });

  it("直せなければ読み取り専用にして片付いた扱いにする", async () => {
    // 掛かった時点で push は通らない。控えに残すのは「まだ push できるもの」だけ。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, { forgejoRepoId: 5, ownerUsername: "someone", name: "proj" });
    let archived = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          archived,
          owner: { id: 2, login: "someone" },
        });
      }
      if (init?.method === "PATCH") {
        archived = JSON.parse(String(init.body)).archived;
        return json({});
      }
      // 中身が違う。コミットの対象にならず、canonical 検証だけが落ちる。
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64("*.mp4 -text\n") });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      return new Response(null, { status: 204 });
    });

    // 読み取り専用になった時点で push は通らない。控え (= まだ push できるもの)
    // からは外れるので、片付いた扱いになる。
    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
      pending: 0,
    });
    expect(archived).toBe(true);
    expect(repairQueue.size).toBe(0);
    expect(audited.map((entry) => entry.action)).toContain(
      "git.repositoryLocked",
    );
  });
});

describe("預かったままのリポジトリ", () => {
  // 譲渡の前に Worker が消えると、管理者所有のまま残る。利用者からは見えないので
  // push はされないが、控えを外して放置すると同じ名前を永久に塞ぐ。

  it("控えに渡す先が入っていれば、後から渡し切る", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "beutl-admin",
      name: "beutl-holding-abc",
      intendedOwner: "someone",
      intendedName: "proj",
    });
    let transferredTo: string | null = null;
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "beutl-holding-abc",
          default_branch: "main",
          archived: false,
          // 譲渡が済めば所有者は渡す先に変わる (名前は預かり名のまま)。
          owner: transferredTo
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        transferredTo = JSON.parse(String(init?.body)).new_owner;
        return json({
          id: 5,
          name: "beutl-holding-abc",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 5, name: "proj", owner: { id: 2, login: "someone" } });
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
    });
    // 揃っているからと控えだけ外さない。渡し切る。
    expect(transferredTo).toBe("someone");
    expect(renamedTo).toBe("proj");
    expect(repairQueue.size).toBe(0);
  });

  it("消せなかった預かりものは控えに残す", async () => {
    // ログだけにすると、管理者所有のまま誰にも知られずに残る。
    const { createRepository } = await import("@beutl/forgejo");
    let holdingName = "";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        holdingName = JSON.parse(String(init?.body)).name;
        return json({ id: 5, name: holdingName, default_branch: "main" }, 201);
      }
      // テンプレートを入れられない。
      if (method === "POST" && path.endsWith("/contents")) {
        return json({ message: "boom" }, 500);
      }
      if (path.includes("/contents/.git")) {
        return json({ message: "nope" }, 404);
      }
      if (method === "GET" && path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: holdingName,
          owner: { id: 1, login: "beutl-admin" },
        });
      }
      // 畳むこともできない。
      if (method === "DELETE") return json({ message: "boom" }, 500);
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect([...repairQueue.keys()]).toEqual([5]);
  });
});

describe("預かりものは渡し切るまで控えを外さない", () => {
  /** 管理者が預かっている、既定値の入っていないリポジトリ。 */
  function heldRepository(overrides: Record<string, unknown> = {}) {
    return {
      id: 5,
      name: "beutl-holding-abc",
      default_branch: "main",
      archived: false,
      owner: { id: 1, login: "beutl-admin" },
      ...overrides,
    };
  }

  beforeEach(() => {
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "beutl-admin",
      name: "beutl-holding-abc",
      intendedOwner: "someone",
      intendedName: "proj",
    });
  });

  it("直した後、譲渡に失敗したら控えは残る", async () => {
    // 直した時点で控えを外すと、譲渡の前に落ちたものが管理者所有のまま
    // 追えなくなり、その名前の作成を永久に塞ぐ。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    let committed = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) return json(heldRepository());
      if (method === "POST" && path.endsWith("/contents")) {
        committed = true;
        return json({}, 201);
      }
      if (path.includes("/contents/.gitattributes")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) })
          : json({ message: "nope" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return committed
          ? json({ encoding: "base64", content: utf8Base64(GITIGNORE) })
          : json({ message: "nope" }, 404);
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        return json({ message: "boom" }, 500);
      }
      return new Response(null, { status: 204 });
    });

    // 5xx は結果が分からないので、出発地と着地名の両方の予約を保持したまま
    // 控えに残す (次の周回で id から引き直す)。pending には repair queue 1 +
    // 名前の予約 2 が入る。
    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 0,
    });
    expect([...repairQueue.keys()]).toEqual([5]);
    // 予約は手放さない (5xx は後から着地しうる)。
    expect(reservations.size).toBeGreaterThan(0);
  });

  it("次の周回は、残した予約を引き継いで渡し切る", async () => {
    // 名前を手放さない決まりと、予約の片付けが「控えがあるなら控え側の仕事」と
    // する決まりは、そのままでは噛み合わない。次の周回が同じ名前を取り直そうと
    // して一意キーに阻まれ、控えも予約も残ったまま毎回何もせずに帰る。
    // 取り残しは取り直すのではなく**引き継ぐ**。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    let transferFails = true;
    let transferred = false;
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json(
          heldRepository(
            transferred ? { owner: { id: 2, login: "someone" } } : {},
          ),
        );
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        if (transferFails) return json({ message: "boom" }, 500);
        transferred = true;
        return json({
          id: 5,
          name: "beutl-holding-abc",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 5, name: "proj", owner: { id: 2, login: "someone" } });
      }
      return new Response(null, { status: 204 });
    });

    // 1 周目。5xx なので名前は手放さない。
    await retryGitRepositoryRepairs();
    expect(reservations.size).toBeGreaterThan(0);

    // 冷却期間 (15 分) が過ぎた。予約の期限 (10 分) はもう切れている。
    for (const entry of reservations.values()) {
      entry.leaseUntil = new Date(Date.now() - 1000);
    }
    transferFails = false;

    // 2 周目。取り残した予約を引き継いで、譲渡と改名まで進む。
    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
    });
    expect(renamedTo).toBe("proj");
    expect(repairQueue.size).toBe(0);
    // 渡し切ったので名前も手放す。残すとその名前の作成を永久に塞ぐ。
    expect(reservations.size).toBe(0);
  });

  it("譲渡だけ済んで改名が残っていたら、改名から再開する", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      // 譲渡は済んでいる。名前は預かり名のまま。
      if (path.endsWith("/repositories/5")) {
        return json(heldRepository({ owner: { id: 2, login: "someone" } }));
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 5, name: "proj" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
    });
    expect(renamedTo).toBe("proj");
    expect(repairQueue.size).toBe(0);
  });

  it("渡し切った後で予約だけ残っていたら、それを引き継いで外す", async () => {
    // 改名まで通ってから、控えている予約を外す前に処理が消えた場合。相手は
    // もう最終形なのに、最終名を自分の予約が押さえている。取り直そうとすると
    // 一意キーに阻まれ、外す処理まで辿り着けずに永久に止まる。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "someone",
      name: "proj",
      intendedOwner: "someone",
      intendedName: "proj",
      reservationId: "someone/proj",
    });
    // 作成のときに取った予約。期限は切れている。
    reservations.set("someone/proj", {
      id: "someone/proj",
      holdingName: "beutl-holding-abc",
      forgejoRepoId: 5,
      leaseUntil: new Date(Date.now() - 1000),
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          archived: false,
          owner: { id: 2, login: "someone" },
        });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
    });
    expect(repairQueue.size).toBe(0);
    expect(releasedIds).toContain("someone/proj");
    expect(reservations.size).toBe(0);
  });

  it("渡す先でも管理者でもない誰かが持っていたら、人の確認に回す", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json(heldRepository({ owner: { id: 9, login: "stranger" } }));
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 0,
      review: 1,
    });
    // 自動再試行の対象からは外れるが、記録は残る。
    expect(repairQueue.get(5)?.needsReview).toBe(true);
  });
});

describe("握りを失った実行は後始末もしない", () => {
  it("引き取られていたら、預かりものを畳まない", async () => {
    // 畳んでしまうと、引き取った側がこれから渡そうとしているものを壊す。
    const { createRepository } = await import("@beutl/forgejo");
    let holdingName = "";
    let deleted = false;
    // 掴んだ直後に他の実行へ引き取られた状態にする。
    leaseHeld = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        holdingName = JSON.parse(String(init?.body)).name;
        return json({ id: 11, name: holdingName, default_branch: "main" }, 201);
      }
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(deleted).toBe(false);
    // 控えも残す。片付けるのは引き取った側。
    expect(repairQueue.has(11)).toBe(true);
  });

  it("控えを積めなければ、預かりものを畳んでから投げる", async () => {
    // 控えが無いまま残すと、無作為な名前のリポジトリが管理者の名前空間に残り、
    // 誰も片付けられない。
    const { createRepository } = await import("@beutl/forgejo");
    enqueueFails = true;
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        return json({ id: 12, name: "beutl-holding-x", default_branch: "main" }, 201);
      }
      if (method === "GET" && path.endsWith("/repositories/12")) {
        return json({
          id: 12,
          name: "beutl-holding-x",
          owner: { id: 1, login: "beutl-admin" },
        });
      }
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(deleted).toBe(true);
  });
});

describe("作成の予約", () => {
  it("同じ名前の作成が同時に来たら、後から来た方を弾く", async () => {
    // Forgejo 上の不在確認だけでは両方が通り、両方が譲渡され、片方だけ改名に
    // 失敗して預かり名のまま利用者の手に残る。
    const { createRepository } = await import("@beutl/forgejo");
    reservations.set("someone/proj", {
      id: "someone/proj",
      holdingName: "beutl-holding-other",
      forgejoRepoId: null,
    });
    let created = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        created = true;
        return json({ id: 21, name: "x", default_branch: "main" }, 201);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    // Forgejo には触らない。
    expect(created).toBe(false);
  });

  it("放置された予約は、預かり名から引き当てて控えに載せ替える", async () => {
    // 201 の直後に落ちるとリポジトリ id は誰も知らない。先に決めた預かり名だけが
    // 手掛かりになる。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "r1",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-holding-lost",
        forgejoRepoId: null,
      },
    ];
    let transferredTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (
        (method === "GET" &&
          path.endsWith("/repos/beutl-admin/beutl-holding-lost")) ||
        path.endsWith("/repositories/31")
      ) {
        return json({
          id: 31,
          name: "beutl-holding-lost",
          default_branch: "main",
          archived: false,
          // 譲渡が済めば所有者は渡す先に変わる (名前は預かり名のまま)。
          owner: transferredTo
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        transferredTo = JSON.parse(String(init?.body)).new_owner;
        return json({
          id: 31,
          name: "beutl-holding-lost",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH" && path.includes("/repos/someone/")) {
        return json({ id: 31, name: "proj" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    // 控えに載せ替えたものは**同じ周回で**渡し切る。次の cron まで待つと、
    // その間に同じ名前を再び予約でき、2 つの預かりものが同じ相手に渡る。
    expect(transferredTo).toBe("someone");
    expect(repairQueue.size).toBe(0);
  });
});

describe("予約を握ったまま確かめる", () => {
  it("Forgejo を見る前に予約を取る", async () => {
    // 404 を見てから予約すると、その間に別の作成が最初から最後まで通り、
    // こちらは古い 404 を信じて預かりものを作ってしまう。
    const { createRepository } = await import("@beutl/forgejo");
    const order: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        order.push(`lookup:reserved=${reservations.size}`);
        return json({ id: 3, name: "proj", default_branch: "main" });
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
    ).rejects.toMatchObject({ status: 409 });

    // 不在確認の時点で、既に押さえてある。
    expect(order).toEqual(["lookup:reserved=1"]);
    // 衝突と分かったので予約は外す。
    expect(reservations.size).toBe(0);
  });

  it("作成の応答を落としたら、404 でも予約を残す", async () => {
    // Forgejo 側の処理が続いていて、後から現れることがある。ここで外すと、
    // 追えない預かりものを残したまま同じ名前を再び予約できる。
    const { createRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        return new Response("gateway timeout", { status: 504 });
      }
      // 預かり名でも今は見つからない。
      return json({ message: "not found" }, 404);
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(reservations.size).toBe(1);
  });
});

describe("予約を失った処理は止まる", () => {
  it("作成の途中で引き取られていたら、そこで止める", async () => {
    // 応答を待っている間に期限が切れて引き取られると、相手が予約を解放した後に
    // 別の要求が同じ名前を取り、預かりものが 2 つになる。
    const { createRepository } = await import("@beutl/forgejo");
    let created = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/user/repos")) {
        created = true;
        // 作った後に引き取られた状態にする。
        reservations.clear();
        return json({ id: 41, name: "x", default_branch: "main" }, 201);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createRepository("someone", { name: "proj" }),
    ).rejects.toBeTruthy();

    expect(created).toBe(true);
    // 控えにも載せない。片付けは引き取った側の仕事。
    expect(repairQueue.size).toBe(0);
  });

  it("第三者が最終名を持っていたら、予約を外さず控えに載せる", async () => {
    // 「管理者が持っていない」だけを完成条件にすると、第三者が最終名を持って
    // いる場合も完成と読んで予約を外してしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "r9",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-holding-x",
        forgejoRepoId: 51,
      },
    ];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/51")) {
        return json({
          id: 51,
          name: "proj",
          default_branch: "main",
          archived: false,
          owner: { id: 9, login: "stranger" },
        });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    // 控えに載り、そこで人の確認に回る。
    expect(repairQueue.get(51)).toMatchObject({ reservationId: "r9" });
  });
});

describe("結果が分からない操作は予約を残す", () => {
  it("改名が 5xx で終わったら予約を残す", async () => {
    // abort や 5xx は「Forgejo が確定させなかった」証明にはならない。ここで
    // 外すと、その間に別の作成が同じ名前を取り、後から着地した改名とぶつかる。
    const { renameRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/old")) {
        return json({ id: 61, name: "old", default_branch: "main" });
      }
      // 送る直前の確かめ。まだ同じ相手。
      if (method === "GET" && path.endsWith("/repositories/61")) {
        return json({
          id: 61,
          name: "old",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") return json({ message: "boom" }, 502);
      return new Response(null, { status: 204 });
    });

    await expect(
      renameRepository("someone", "someone", "old", "new"),
    ).rejects.toBeTruthy();

    // 行き先と元の両方を押さえたまま残す。
    expect(reservations.size).toBe(2);
  });

  it("改名が 4xx で断られたら予約を外す", async () => {
    // 受け付けられなかったと言い切れる。押さえ続ける理由が無い。
    const { renameRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/old")) {
        return json({ id: 62, name: "old", default_branch: "main" });
      }
      if (method === "GET" && path.endsWith("/repositories/62")) {
        return json({
          id: 62,
          name: "old",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") return json({ message: "taken" }, 409);
      return new Response(null, { status: 204 });
    });

    await expect(
      renameRepository("someone", "someone", "old", "new"),
    ).rejects.toBeTruthy();

    expect(reservations.size).toBe(0);
  });
});

describe("改名は相手を確かめてから送る", () => {
  it("名前が別のリポジトリに付け替わっていたら送らない", async () => {
    // 最初の GET で id を得てから送るまでの間に、その名前が別物に渡ることが
    // ある (消して作り直しなど)。名前でしか送れないので、直前に確かめ直す。
    const { renameRepository } = await import("@beutl/forgejo");
    let patched = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/old")) {
        return json({ id: 71, name: "old", default_branch: "main" });
      }
      // 送る直前には、その id は別の名前になっている。
      if (method === "GET" && path.endsWith("/repositories/71")) {
        return json({
          id: 71,
          name: "moved",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        patched = true;
        return json({ id: 71, name: "new" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      renameRepository("someone", "someone", "old", "new"),
    ).rejects.toMatchObject({ status: 409 });

    expect(patched).toBe(false);
    expect(reservations.size).toBe(0);
  });

  it("大小だけの改名が残っていたら完了扱いにしない", async () => {
    // 小文字化して比べると proj と Proj が同じに見え、済んでいないのに
    // 予約を外してしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "r7",
        ownerUsername: "someone",
        name: "Proj",
        holdingName: "beutl-rename-x",
        forgejoRepoId: 81,
        operation: "RENAME",
        sourceName: "proj",
      },
    ];
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/81")) {
        return json({
          id: 81,
          name: "proj",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 81, name: "Proj" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    // 改名だけをやり直す。テンプレートの修復には回さない。
    expect(renamedTo).toBe("Proj");
    expect(repairQueue.size).toBe(0);
  });
});

describe("大小だけの改名", () => {
  it("自分の予約とぶつからない", async () => {
    // 行き先と元は同じ鍵になる (一意キーは小文字化した組)。2 本取ろうとすると
    // 自分の 1 本目とぶつかり、通常の改名が必ず失敗する。
    const { renameRepository } = await import("@beutl/forgejo");
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 91, name: "proj", default_branch: "main" });
      }
      if (method === "GET" && path.endsWith("/repositories/91")) {
        return json({
          id: 91,
          name: "proj",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 91, name: "Proj" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      renameRepository("someone", "someone", "proj", "Proj"),
    ).resolves.toMatchObject({ name: "Proj" });

    expect(renamedTo).toBe("Proj");
    expect(reservations.size).toBe(0);
  });
});

describe("削除は相手を確かめてから送る", () => {
  it("名前が別のリポジトリに付け替わっていたら消さない", async () => {
    // 消すのは取り返しがつかない。名前で引いてから送るまでの間に、その名前が
    // 別物に渡ることがある。
    const { deleteRepository } = await import("@beutl/forgejo");
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 95, name: "proj", default_branch: "main" });
      }
      if (method === "GET" && path.endsWith("/repositories/95")) {
        // 送る直前には別のものになっている。
        return json({
          id: 95,
          name: "renamed",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      deleteRepository("someone", "someone", "proj"),
    ).rejects.toMatchObject({ status: 409 });

    expect(deleted).toBe(false);
  });

  it("同じ相手なら消す", async () => {
    const { deleteRepository } = await import("@beutl/forgejo");
    let deletedPath: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 96, name: "proj", default_branch: "main" });
      }
      if (method === "GET" && path.endsWith("/repositories/96")) {
        return json({
          id: 96,
          name: "proj",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "DELETE") {
        deletedPath = path;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await deleteRepository("someone", "someone", "proj");

    expect(deletedPath).toBe("/api/v1/repos/someone/proj");
    expect(reservations.size).toBe(0);
  });
});

describe("削除の予約は、消えたと分かるまで名前を離さない", () => {
  // 待ち時間切れは「Forgejo が削除をやめた」ことの証明ではない。まだ残っているのを
  // 見た瞬間に名前を解放すると、同じ名前で作り直された後に古い削除が着地しうる。
  function reconcileWith(repo: unknown) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repositories/77")) {
        return repo === null
          ? json({ message: "not found" }, 404)
          : json(repo);
      }
      if (method === "DELETE") {
        deletedFromReconcile = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
  }
  let deletedFromReconcile = false;

  beforeEach(() => {
    deletedFromReconcile = false;
  });

  it("消えていれば、その場で名前を解放する", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "d1",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-delete-1",
        forgejoRepoId: 77,
        operation: "DELETE",
        sourceName: "proj",
      },
    ];
    reconcileWith(null);

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("d1");
  });

  it("まだ残っていて日が浅ければ、名前を押さえたままにする", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "d2",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-delete-2",
        forgejoRepoId: 77,
        operation: "DELETE",
        sourceName: "proj",
        createdAt: new Date(),
      },
    ];
    reconcileWith({ id: 77, name: "proj", owner: { id: 2, login: "someone" } });

    await retryGitRepositoryRepairs();

    expect(releasedIds).not.toContain("d2");
    // 自動では消し直さない。消すのは取り返しがつかない。
    expect(deletedFromReconcile).toBe(false);
  });

  it("しばらく待っても残っていたら、行われなかったとして解放する", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "d3",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-delete-3",
        forgejoRepoId: 77,
        operation: "DELETE",
        sourceName: "proj",
        createdAt: new Date(Date.now() - 40 * 60 * 1000),
      },
    ];
    reconcileWith({ id: 77, name: "proj", owner: { id: 2, login: "someone" } });

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("d3");
    expect(deletedFromReconcile).toBe(false);
  });
});

describe("元の名前が分からない改名の予約", () => {
  it("今の名前を元の名前とみなして改名し直さない", async () => {
    // operation と sourceName は同じ migration で入った。それより前に積まれた行には
    // 元の名前が無い。無いものを「今の名前が元の名前だ」と読むと、利用者が後から
    // 付け直した名前まで書き換えてしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "n1",
        ownerUsername: "someone",
        name: "target",
        holdingName: "beutl-rename-legacy",
        forgejoRepoId: 78,
        operation: "RENAME",
        sourceName: null,
      },
    ];
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repositories/78")) {
        // 利用者が後から付け直した名前。
        return json({
          id: 78,
          name: "renamed-by-hand",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 78, name: "target" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(renamedTo).toBeNull();
    expect(releasedIds).not.toContain("n1");
  });
});

describe("改名は 2 つの控えが揃ってから送る", () => {
  it("元の名前側に相手を控えられなければ送らない", async () => {
    const { renameRepository } = await import("@beutl/forgejo");
    // 元の名前の予約 (キーは owner/小文字名) にだけ書けない状況を作る。
    attachFailsFor = ["someone/proj"];
    let patched = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/repos/someone/proj")) {
        return json({ id: 79, name: "proj", default_branch: "main" });
      }
      if (method === "GET" && path.endsWith("/repositories/79")) {
        return json({ id: 79, name: "proj", owner: { id: 2, login: "someone" } });
      }
      if (method === "PATCH") {
        patched = true;
        return json({ id: 79, name: "next" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      renameRepository("someone", "someone", "proj", "next"),
    ).rejects.toThrow();

    expect(patched).toBe(false);
  });
});

describe("Forgejo 側のトークン名", () => {
  it("発行ごとに違う値にする (ラベルは頭に残す)", async () => {
    const names: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/users/someone") && (init?.method ?? "GET") === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if (init?.method === "POST" && path.endsWith("/tokens")) {
        const name = JSON.parse(String(init.body)).name;
        names.push(name);
        return json(
          { id: names.length, name, sha1: TOKEN, token_last_eight: TOKEN.slice(-8) },
          201,
        );
      }
      return json({});
    });

    await issueGitCredential("u1", "desktop");
    await issueGitCredential("u1", "desktop");

    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    for (const name of names) expect(name.startsWith("desktop [")).toBe(true);
  });

  it("応答を落としたとき、同じラベルの別の発行を消さない", async () => {
    // 同じラベルの発行が重なると、名前だけを手掛かりにした後始末は相手の生きた
    // トークンに当たる。平文だけ渡って使えない資格情報が残る。
    let ours: string | null = null;
    const deleted: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/users/someone") && method === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if (method === "POST" && path.endsWith("/tokens")) {
        ours = JSON.parse(String(init?.body)).name;
        throw new Error("socket hang up");
      }
      if (method === "GET" && path.endsWith("/tokens")) {
        // 71 は同じラベルで先に成功した別の発行。ラベルだけを手掛かりにすると
        // こちらに当たる。72 が今回の要求が作った 1 本。
        return json([
          { id: 71, name: "desktop" },
          { id: 72, name: ours },
        ]);
      }
      if (method === "DELETE") {
        deleted.push(path.split("/").at(-1) as string);
        return new Response(null, { status: 204 });
      }
      return json({});
    });

    await expect(issueGitCredential("u1", "desktop")).rejects.toThrow(
      "socket hang up",
    );

    expect(deleted).toEqual(["72"]);
  });

  it("一覧は最後まで読む (51 本目にあっても見つける)", async () => {
    // page=1 だけを読むと 51 本目以降を取り逃す。並び順は発行順ではない (実測)。
    let ours: string | null = null;
    const deleted: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = new URL(String(url));
      const path = target.pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/users/someone") && method === "GET") {
        return json({ id: 2, login: "someone", email: EMAIL });
      }
      if (method === "POST" && path.endsWith("/tokens")) {
        ours = JSON.parse(String(init?.body)).name;
        throw new Error("socket hang up");
      }
      if (method === "GET" && path.endsWith("/tokens")) {
        if (target.searchParams.get("page") === "1") {
          return json(
            Array.from({ length: 50 }, (_, i) => ({
              id: 100 + i,
              name: `other-${i}`,
            })),
          );
        }
        return json([{ id: 200, name: ours }]);
      }
      if (method === "DELETE") {
        deleted.push(path.split("/").at(-1) as string);
        return new Response(null, { status: 204 });
      }
      return json({});
    });

    await expect(issueGitCredential("u1", "desktop")).rejects.toThrow(
      "socket hang up",
    );

    expect(deleted).toEqual(["200"]);
  });
});

describe("直しは名前で送る直前に相手を確かめる", () => {
  it("名前が別のリポジトリに移っていたら、書き込みも読み取り専用も行わない", async () => {
    // 直しは全て名前で送るしかない (contents API も archived の PATCH も id では
    // 送れない)。id から名前を引いてから送るまでの間に改名され、空いた名前を別の
    // リポジトリが取ると、無関係な相手に .gitattributes を書き込み、読み取り
    // 専用にし、そのうえで元の控えを片付けてしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "someone",
      name: "proj",
    });
    let lookups = 0;
    let committed = false;
    let archivedTo: boolean | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        lookups += 1;
        // 1 回目は proj のまま。2 回目 (送る直前の照合) では改名済み。
        return json({
          id: 5,
          name: lookups === 1 ? "proj" : "moved-away",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      // 名前を引き継いだ別のリポジトリ。既定値は入っていない。
      if (path.includes("/contents/.gitattributes")) {
        return json({ message: "not found" }, 404);
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/contents")) {
        committed = true;
        return json({}, 201);
      }
      if (method === "PATCH") {
        archivedTo = JSON.parse(String(init?.body)).archived ?? null;
        return json({ id: 5, name: "proj" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(committed).toBe(false);
    expect(archivedTo).toBeNull();
    // 決着していないので控えは残す。次の周回では id が今の名前を返す。
    expect([...repairQueue.keys()]).toEqual([5]);
  });
});

describe("予約の種別は配備の順序に依存しない", () => {
  it("列に操作が入っていなくても、預かり名で改名と分かる", async () => {
    // migration を先に当てて Worker を後から入れ替える手順では、その間に旧 Worker が
    // 積んだ行が CREATE のまま残る。CREATE として拾うと預かりものの流れに入り、
    // 利用者が編集した .gitattributes を「直す」対象にしてしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "p1",
        ownerUsername: "someone",
        name: "target",
        holdingName: "beutl-rename-6d1c",
        forgejoRepoId: 81,
        operation: "CREATE",
        sourceName: "source",
      },
    ];
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repositories/81")) {
        return json({
          id: 81,
          name: "source",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 81, name: "target" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    // 改名としてやり直す。預かりものの控えには載せない。
    expect(renamedTo).toBe("target");
    expect(repairQueue.size).toBe(0);
    expect(releasedIds).toContain("p1");
  });

  it("元の名前が無い予約は、しばらく置いてから名前だけ手放す", async () => {
    // 押さえたままにすると外す条件が永久に来ず、その名前を恒久的に塞ぐ。
    // 何もせずに手放すだけなので、利用者のリポジトリには触らない。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "p2",
        ownerUsername: "someone",
        name: "target",
        holdingName: "beutl-rename-legacy",
        forgejoRepoId: 82,
        operation: "RENAME",
        sourceName: null,
        createdAt: new Date(Date.now() - 40 * 60 * 1000),
      },
    ];
    let renamedTo: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method === "GET" && path.endsWith("/repositories/82")) {
        return json({
          id: 82,
          name: "renamed-by-hand",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        renamedTo = JSON.parse(String(init?.body)).name;
        return json({ id: 82, name: "target" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(renamedTo).toBeNull();
    expect(releasedIds).toContain("p2");
  });
});

describe("復元で生き返ったものを消し直す", () => {
  it("失効させたトークンが戻っていたら、消し直す", async () => {
    // 退会の墓標には現れない (利用者は生きている)。端末には平文が残っているので、
    // 戻ったまま git を開けると、失効したはずのトークンで通ってしまう。
    const { reconcileGitResurrectionTombstones } = await import("@beutl/forgejo");
    restoreGeneration = "gen-2";
    revocationRows = [
      {
        id: "rev1",
        forgejoUsername: "someone",
        forgejoTokenId: 42,
        lastEight: "deadbeef",
        checkedGeneration: null,
      },
    ];
    let deletedPath: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/tokens")) {
        return json([
          { id: 42, name: "desktop", token_last_eight: "deadbeef", scopes: [] },
        ]);
      }
      if (method === "DELETE") {
        deletedPath = path;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      reconcileGitResurrectionTombstones(),
    ).resolves.toMatchObject({ revoked: 1, checked: 1 });
    expect(deletedPath).toContain("/tokens/42");
    expect(revocationRows[0].checkedGeneration).toBe("gen-2");
  });

  it("同じ id でも中身が別のトークンなら消さない", async () => {
    // 復元で採番がやり直されると、同じ id を別のトークンが持ちうる。id だけで
    // 消すと、その利用者が復元後に作った生きたトークンを消してしまう。
    const { reconcileGitResurrectionTombstones } = await import("@beutl/forgejo");
    restoreGeneration = "gen-2";
    revocationRows = [
      {
        id: "rev1",
        forgejoUsername: "someone",
        forgejoTokenId: 42,
        lastEight: "deadbeef",
        checkedGeneration: null,
      },
    ];
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/tokens")) {
        return json([
          { id: 42, name: "new", token_last_eight: "12345678", scopes: [] },
        ]);
      }
      if (method === "DELETE") deleted = true;
      return new Response(null, { status: 204 });
    });

    await expect(
      reconcileGitResurrectionTombstones(),
    ).resolves.toMatchObject({ revoked: 0, checked: 1 });
    expect(deleted).toBe(false);
  });

  it("消したリポジトリが戻っていたら、消し直す", async () => {
    const { reconcileGitResurrectionTombstones } = await import("@beutl/forgejo");
    restoreGeneration = "gen-2";
    deletionRows = [
      {
        forgejoRepoId: 5,
        ownerUsername: "someone",
        name: "proj",
        needsReview: false,
        checkedGeneration: null,
      },
    ];
    let deletedPath: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "DELETE") {
        deletedPath = path;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      reconcileGitResurrectionTombstones(),
    ).resolves.toMatchObject({ deleted: 1 });
    expect(deletedPath).toContain("/repos/someone/proj");
  });

  it("その id が別のリポジトリなら消さず、人の確認に回す", async () => {
    const { reconcileGitResurrectionTombstones } = await import("@beutl/forgejo");
    restoreGeneration = "gen-2";
    deletionRows = [
      {
        forgejoRepoId: 5,
        ownerUsername: "someone",
        name: "proj",
        needsReview: false,
        checkedGeneration: null,
      },
    ];
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "other",
          default_branch: "main",
          owner: { id: 3, login: "stranger" },
        });
      }
      if (method === "DELETE") deleted = true;
      return new Response(null, { status: 204 });
    });

    await expect(
      reconcileGitResurrectionTombstones(),
    ).resolves.toMatchObject({ review: 1, deleted: 0 });
    expect(deleted).toBe(false);
    expect(deletionRows[0].needsReview).toBe(true);
  });

  it("消えたままなら、この世代の確認済みとして印を書く", async () => {
    const { reconcileGitResurrectionTombstones } = await import("@beutl/forgejo");
    restoreGeneration = "gen-2";
    deletionRows = [
      {
        forgejoRepoId: 5,
        ownerUsername: "someone",
        name: "proj",
        needsReview: false,
        checkedGeneration: null,
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/repositories/5")) {
        return json({ message: "not found" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      reconcileGitResurrectionTombstones(),
    ).resolves.toMatchObject({ deleted: 0, checked: 1 });
    expect(deletionRows[0].checkedGeneration).toBe("gen-2");
  });
});

describe("消す前に控える", () => {
  it("トークンを 1 本失効させたら、消し直す相手を控える", async () => {
    // 控えが無いと、Forgejo を戻したときに何を消し直せばよいのか分からない。
    // GitCredential の行は失効と同時に消えるので、ここにしか残らない。
    const { revokeGitCredential } = await import("@beutl/forgejo");

    await revokeGitCredential("u1", "c1");

    expect(revocationTombstones).toHaveLength(1);
    expect(revocationTombstones[0]).toMatchObject({
      forgejoUsername: "someone",
      forgejoTokenId: 42,
      lastEight: "deadbeef",
    });
  });

  it("リポジトリを消したら、消し直す相手を id で控える", async () => {
    // 名前で控えると、空いた名前を別のリポジトリが取ったときに巻き添えにする。
    const { deleteRepository } = await import("@beutl/forgejo");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repos/someone/proj") && method === "GET") {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      return new Response(null, { status: 204 });
    });

    await deleteRepository("someone", "someone", "proj");

    expect(deletionTombstones).toHaveLength(1);
    expect(deletionTombstones[0]).toMatchObject({
      forgejoRepoId: 5,
      ownerUsername: "someone",
      name: "proj",
    });
  });
});

describe("結果の分からない直しは、片付いたことにしない", () => {
  it("補償の読み取り専用が通っても、控えも名前も残す", async () => {
    // unarchive や commit が 5xx・待ち時間切れで終わると、後から着地しうる。
    // 補償で読み取り専用にできても、遅れて着地した unarchive がそれを外せば、
    // 既定値の入っていないリポジトリがまた書き込み可能になる。控えを外して
    // 名前も手放すと、それを追える記録がどこにも残らない。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(7, {
      forgejoRepoId: 7,
      ownerUsername: "someone",
      name: "proj",
    });
    let archivedTo: boolean | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/7")) {
        return json({
          id: 7,
          name: "proj",
          default_branch: "main",
          archived: false,
          owner: { id: 2, login: "someone" },
        });
      }
      if (path.includes("/contents/.git")) return json({ message: "no" }, 404);
      // テンプレートの書き込みが 5xx。届いたかどうか分からない。
      if (method === "POST" && path.endsWith("/contents")) {
        return json({ message: "boom" }, 500);
      }
      // 補償の読み取り専用は通る。
      if (method === "PATCH") {
        archivedTo = JSON.parse(String(init?.body)).archived ?? null;
        return json({ id: 7, name: "proj" });
      }
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 0,
    });
    // 読み取り専用にはできている。
    expect(archivedTo).toBe(true);
    // それでも片付いてはいない。
    expect([...repairQueue.keys()]).toEqual([7]);
    expect(reservations.size).toBeGreaterThan(0);
  });

  it("4xx で断られたなら、読み取り専用にできた時点で片付いたとみなす", async () => {
    // こちらは届かなかったと言い切れる。遅れて着地するものが無いので、
    // 押さえ続ける理由も無い。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(7, {
      forgejoRepoId: 7,
      ownerUsername: "someone",
      name: "proj",
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/7")) {
        return json({
          id: 7,
          name: "proj",
          default_branch: "main",
          archived: false,
          owner: { id: 2, login: "someone" },
        });
      }
      if (path.includes("/contents/.git")) return json({ message: "no" }, 404);
      if (method === "POST" && path.endsWith("/contents")) {
        return json({ message: "refused" }, 422);
      }
      if (method === "PATCH") return json({ id: 7, name: "proj" });
      return new Response(null, { status: 204 });
    });

    await expect(retryGitRepositoryRepairs()).resolves.toMatchObject({
      fixed: 1,
    });
    expect(repairQueue.size).toBe(0);
    expect(reservations.size).toBe(0);
  });
});

describe("改名で元の名前を押さえた行", () => {
  it("改名が通っていれば、行き先の行と一緒に外す", async () => {
    // 元の名前を押さえた行は旧名しか持たない。行き先と同じ物差し (最終名か) で
    // 見ると永久に食い違い、旧名が二度と使えなくなる。見るべきは「その名前から
    // 動いたか」。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "r-src",
        ownerUsername: "someone",
        name: "old",
        holdingName: "beutl-rename-src-abc",
        forgejoRepoId: 11,
        operation: "RENAME",
        sourceName: "old",
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/user")) return json({ login: "beutl-admin" });
      if (path.endsWith("/repositories/11")) {
        // 改名は通っていた。もう old ではない。
        return json({
          id: 11,
          name: "new",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("r-src");
  });

  it("まだ元の名前のままなら押さえ続ける", async () => {
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "r-src",
        ownerUsername: "someone",
        name: "old",
        holdingName: "beutl-rename-src-abc",
        forgejoRepoId: 11,
        operation: "RENAME",
        sourceName: "old",
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/user")) return json({ login: "beutl-admin" });
      if (path.endsWith("/repositories/11")) {
        return json({
          id: 11,
          name: "old",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).not.toContain("r-src");
  });
});

describe("片付けは、飛ばした行の後ろにも届く", () => {
  it("直しが押さえている行が先頭を占めていても、後ろの放置分を片付ける", async () => {
    // 取得した件数で打ち切ると、触らない行が古い順の先頭に居座り続けたときに、
    // その後ろへ永久に届かない。数えるのは片付けた件数。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    // 直しが動いている行を、既定の取得件数 (20) ぶん先頭に並べる。
    for (let i = 0; i < 20; i += 1) {
      repairQueue.set(100 + i, {
        forgejoRepoId: 100 + i,
        ownerUsername: "someone",
        name: `busy${i}`,
      });
      staleReservations.push({
        id: `busy-${i}`,
        ownerUsername: "someone",
        name: `busy${i}`,
        holdingName: `beutl-repair-busy${i}`,
        forgejoRepoId: 100 + i,
        operation: "CREATE",
        sourceName: null,
      });
    }
    // その後ろに、放置された預かり名を 1 つ。
    staleReservations.push({
      id: "abandoned",
      ownerUsername: "someone",
      name: "left",
      holdingName: "beutl-repair-left",
      forgejoRepoId: 999,
      operation: "CREATE",
      sourceName: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/user")) return json({ login: "beutl-admin" });
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("abandoned");
  });
});

describe("名前を押さえてから触る", () => {
  it("その名前を誰かが動かしている間は、直しに入らない", async () => {
    // id を確かめるだけでは、確認から送信までの 1 往復が開いたまま。その間に
    // 相手が改名され、空いた名前を別のリポジトリが取ると、無関係な相手へ
    // .gitattributes を書き、読み取り専用を掛けてしまう。名前そのものを押さえる。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "someone",
      name: "proj",
    });
    // 別の操作 (作成・改名・削除のどれか) が既にこの名前を押さえている。
    reservations.set("someone/proj", {
      id: "someone/proj",
      holdingName: "beutl-holding-other",
      forgejoRepoId: 6,
    });
    let committed = false;
    let archivedTo: boolean | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "proj",
          default_branch: "main",
          owner: { id: 2, login: "someone" },
        });
      }
      if (path.includes("/contents/.git")) {
        return json({ message: "not found" }, 404);
      }
      if (method === "POST" && path.endsWith("/contents")) {
        committed = true;
        return json({}, 201);
      }
      if (method === "PATCH") {
        archivedTo = JSON.parse(String(init?.body)).archived ?? null;
        return json({ id: 5, name: "proj" });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    // Forgejo には何も送らない。控えは残るので次の周回でやり直す。
    expect(committed).toBe(false);
    expect(archivedTo).toBeNull();
    expect([...repairQueue.keys()]).toEqual([5]);
  });

  it("譲渡の間は、渡す先の名前空間でも預かり名を押さえる", async () => {
    // 譲渡した瞬間から利用者はそのリポジトリの持ち主になる。最後の改名まで、
    // 渡す先の名前空間でその名前を誰も守っていない状態を作らない。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(5, {
      forgejoRepoId: 5,
      ownerUsername: "beutl-admin",
      name: "beutl-holding-abc",
      intendedOwner: "someone",
      intendedName: "proj",
    });
    let heldAtTransfer: string[] = [];
    let transferred = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (path.endsWith("/repositories/5")) {
        return json({
          id: 5,
          name: "beutl-holding-abc",
          default_branch: "main",
          owner: transferred
            ? { id: 2, login: "someone" }
            : { id: 1, login: "beutl-admin" },
        });
      }
      if (path.includes("/contents/.gitattributes")) {
        return json({ encoding: "base64", content: utf8Base64(GITATTRIBUTES) });
      }
      if (path.includes("/contents/.gitignore")) {
        return json({ encoding: "base64", content: utf8Base64(GITIGNORE) });
      }
      if (method === "POST" && path.endsWith("/transfer")) {
        heldAtTransfer = [...reservations.keys()];
        transferred = true;
        return json({
          id: 5,
          name: "beutl-holding-abc",
          owner: { id: 2, login: "someone" },
        });
      }
      if (method === "PATCH") {
        return json({ id: 5, name: "proj", owner: { id: 2, login: "someone" } });
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(heldAtTransfer).toContain("someone/beutl-holding-abc");
    // 終わったら手放す。押さえたままにすると、その名前を永久に塞ぐ。
    expect(reservations.size).toBe(0);
  });

  it("直しがまだ回るなら、押さえた名前は片付け側が触らない", async () => {
    // 直しは複数の API 呼び出しを行い、その間に名前の期限が切れることがある。
    // 切れたからと外すと、動いている直しと並行して同じ名前を別の作成が取れる。
    // 外さないだけでなく**掴みもしない**。掴むと期限が伸び、直し側が引き継げない。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(88, {
      forgejoRepoId: 88,
      ownerUsername: "someone",
      name: "proj",
    });
    staleReservations = [
      {
        id: "h1",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-repair-inflight",
        forgejoRepoId: 88,
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/user")) return json({ login: "beutl-admin" });
      if (path.endsWith("/repositories/88")) {
        return json({ message: "not found" }, 404);
      }
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).not.toContain("h1");
  });

  it("人の確認待ちで止まった控えの名前は手放す", async () => {
    // 人が見るまで直しは進まない。押さえたままにすると、その間ずっとその名前の
    // 作成を塞ぐ。直しの側から外し損ねてもここで拾えるようにしておく。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    repairQueue.set(88, {
      forgejoRepoId: 88,
      ownerUsername: "someone",
      name: "proj",
      needsReview: true,
    });
    staleReservations = [
      {
        id: "h1",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-repair-stalled",
        forgejoRepoId: 88,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/user")) return json({ login: "beutl-admin" });
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("h1");
  });

  it("押さえただけの予約は、放置されていれば名前を手放すだけ", async () => {
    // やり残した作業は控え (リポジトリ id) の側にあるので、こちらは名前を
    // 手放すだけでよい。預かりものの流れに乗せると、利用者が編集した
    // .gitattributes を「直す」対象にしてしまう。
    const { retryGitRepositoryRepairs } = await import("@beutl/forgejo");
    staleReservations = [
      {
        id: "h1",
        ownerUsername: "someone",
        name: "proj",
        holdingName: "beutl-repair-abandoned",
        forgejoRepoId: 88,
        operation: "CREATE",
        sourceName: null,
        // 遅れて着地しうる幅 (30 分) は過ぎている。
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];
    let touched = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/user")) {
        return json({ login: "beutl-admin" });
      }
      if (method !== "GET") touched = true;
      return new Response(null, { status: 204 });
    });

    await retryGitRepositoryRepairs();

    expect(releasedIds).toContain("h1");
    expect(touched).toBe(false);
    expect(repairQueue.size).toBe(0);
  });
});
