import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL(
  "../../apps/web/prisma/migrations/20260908000000_generalize_subscription_plans/migration.sql",
  import.meta.url,
);
const schema = new URL("../../apps/web/prisma/schema.prisma", import.meta.url);

// One Subscription table keyed by (userId, planId) serves AI Pro and the
// storage plan; the tier column lets a plan sell several sizes without another
// table. The migration must keep every existing Pro row readable under the
// same key it had, and must not create plan-specific tables.
describe("subscription plan generalization migration", () => {
  it("re-keys the subscription rows by user and plan and adds the tier", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain('ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "tier" STRING');
    expect(sql).toContain('ALTER TABLE "Subscription" ALTER PRIMARY KEY USING COLUMNS ("userId", "planId")');
    expect(sql).toContain('DROP INDEX IF EXISTS "Subscription_userId_key" CASCADE');
    expect(sql).not.toMatch(/CREATE TABLE/);
    expect(sql).not.toContain("StorageSubscription");
    expect(sql).not.toContain("StorageCheckoutAttempt");
  });

  it("turns the Pro checkout attempt table into the shared one", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain('ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "planId" STRING NOT NULL DEFAULT \'pro\'');
    expect(sql).toContain('ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "tier" STRING');
    expect(sql).toContain('ALTER TABLE "ProCheckoutAttempt" ALTER PRIMARY KEY USING COLUMNS ("userId", "planId")');
    expect(sql).toContain('DROP INDEX IF EXISTS "ProCheckoutAttempt_userId_key" CASCADE');
    expect(sql).toContain('ALTER TABLE IF EXISTS "ProCheckoutAttempt" RENAME TO "SubscriptionCheckoutAttempt"');
    // The attempt table stays detached from the user cascade.
    expect(sql).not.toContain("_userId_fkey");
  });

  it("re-creates the BillingOffer checks so a tiered offer can be recorded", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain('ALTER TABLE "BillingOffer" ADD COLUMN IF NOT EXISTS "tier" STRING');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "BillingOffer_kind_check"');
    expect(sql).toMatch(/"BillingOffer_kind_check"\s+CHECK \("kind" IN \('pro', 'top_up', 'storage'\)\)/);
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "BillingOffer_terms_check"');
    expect(sql).toContain('("kind" IN (\'pro\', \'storage\')');
    expect(sql).toMatch(/"kind" = 'top_up'\s+AND "tier" IS NULL/);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "BillingOffer_kind_tier_checkoutEnabled_idx"');
  });

  it("unlocks before altering and relocks every touched table last", async () => {
    const sql = await readFile(migration, "utf8");
    const relockOf = (table: string) =>
      sql.lastIndexOf(`ALTER TABLE "${table}" SET (schema_locked = true)`);
    for (const [table, relocked] of [
      ["Subscription", "Subscription"],
      ["ProCheckoutAttempt", "SubscriptionCheckoutAttempt"],
      ["BillingOffer", "BillingOffer"],
    ]) {
      const unlock = sql.indexOf(`ALTER TABLE "${table}" SET (schema_locked = false)`);
      const relock = relockOf(relocked);
      expect(unlock, table).toBeGreaterThanOrEqual(0);
      expect(relock, table).toBeGreaterThan(unlock);
      const lastAlter = sql.lastIndexOf(`ALTER TABLE "${table}" A`);
      expect(lastAlter, table).toBeGreaterThan(unlock);
      expect(lastAlter, table).toBeLessThan(relock);
    }
    const firstIndex = sql.indexOf('ON "BillingOffer"(');
    expect(firstIndex).toBeGreaterThan(sql.indexOf('ALTER TABLE "BillingOffer" SET (schema_locked = false)'));
    expect(firstIndex).toBeLessThan(relockOf("BillingOffer"));
  });

  it("lets a storage Checkout be queued for cleanup", async () => {
    // The cleanup row's kind is the plan id, and the table's CHECK predates
    // the storage plan. Account deletion queues such a row inside its
    // transaction, so a rejected insert would block the deletion outright.
    const sql = await readFile(
      new URL(
        "../../apps/web/prisma/migrations/20260908010000_allow_storage_checkout_cleanup/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "StripeCheckoutCleanup_kind_check"');
    expect(sql).toMatch(/"StripeCheckoutCleanup_kind_check"\s+CHECK \("kind" IN \('package', 'pro', 'storage'\)\)/);
    const unlock = sql.indexOf('ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = false)');
    const relock = sql.lastIndexOf('ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = true)');
    expect(unlock).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf("ADD CONSTRAINT")).toBeGreaterThan(unlock);
    expect(relock).toBeGreaterThan(sql.indexOf("ADD CONSTRAINT"));
  });

  it("matches the Prisma schema", async () => {
    const source = await readFile(schema, "utf8");
    expect(source).not.toContain("model StorageSubscription {");
    expect(source).not.toContain("model StorageCheckoutAttempt {");
    expect(source).not.toContain("model ProCheckoutAttempt {");
    const subscription = source.slice(source.indexOf("model Subscription {"));
    expect(subscription.slice(0, subscription.indexOf("\n}\n"))).toMatch(/@@id\(\[userId, planId\]\)/);
    expect(subscription.slice(0, subscription.indexOf("\n}\n"))).toMatch(/tier\s+String\?/);
    const attempt = source.slice(source.indexOf("model SubscriptionCheckoutAttempt {"));
    const attemptBody = attempt.slice(0, attempt.indexOf("\n}\n"));
    expect(attemptBody).toMatch(/@@id\(\[userId, planId\]\)/);
    expect(attemptBody).toMatch(/planId\s+String\s+@default\("pro"\)/);
    expect(attemptBody).toMatch(/tier\s+String\?/);
    // No user relation on the attempt: it must survive the account cascade.
    expect(attemptBody).not.toContain("User ");
    // Physical names keep the Pro-era identifiers so the rename needs no index rebuild.
    expect(attemptBody).toContain('map: "ProCheckoutAttempt_checkoutKey_key"');
    expect(source).toMatch(/model BillingOffer \{[\s\S]*tier\s+String\?/);
    expect(source).toMatch(/model User \{[\s\S]*subscriptions\s+Subscription\[\]/);
  });
});
