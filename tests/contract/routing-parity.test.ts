import { describe, expect, it, beforeAll } from "vitest";
import { Hono } from "hono";
import { v1, v2, v3, api } from "@beutl/api";
import { setDbProvider } from "@beutl/db";

// Web (route.ts) と Worker (worker.ts) の合成が同一レスポンスを返すことを検証する。
// ルーティング等価性テスト: basePath 付き合成 vs プレフィックス付きマウント。
//
// NOTE: Hono の basePath は app 1 つにつき 1 つしか設定できないため、
// Web 合成は v1 と v3 を別々の app として比較する。

function webV1() {
  return new Hono().basePath("/api/v1").route("/", v1);
}

function webV3() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

describe("Web 合成 vs Worker 合成のルーティング等価性", () => {
  beforeAll(() => {
    // DB アクセスを伴うエンドポイント用の最小モック。
    // findPackageBasicByName が null を返し 404 になるようにする。
    const prisma = {
      package: {
        findFirst: async () => null,
        findMany: async () => [],
      },
      userPackage: {
        findFirst: async () => null,
      },
      userPaymentHistory: {
        findFirst: async () => null,
      },
      $transaction: async (fn: any) => fn({}),
    } as any;
    setDbProvider(async () => prisma);
  });

  it("v1 createAuthUri が両合成で同じエラーレスポンスを返す", async () => {
    const webRes = await webV1().request("/api/v1/account/createAuthUri", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const workerRes = await api.request("/api/v1/account/createAuthUri", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(webRes.status).toBe(workerRes.status);
    expect(await webRes.json()).toEqual(await workerRes.json());
  });

  it("v3 packages/:name が両合成で同じ 404 エンベロープを返す", async () => {
    const webRes = await webV3().request("/api/v3/packages/__nonexistent__", {
      headers: { host: "beutl.beditor.net" },
    });
    const workerRes = await api.request("/api/v3/packages/__nonexistent__", {
      headers: { host: "beutl.beditor.net" },
    });

    expect(webRes.status).toBe(workerRes.status);
    expect(await webRes.json()).toEqual(await workerRes.json());
  });

  it("v2 signInWith が両合成で 307 を返す", async () => {
    const webRes = await new Hono()
      .basePath("/api/v2")
      .route("/", v2)
      .request(
        "/api/v2/identity/signInWith?provider=github&returnUrl=https%3A%2F%2Fbeutl.beditor.net%2F",
      );
    const workerRes = await api.request(
      "/api/v2/identity/signInWith?provider=github&returnUrl=https%3A%2F%2Fbeutl.beditor.net%2F",
    );

    expect(webRes.status).toBe(307);
    expect(workerRes.status).toBe(307);
    expect(workerRes.headers.get("location")).toBe(
      webRes.headers.get("location"),
    );
  });
});
