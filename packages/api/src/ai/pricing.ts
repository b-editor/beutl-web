// The catalog itself now lives in @beutl/core so the admin console can derive
// what an allowance buys without pulling in @beutl/db. It is re-exported here
// because every AI module already reads it from this path.
export { AI_PRICING_CATALOG } from "@beutl/core";
export type { AiBillingUnit } from "@beutl/core";

// The monthly allowance is not defined here: it is administrator-configurable
// and resolved through ./settings, with the built-in default owned by
// @beutl/core.
export const PRO_PLAN = {
  id: "pro",
} as const;

export const AI_TOP_UP = {
  credits: 500,
} as const;
