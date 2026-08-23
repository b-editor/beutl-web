import { ForgejoConfigurationError, ForgejoError } from "./errors";

export type ForgejoConfig = {
  /** 末尾スラッシュなしのベース URL。例: https://git.beutl.beditor.net */
  baseUrl: string;
  /** サイト管理者のアクセストークン。git-server の bootstrap.sh が発行する。 */
  adminToken: string;
  /** Caddy が /api/v1/* に要求する共有シークレット。 */
  proxySecret: string;
};

export function getForgejoConfig(): ForgejoConfig {
  const baseUrl = process.env.FORGEJO_BASE_URL;
  const adminToken = process.env.FORGEJO_ADMIN_TOKEN;
  const proxySecret = process.env.FORGEJO_PROXY_SECRET;

  const missing = [
    !baseUrl && "FORGEJO_BASE_URL",
    !adminToken && "FORGEJO_ADMIN_TOKEN",
    !proxySecret && "FORGEJO_PROXY_SECRET",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new ForgejoConfigurationError(
      `Forgejo is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    adminToken: adminToken!,
    proxySecret: proxySecret!,
  };
}

export function isForgejoConfigured(): boolean {
  return Boolean(
    process.env.FORGEJO_BASE_URL &&
      process.env.FORGEJO_ADMIN_TOKEN &&
      process.env.FORGEJO_PROXY_SECRET,
  );
}

/**
 * すべての API 呼び出しの既定の待ち時間 (ミリ秒)。
 *
 * 期限付きの印を握って進める処理がいくつもある。待ち続ける呼び出しが 1 つでも
 * 残っていると、そこで期限を追い越し、引き取られた後も自分は気付かないまま
 * 外部への変更を続けてしまう。**既定で切る**。
 *
 * 管理 API の応答は通常 1 秒未満。大きいのは purge くらいで、それでもこの幅に
 * 収まる。個別に伸ばしたい場合は timeoutMs で上書きする。
 */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON として送るリクエストボディ。 */
  body?: unknown;
  /**
   * このユーザーとして実行する (Forgejo の Sudo 代理実行)。
   * トークン管理エンドポイントだけは Sudo を受け付けないので注意。
   */
  sudo?: string;
  /**
   * 管理トークンではなく対象ユーザーの Basic 認証を使う。
   * Sudo が効かないトークン管理エンドポイント専用。
   */
  basicAuth?: { username: string; password: string };
  searchParams?: Record<string, string | number | boolean | undefined>;
  /** レスポンスをテキストとして受け取る (raw ファイルの取得など)。 */
  responseType?: "json" | "text" | "none";
  /** 待ち時間の上限 (ミリ秒)。既定は DEFAULT_TIMEOUT_MS。 */
  timeoutMs?: number;
  config?: ForgejoConfig;
};

async function request(
  path: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const config = options.config ?? getForgejoConfig();
  const method = options.method ?? "GET";

  const url = new URL(`${config.baseUrl}/api/v1${path}`);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({
    Accept: "application/json",
    // Caddy が /api/v1/* に対して一致を要求する。
    "X-Beutl-Proxy-Secret": config.proxySecret,
  });

  if (options.basicAuth) {
    const credentials = btoa(
      `${options.basicAuth.username}:${options.basicAuth.password}`,
    );
    headers.set("Authorization", `Basic ${credentials}`);
  } else {
    headers.set("Authorization", `token ${config.adminToken}`);
    if (options.sudo) {
      headers.set("Sudo", options.sudo);
    }
  }

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ForgejoError(
      response.status,
      method,
      path,
      await response.text().catch(() => ""),
    );
  }

  const responseType = options.responseType ?? "json";
  if (responseType === "none" || response.status === 204) {
    return undefined;
  }
  if (responseType === "text") {
    return await response.text();
  }

  const text = await response.text();
  return text.length === 0 ? undefined : JSON.parse(text);
}

export async function forgejoRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return (await request(path, options)) as T;
}

/**
 * 404 を null に畳む。「無ければ作る」系の処理で使う。
 */
export async function forgejoRequestOrNull<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T | null> {
  try {
    return await forgejoRequest<T>(path, options);
  } catch (error) {
    if (error instanceof ForgejoError && error.isNotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * レスポンスをそのまま返す低レベル版。大きなファイルを読み切らずに
 * 中継したいとき (LFS の実体のダウンロード) に使う。
 */
export async function forgejoFetch(
  path: string,
  {
    sudo,
    config,
    forwardHeaders,
  }: {
    sudo?: string;
    config?: ForgejoConfig;
    /** ブラウザから受け取ったまま Forgejo へ渡すヘッダ (Range など)。 */
    forwardHeaders?: Record<string, string | null>;
  } = {},
): Promise<Response> {
  const resolved = config ?? getForgejoConfig();
  const headers = new Headers({
    Authorization: `token ${resolved.adminToken}`,
    "X-Beutl-Proxy-Secret": resolved.proxySecret,
  });
  if (sudo) {
    headers.set("Sudo", sudo);
  }
  const safeHeaders = new Headers();
  for (const [name, value] of Object.entries(forwardHeaders ?? {})) {
    if (value) {
      headers.set(name, value);
      safeHeaders.set(name, value);
    }
  }

  // 自動追跡させない。fetch は cross-origin のリダイレクトでも Authorization 以外の
  // ヘッダを引き継ぐので (実測: X-Beutl-Proxy-Secret と Sudo が転送された)、
  // LFS_SERVE_DIRECT=true のとき共有シークレットがストレージ事業者に届く。
  const response = await fetch(`${resolved.baseUrl}/api/v1${path}`, {
    headers,
    redirect: "manual",
  });

  const location = response.headers.get("Location");
  if (response.status >= 300 && response.status < 400 && location) {
    // 署名付き URL。認証はクエリに載っているので、こちらの資格情報は付けない。
    await response.body?.cancel();
    return await fetch(new URL(location, resolved.baseUrl), {
      headers: safeHeaders,
    });
  }

  return response;
}

/**
 * git のリモート URL。デスクトップはここに対して clone / push する。
 * 認証はユーザー名 + アクセストークンの Basic 認証。
 */
export function buildCloneUrl(
  owner: string,
  repositoryName: string,
  config: ForgejoConfig = getForgejoConfig(),
) {
  return `${config.baseUrl}/${owner}/${repositoryName}.git`;
}
