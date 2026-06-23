import "server-only";
import type { ConfirmationTokenPurpose } from "@prisma/client";
import { createHash, randomString } from "@/lib/create-hash";
import {
  createConfirmationToken,
  deleteConfirmationTokenByIdentifierToken,
} from "@/lib/db/confirmation-token";

type ConfirmationTokenData = {
  identifier: string;
  expires: Date;
  userId: string;
  purpose: ConfirmationTokenPurpose;
};

type IssueConfirmationTokenOptions = {
  identifier: string;
  userId: string;
  purpose: ConfirmationTokenPurpose;
};

type ConsumeConfirmationTokenOptions = {
  token: string;
  identifier: string;
  purpose: ConfirmationTokenPurpose;
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

function isRecordNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  );
}

export async function issueConfirmationToken({
  identifier,
  userId,
  purpose,
}: IssueConfirmationTokenOptions) {
  const token = randomString(32);
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  await createConfirmationToken({
    token: hash,
    identifier,
    userId,
    expires,
    purpose,
  });
  return token;
}

export async function consumeConfirmationToken({
  token,
  identifier,
  purpose,
}: ConsumeConfirmationTokenOptions): Promise<ConsumeConfirmationTokenResult> {
  const secret = process.env.AUTH_SECRET;
  const hash = await createHash(`${token}${secret}`);
  const tokenData = await deleteConfirmationTokenByIdentifierToken({
    identifier,
    token: hash,
  }).catch((error: unknown) => {
    if (isRecordNotFoundError(error)) {
      return null;
    }
    return Promise.reject(error);
  });

  if (!tokenData || tokenData.purpose !== purpose) {
    return { valid: false, reason: "invalid" };
  }

  if (tokenData.expires.valueOf() < Date.now()) {
    return { valid: false, reason: "expired", tokenData };
  }

  return { valid: true, tokenData };
}
