import { oauthProvider, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins/jwt";
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import type { PrismaClient } from "@prisma/client";
import { getDb } from "@beutl/db";
import {
  NATIVE_CLIENT_ID,
  NATIVE_SCOPES,
  NATIVE_SCOPE,
  nativeOAuthIssuer,
  nativeOAuthResource,
  validNativeDeviceName,
} from "@beutl/core";

export function nativeOAuthPlugins(prisma: PrismaClient) {
  return [
    jwt({ jwt: { issuer: nativeOAuthIssuer() }, jwks: { keyPairConfig: { alg: "ES256" } } }),
    oauthProvider({
      loginPage: "/account/native-auth/oauth-sign-in",
      consentPage: "/account/native-auth/handler",
      scopes: [...NATIVE_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
      // Only the migration-provisioned native client is available; there is no DCR.
      enforcePerClientResources: false,
      resources: [
        {
          identifier: nativeOAuthResource(),
          name: "Beutl API",
          allowedScopes: [...NATIVE_SCOPES],
          accessTokenTtl: 15 * 60,
          dpopBoundAccessTokensRequired: true,
        },
      ],
      dpop: { signingAlgorithms: ["ES256"] },
      customTokenResponseFields: async ({ grantType, user, verificationValue }) => {
        if (grantType !== "authorization_code" || !user || !verificationValue) return {};
        const query = verificationValue.query;
        const name = (query as typeof query & { device_name?: unknown }).device_name;
        const keyThumbprint = query.dpop_jkt;
        if (
          query.client_id !== NATIVE_CLIENT_ID ||
          !validNativeDeviceName(name) ||
          !keyThumbprint
        ) {
          throw new APIError("BAD_REQUEST", { error: "invalid_request" });
        }
        await prisma.nativeDevice.upsert({
          where: {
            userId_clientId_keyThumbprint: {
              userId: user.id,
              clientId: NATIVE_CLIENT_ID,
              keyThumbprint,
            },
          },
          create: { userId: user.id, clientId: NATIVE_CLIENT_ID, keyThumbprint, name: name.trim() },
          update: { name: name.trim() },
        });
        return {};
      },
    }),
  ];
}

export const nativeOAuthBefore = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/oauth2/authorize") {
    // Match the provider's parameter source, including form POSTs and duplicate parameters.
    const params = ctx.method === "POST" ? ctx.body : ctx.query;
    if (params?.client_id === NATIVE_CLIENT_ID) {
      const scopes = typeof params.scope === "string" ? params.scope.split(" ") : [];
      const prompts = typeof params.prompt === "string" ? params.prompt.split(" ") : [];
      if (
        !validNativeDeviceName(params.device_name) ||
        !NATIVE_SCOPES.every((scope) => scopes.includes(scope)) ||
        !prompts.includes("consent")
      ) {
        throw new APIError("BAD_REQUEST", { error: "invalid_request" });
      }
    }
    return;
  }
  if (ctx.path !== "/oauth2/consent" || ctx.body?.accept !== true) return;
  const session = await getAuthoritativeSessionFromCtx(ctx);
  if (!session) throw new APIError("UNAUTHORIZED");
  const prisma = await getDb();
  if (!(await prisma.passkey.count({ where: { userId: session.user.id } }))) return;
  const persisted = await prisma.session.findUnique({ where: { id: session.session.id } });
  if (
    !persisted?.passkeyVerifiedAt ||
    Date.now() - persisted.passkeyVerifiedAt.getTime() > 5 * 60_000
  ) {
    throw new APIError("FORBIDDEN", {
      code: "PASSKEY_VERIFICATION_REQUIRED",
      message: "Confirm with your passkey",
    });
  }
});

export async function readNativeOAuthQuery(query: string, secret: string) {
  if (!(await verifyOAuthQueryParams(query, secret))) return null;
  const params = new URLSearchParams(query);
  const name = params.get("device_name");
  if (
    params.get("client_id") !== NATIVE_CLIENT_ID ||
    !validNativeDeviceName(name) ||
    !params.get("scope")?.split(" ").includes(NATIVE_SCOPE)
  )
    return null;
  return { name, params };
}
