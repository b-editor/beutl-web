import "server-only";
import {
  deleteUserById,
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
    await enqueueUserStorageCleanups({
      userId: intent.userId,
      prisma,
    });
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
    await addAuditLog({
      userId: null,
      action: auditLogActions.account.accountDeleted,
      details: `User ${intent.userId} deleted their account`,
      prisma,
    });
    await deleteUserById({ userId: intent.userId, prisma });
    return true;
  });
  if (!deleted) {
    return;
  }
}
