import {
  createDpopReplayStore,
  getConfirmationJkt,
  requestToResourceInput,
  verifyAccessTokenRequest,
} from "better-auth/oauth2";
import { getDb } from "@beutl/db";
import {
  NATIVE_CLIENT_ID,
  NATIVE_SCOPE,
  nativeOAuthConfirmation,
  nativeOAuthIssuer,
  nativeOAuthResource,
} from "@beutl/core";

export async function verifyNativeOAuthRequest(request: Request): Promise<string | null> {
  try {
    const db = await getDb();
    const payload = await verifyAccessTokenRequest(requestToResourceInput(request), {
      jwksUrl: `${nativeOAuthIssuer()}/jwks`,
      verifyOptions: {
        issuer: nativeOAuthIssuer(),
        audience: nativeOAuthResource(),
        algorithms: ["ES256"],
      },
      requiredScopes: [NATIVE_SCOPE],
      dpop: {
        signingAlgorithms: ["ES256"],
        replayStore: createDpopReplayStore({
          reserveVerificationValue: async (data) => {
            const result = await db.verification.createMany({
              data: { ...data, id: `native-dpop:${data.identifier}` },
              skipDuplicates: true,
            });
            return result.count === 1;
          },
        }),
      },
    });
    const keyThumbprint = getConfirmationJkt(payload.cnf);
    if (!payload.sub || payload.client_id !== NATIVE_CLIENT_ID || !keyThumbprint) return null;
    // JWT signatures alone cannot reflect a device disconnection. Consult the provider-owned grant.
    const activeGrant = await db.oauthRefreshToken.findFirst({
      where: {
        userId: payload.sub,
        clientId: NATIVE_CLIENT_ID,
        revoked: null,
        expiresAt: { gt: new Date() },
        confirmation: nativeOAuthConfirmation(keyThumbprint),
      },
      select: { id: true },
    });
    if (!activeGrant) return null;
    // A refresh already in flight must not restore a disconnected registration.
    const device = await db.nativeDevice.findUnique({
      where: {
        userId_clientId_keyThumbprint: {
          userId: payload.sub,
          clientId: NATIVE_CLIENT_ID,
          keyThumbprint,
        },
      },
      select: { id: true },
    });
    return device ? payload.sub : null;
  } catch {
    // Invalid proofs, revoked grants, and unavailable verification all fail closed as unauthenticated.
    return null;
  }
}
