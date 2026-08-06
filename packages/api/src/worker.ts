// beutl-web-api: デスクトップアプリ向け API 専用 Cloudflare Worker。
// 同一ドメイン・パス分割 (beutl.beditor.net/api/v{1,2,3}/*) で受ける。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { setDbProvider } from "@beutl/db";
import { api } from "@beutl/api";

export interface Env {
  BEUTL_DATABASE_HYPERDRIVE: {
    connectionString: string;
  };
  // vars (wrangler.jsonc) と secrets (wrangler secret put) の文字列バインディング。
  // workerd はこれらを process.env に自動投入しないため、fetch 冒頭でコピーする。
  // ここに列挙したキーは「vars/secrets に設定されていれば」コピーされる。
  // 未設定のキー (例: BEUTL_LATEST_VERSION) は undefined のまま (Web 側と同挙動)。
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWT_EXPIRATION_MINUTES?: string;
  JWT_REFRESH_TOKEN_EXPIRATION_DAYS?: string;
  PUBLIC_ORIGIN?: string;
  IPINFO_TOKEN?: string;
  BEUTL_LATEST_VERSION?: string;
  BEUTL_REQUIRED_VERSION?: string;
  ADMIN_USER_IDS?: string;
}

// Hyperdrive の per-request 接続モデル (maxUses:1) に合わせ、毎リクエスト新規生成する。
// モジュールスコープで PrismaClient を保持しない (isolate 跨ぎのリーク防止)。
const createProvider = (env: Env) => {
  return async () => {
    const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
    if (!connectionString) {
      throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
    }
    const adapter = new PrismaPg({ connectionString, maxUses: 1 });
    return new PrismaClient({ adapter });
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // workerd は vars/secrets を process.env に自動投入しない。
    // OpenNext (Web Worker) の populateProcessEnv と同じく文字列バインディングを
    // process.env へコピーする。v1/account (JWT) や v1/app (バージョン) は
    // process.env を直接参照するため、これがないと独立 Worker で undefined になる。
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }
    setDbProvider(createProvider(env));
    return api.fetch(request, env);
  },
};
