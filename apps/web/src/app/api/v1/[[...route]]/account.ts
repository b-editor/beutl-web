import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getUserId, getUserIdFromToken } from "@/lib/api/auth";
import { apiErrorResponse } from "@/lib/api/error";
import { getDbAsync } from "@/prisma";
import { sign } from "hono/jwt";

const createAuthUriSchema = z.object({
  continue_uri: z.string().url(),
});

const refreshTokenSchema = z.object({
  refresh_token: z.string(),
  token: z.string(),
});

const exchangeSchema = z.object({
  code: z.string(),
  session_id: z.string(),
});

async function getKeyMaterial(secret: string) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return keyMaterial;
}

async function deriveKey(keyMaterial: CryptoKey, salt: Uint8Array) {
  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    {
      name: "AES-CBC",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

async function getKey(salt: Uint8Array) {
  const keyMaterial = await getKeyMaterial(process.env.JWT_SECRET as string);
  return await deriveKey(keyMaterial, salt);
}

async function decryptRefreshToken(token: string) {
  try {
    const data = Buffer.from(token, "base64");
    const iv = data.subarray(0, 16);
    const salt = data.subarray(16, 32);
    const encryptedData = data.subarray(32);
    const key = await getKey(salt);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-CBC",
        iv: iv,
      },
      key,
      encryptedData,
    );

    return Buffer.from(decrypted).toString("utf8");
  } catch {
    return null;
  }
}

async function encryptRefreshToken(token: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await getKey(salt);
  const iv = new Uint8Array(16);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-CBC",
      iv: iv,
    },
    key,
    Buffer.from(token, "utf8"),
  );

  return Buffer.concat([iv, salt, new Uint8Array(encrypted)]).toString(
    "base64",
  );
}

async function createJwtToken(userId: string) {
  const exp =
    Math.floor(Date.now() / 1000) +
    60 * Number.parseInt(process.env.JWT_EXPIRATION_MINUTES ?? "5");
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        userId,
      jti: crypto.randomUUID(),
      iss: process.env.JWT_ISSUER,
      aud: process.env.JWT_AUDIENCE,
      exp: exp,
      nbf: Math.floor(Date.now() / 1000),
    },
    process.env.JWT_SECRET as string,
  );

  return {
    token,
    exp: new Date(exp * 1000),
  };
}

async function createRefreshToken(userId: string) {
  const rawToken = crypto.randomUUID();
  const encToken = await encryptRefreshToken(rawToken);
  const expires = new Date(
    Date.now() +
      1000 *
        60 *
        60 *
        24 *
        Number.parseInt(process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS ?? "30"),
  );
  const db = await getDbAsync();
  await db.session.create({
    data: {
      sessionToken: rawToken,
      expires: expires,
      userId: userId,
    },
  });

  return {
    encToken,
    rawToken,
    expires,
  };
}

const app = new Hono()
  .post(
    "/createAuthUri",
    zValidator("json", createAuthUriSchema),
    async (c) => {
      const { continue_uri } = c.req.valid("json");

      const url = new URL(continue_uri);
      if (
        url.hostname !== "localhost" &&
        url.hostname !== "beutl.beditor.net"
      ) {
        return c.json(await apiErrorResponse("invalidRequestBody"), {
          status: 400,
        });
      }
      const db = await getDbAsync();
      const auth = await db.nativeAppAuth.create({
        data: {
          continueUrl: continue_uri,
        },
      });
      const currentUrl = new URL(c.req.url);
      return c.json({
        auth_uri: `${currentUrl.origin}/account/native-auth/handler?identifier=${auth.id}`,
        session_id: auth.sessionId,
      });
    },
  )
  .get("/handler", async (c) => {
    const userId = await getUserId(c);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const identifier = c.req.query("identifier");
    if (!identifier) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }
    const db = await getDbAsync();
    const auth = await db.nativeAppAuth.findFirst({
      where: { id: identifier },
    });
    if (!auth) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    const { code, continueUrl } = await db.nativeAppAuth.update({
      where: { id: identifier },
      data: {
        userId,
        code: crypto.randomUUID(),
        codeExpires: new Date(Date.now() + 1000 * 60 * 30),
      },
      select: {
        code: true,
        continueUrl: true,
      },
    });

    const url = new URL(continueUrl);
    url.searchParams.set("code", code ?? "");
    return c.redirect(url.toString());
  })
  .post("/refresh", zValidator("json", refreshTokenSchema), async (c) => {
    const { refresh_token, token } = c.req.valid("json");
    const userId = getUserIdFromToken(token);
    if (!userId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    const oldDecryptedRefreshToken = await decryptRefreshToken(refresh_token);
    if (!oldDecryptedRefreshToken) {
      return c.json(await apiErrorResponse("invalidRefreshToken"), {
        status: 401,
      });
    }

    const db = await getDbAsync();
    const oldRefreshTokens = await db.session.deleteMany({
      where: {
        sessionToken: oldDecryptedRefreshToken,
      },
    });
    if (!oldRefreshTokens.count) {
      return c.json(await apiErrorResponse("invalidRefreshToken"), {
        status: 401,
      });
    }

    const { exp: accessTokenExp, token: accessToken } =
      await createJwtToken(userId);

    const { encToken } = await createRefreshToken(userId);

    return c.json({
      token: accessToken,
      refresh_token: encToken,
      expiration: accessTokenExp,
    });
  })
  .post("/code2jwt", zValidator("json", exchangeSchema), async (c) => {
    const { session_id, code } = c.req.valid("json");
    const db = await getDbAsync();
    const auth = await db.nativeAppAuth.findFirst({
      where: {
        sessionId: session_id,
      },
    });

    if (
      !auth ||
      !auth.codeExpires ||
      !auth.userId ||
      auth.codeExpires.valueOf() <= Date.now() ||
      auth.code !== code
    ) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 401,
      });
    }
    await db.nativeAppAuth.deleteMany({
      where: {
        sessionId: session_id,
      },
    });

    const { exp: accessTokenExp, token: accessToken } = await createJwtToken(
      auth.userId,
    );

    const { encToken } = await createRefreshToken(auth.userId);

    return c.json({
      token: accessToken,
      refresh_token: encToken,
      expiration: accessTokenExp,
    });
  });

export default app;
