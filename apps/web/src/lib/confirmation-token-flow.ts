import "server-only";
import type { ConfirmationTokenPurpose } from "@prisma/client";
import { createHash, randomString } from "@beutl/core";
import {
  authorizeAccountDeletionIntent,
  consumeConfirmationTokenByIdentifierToken,
  createConfirmationToken,
  findConfirmationTokenByIdentifierToken,
  type PrismaTransaction,
} from "@beutl/db";

type ConfirmationTokenData = {
  identifier: string;
  expires: Date;
  userId: string;
  purpose: ConfirmationTokenPurpose;
  sessionId?: string | null;
  sourceEmail?: string | null;
};

type IssueConfirmationTokenOptions = {
  identifier: string;
  userId: string;
  purpose: ConfirmationTokenPurpose;
  sessionId?: string;
  sourceEmail?: string;
  prisma?: PrismaTransaction;
};

type ConsumeConfirmationTokenOptions = {
  token: string;
  identifier: string;
  purpose: ConfirmationTokenPurpose;
  authorizedUserId?: string;
  authorizedSessionId?: string;
  prisma?: PrismaTransaction;
};

type ConsumeConfirmationTokenResult =
  | {
      valid: true;
      tokenData: ConfirmationTokenData;
    }
  | {
      valid: false;
      reason: "invalid" | "expired";
      tokenData?: ConfirmationTokenData;
    };

type ValidateConfirmationTokenResult =
  | {
      valid: true;
      tokenData: ConfirmationTokenData;
      tokenHash: string;
    }
  | {
      valid: false;
      reason: "invalid" | "expired";
      tokenData?: ConfirmationTokenData;
    };

function confirmationSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not configured");
  }
  return secret;
}

async function hashConfirmationToken(token: string): Promise<string> {
  return await createHash(`${token}${confirmationSecret()}`);
}

export async function issueConfirmationToken({
  identifier,
  userId,
  purpose,
  sessionId,
  sourceEmail,
  prisma,
}: IssueConfirmationTokenOptions) {
  const token = randomString(32);
  const emailChange = purpose === "EMAIL_UPDATE" || purpose === "EMAIL_UPDATE_APPROVAL";
  const expires = new Date(Date.now() + (emailChange ? 1 : 24) * 60 * 60 * 1000);
  const hash = await hashConfirmationToken(token);
  await createConfirmationToken(
    {
      token: hash,
      identifier,
      userId,
      expires,
      purpose,
      ...(sessionId ? { sessionId } : {}),
      ...(sourceEmail ? { sourceEmail } : {}),
    },
    prisma,
  );
  return token;
}

export async function consumeConfirmationToken({
  token,
  identifier,
  purpose,
  authorizedUserId,
  authorizedSessionId,
  prisma,
}: ConsumeConfirmationTokenOptions): Promise<ConsumeConfirmationTokenResult> {
  const result = await validateConfirmationToken({ token, identifier, purpose, prisma });
  if (!result.valid) return result;
  const emailChange = purpose === "EMAIL_UPDATE" || purpose === "EMAIL_UPDATE_APPROVAL";
  if (emailChange && (!authorizedSessionId || authorizedUserId !== result.tokenData.userId)) {
    return { valid: false, reason: "invalid" };
  }

  const consumed = await consumeConfirmationTokenByIdentifierToken({
    identifier,
    token: result.tokenHash,
    purpose,
    userId: result.tokenData.userId,
    now: new Date(),
    ...(emailChange
      ? {
          sessionId: result.tokenData.sessionId!,
          sourceEmail: result.tokenData.sourceEmail!,
          authorizedSessionId,
        }
      : {}),
    prisma,
  });
  return consumed
    ? { valid: true, tokenData: result.tokenData }
    : { valid: false, reason: "invalid" };
}

export async function validateConfirmationToken({
  token,
  identifier,
  purpose,
  prisma,
}: ConsumeConfirmationTokenOptions): Promise<ValidateConfirmationTokenResult> {
  const hash = await hashConfirmationToken(token);
  const tokenData = await findConfirmationTokenByIdentifierToken(
    {
      identifier,
      token: hash,
    },
    prisma,
  );

  if (!tokenData || tokenData.purpose !== purpose) {
    return { valid: false, reason: "invalid" };
  }

  if (
    (purpose === "EMAIL_UPDATE" || purpose === "EMAIL_UPDATE_APPROVAL") &&
    (!tokenData.sessionId ||
      !tokenData.sourceEmail ||
      !tokenData.session ||
      tokenData.session.userId !== tokenData.userId ||
      tokenData.session.expiresAt.valueOf() <= Date.now() ||
      tokenData.user.email !== tokenData.sourceEmail)
  )
    return { valid: false, reason: "invalid" };

  if (tokenData.expires.valueOf() <= Date.now()) {
    return { valid: false, reason: "expired", tokenData };
  }

  return { valid: true, tokenData, tokenHash: hash };
}

export async function authorizeAccountDeletion({
  token,
  identifier,
  now,
}: {
  token: string;
  identifier: string;
  now?: Date;
}) {
  return await authorizeAccountDeletionIntent({
    identifier,
    tokenHash: await hashConfirmationToken(token),
    now,
  });
}
