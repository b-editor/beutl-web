import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS } from "../../packages/api/src/ai/video-jobs";
import { DEFAULT_AI_PROVIDER_ID, videoProviderFor } from "../../packages/api/src/ai/providers/registry";

const leaseMilliseconds = () => videoProviderFor(DEFAULT_AI_PROVIDER_ID).pollLeaseMilliseconds();

describe("AI video provider poll lease", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extends beyond the default 120 second provider timeout", () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "120000");

    expect(leaseMilliseconds()).toBe(
      120_000 + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS,
    );
    expect(leaseMilliseconds()).toBeGreaterThan(120_000);
  });

  it("derives the lease from a custom provider timeout", () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "185000");

    expect(leaseMilliseconds()).toBe(
      185_000 + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS,
    );
  });
});
