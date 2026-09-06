import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProviderPollLeaseMilliseconds,
  PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS,
} from "../../packages/api/src/ai/video-jobs";

describe("AI video provider poll lease", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extends beyond the default 120 second provider timeout", () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "120000");

    expect(getProviderPollLeaseMilliseconds()).toBe(
      120_000 + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS,
    );
    expect(getProviderPollLeaseMilliseconds()).toBeGreaterThan(120_000);
  });

  it("derives the lease from a custom provider timeout", () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "185000");

    expect(getProviderPollLeaseMilliseconds()).toBe(
      185_000 + PROVIDER_POLL_LEASE_MARGIN_MILLISECONDS,
    );
  });
});
