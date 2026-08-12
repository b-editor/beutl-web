import { ConfirmationTokenPurpose } from "@prisma/client";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { enqueueUserRemoteAiJobCleanups } from "./ai-job";
import { prepareTopUpsForAccountDeletion } from "./top-up-checkout-attempt";

const intentSelect = {
  identifier: true,
  tokenHash: true,
  userId: true,
  stripeCustomerId: true,
  authorizedAt: true,
  expiresAt: true,
} as const;

export const ACCOUNT_DELETION_INTENT_LIFETIME_MS =
  7 * 24 * 60 * 60 * 1000;

export type AuthorizeAccountDeletionIntentResult =
  | {
      status: "authorized";
      resumed: boolean;
      intent: {
        identifier: string;
        tokenHash: string;
        userId: string;
        stripeCustomerId: string | null;
        authorizedAt: Date;
        expiresAt: Date;
      };
    }
  | { status: "invalid" | "expired" };

export async function prepareAccountDeletionOutboxes({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma: PrismaTransaction;
}): Promise<void> {
  // Expiry revokes redirect eligibility while deliberately retaining the bound
  // Stripe Session ID. The remote deletion saga still needs that handle to
  // expire the Session or durably compensate it if Checkout won the race.
  await prisma.proCheckoutAttempt.updateMany({
    where: { userId },
    data: { expiresAt: now },
  });
  await prepareTopUpsForAccountDeletion({ ownerUserId: userId, now, prisma });
  await enqueueUserRemoteAiJobCleanups({ userId, now, prisma });
}

export async function authorizeAccountDeletionIntent({
  identifier,
  tokenHash,
  now = new Date(),
}: {
  identifier: string;
  tokenHash: string;
  now?: Date;
}): Promise<AuthorizeAccountDeletionIntentResult> {
  return await startRetryableTransaction(async (prisma) => {
    const existing = await prisma.accountDeletionIntent.findUnique({
      where: {
        identifier_tokenHash: { identifier, tokenHash },
      },
      select: intentSelect,
    });
    if (existing) {
      if (existing.expiresAt.getTime() <= now.getTime()) {
        return { status: "expired" };
      }
      await prepareAccountDeletionOutboxes({
        prisma,
        userId: existing.userId,
        now,
      });
      return { status: "authorized", resumed: true, intent: existing };
    }

    const token = await prisma.confirmationToken.findUnique({
      where: {
        identifier_token: { identifier, token: tokenHash },
      },
      select: {
        expires: true,
        purpose: true,
        userId: true,
      },
    });
    if (!token || token.purpose !== ConfirmationTokenPurpose.ACCOUNT_DELETE) {
      return { status: "invalid" };
    }
    if (token.expires.getTime() <= now.getTime()) {
      return { status: "expired" };
    }

    const consumed = await prisma.confirmationToken.deleteMany({
      where: {
        identifier,
        token: tokenHash,
        userId: token.userId,
        purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
        expires: { gt: now },
      },
    });
    if (consumed.count !== 1) {
      return { status: "invalid" };
    }

    const customer = await prisma.customer.findUnique({
      where: { userId: token.userId },
      select: { stripeId: true },
    });
    const intent = await prisma.accountDeletionIntent.create({
      data: {
        identifier,
        tokenHash,
        userId: token.userId,
        stripeCustomerId: customer?.stripeId ?? null,
        authorizedAt: now,
        expiresAt: new Date(
          now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS,
        ),
      },
      select: intentSelect,
    });
    await prepareAccountDeletionOutboxes({ prisma, userId: token.userId, now });
    return { status: "authorized", resumed: false, intent };
  });
}

export async function findAccountDeletionIntent({
  identifier,
  tokenHash,
  prisma,
}: {
  identifier: string;
  tokenHash: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.accountDeletionIntent.findUnique({
    where: {
      identifier_tokenHash: { identifier, tokenHash },
    },
    select: intentSelect,
  });
}

export async function findAccountDeletionIntentByUserId({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.accountDeletionIntent.findFirst({
    where: { userId, expiresAt: { gt: now } },
    select: intentSelect,
  });
}
