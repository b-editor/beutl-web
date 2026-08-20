import "server-only";
import { abortGitAccountDeletion, beginGitAccountDeletion, finishGitAccountDeletion } from "@beutl/forgejo";
import {
  deleteUserById,
  markGitAccountDeletionReady,
  drainUserStorageFiles,
  enqueueUserStorageCleanups,
  findAccountDeletionIntent,
  prepareAccountDeletionOutboxes,
  startRetryableTransaction,
} from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { authorizeAccountDeletion } from "@/lib/confirmation-token-flow";
import { closeStripeCustomerForAccountDeletion } from "@/lib/customer";

export async function deleteUser(token: string, identifier: string) {
  const authorization = await authorizeAccountDeletion({ token, identifier });
  if (authorization.status !== "authorized") {
    if (authorization.status === "expired") {
      throw new Error("Token has expired");
    }
    throw new Error("Invalid token");
  }
  const { intent } = authorization;

  // Authorization and token consumption are already durable. A retry of this
  // same link resumes the intent even after the original token expiration.
  const stripeClosure = await closeStripeCustomerForAccountDeletion({
    userId: intent.userId,
    stripeCustomerId: intent.stripeCustomerId,
    deletionAuthorizedAt: intent.authorizedAt,
  });
  if (stripeClosure.status === "owner-mismatch") {
    throw new Error("Stripe customer ownership could not be verified");
  }
  // The plain files go first, a page per transaction, so the cascade below
  // stays small however many files the plan allowed. A resumed intent that
  // was already completed drains nothing and falls through to the same
  // "already done" answer as before.
  const { forgejoUsername, intentId } = await beginGitAccountDeletion(intent.userId);
  try {
  await drainUserStorageFiles({ userId: intent.userId });
  const deleted = await startRetryableTransaction(async (prisma) => {
    const currentIntent = await findAccountDeletionIntent({
      identifier: intent.identifier,
      tokenHash: intent.tokenHash,
      prisma,
    });
    if (!currentIntent) {
      // A concurrent invocation already completed the same durable intent.
      return false;
    }
    if (
      currentIntent.userId !== intent.userId ||
      currentIntent.stripeCustomerId !== intent.stripeCustomerId
    ) {
      throw new Error("Account deletion intent changed unexpectedly");
    }
    // Re-snapshot billing attempts and provider jobs in the same serializable
    // transaction that performs the User cascade. This closes the interval
    // between durable authorization and final local deletion.
    const prepared = await prepareAccountDeletionOutboxes({
      userId: intent.userId,
      prisma,
    });
    if (prepared.unboundCheckoutRecoveries > 0) {
      throw new Error("Checkout recovery is pending before account deletion");
    }
    if (prepared.customerProvisioningRecoveries > 0) {
      throw new Error(
        "Stripe Customer provisioning recovery is pending before account deletion",
      );
    }
    await enqueueUserStorageCleanups({
      userId: intent.userId,
      prisma,
    });
    await addAuditLog({
      userId: null,
      action: auditLogActions.account.accountDeleted,
      details: `User ${intent.userId} deleted their account`,
      prisma,
    });
    await deleteUserById({ userId: intent.userId, prisma });
    await markGitAccountDeletionReady({ userId: intent.userId, prisma });
    return true;
  });
  if (!deleted) {
    return;
  }
  } catch (error) {
    await abortGitAccountDeletion(intent.userId, intentId);
    throw error;
  }
  {
    const finished = await finishGitAccountDeletion(intent.userId);
    await addAuditLog({
      userId: null,
      action: finished
        ? auditLogActions.git.accountDeleted
        : auditLogActions.git.accountPurgeFailed,
      details: finished
        ? `User ${intent.userId} deleted their Forgejo account`
        : `Forgejo user ${forgejoUsername ?? "(unresolved)"} is queued for retry in GitAccountDeletion`,
    }).catch((auditError) => {
      // 監査が書けなくても GitAccountDeletion の行が残るので、片付けは続けられる。
      console.error("failed to record the Git account deletion", auditError);
    });
  }

}
