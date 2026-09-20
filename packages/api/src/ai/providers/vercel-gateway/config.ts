// Credentials and timeouts for Vercel AI Gateway.
//
// Read from process.env at call time, the same way OpenRouter's are: the
// worker copies every string binding from its Env into process.env before
// anything runs, so there is no configuration object to thread through.

import { createGateway, type GatewayProvider } from "@ai-sdk/gateway";
import { AiProviderError } from "../errors";

export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 120_000;

export function getGatewayApiKey(): string {
  const key = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!key) {
    throw new AiProviderError("VERCEL_AI_GATEWAY_API_KEY is not set");
  }
  return key;
}

export function getGatewayRequestTimeoutMilliseconds(
  configuredTimeout = process.env.VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS,
): number {
  if (configuredTimeout === undefined || configuredTimeout.trim() === "") {
    return DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(configuredTimeout);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AiProviderError(
      "VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS must be a positive whole number of milliseconds",
    );
  }
  return parsed;
}

/**
 * A Gateway bound to this service's credentials.
 *
 * Built per call, like OpenRouter's client is: the key is read from the
 * environment at the moment of use, so a test that stubs it and a deployment
 * that rotates it behave the same.
 *
 * Naming the key explicitly rather than relying on the SDK's own
 * `AI_GATEWAY_API_KEY` default keeps it alongside `OPENROUTER_API_KEY` in the
 * worker's Env, and makes a missing key fail with a message that says which
 * one.
 */
export function createGatewayClient(): GatewayProvider {
  return createGateway({ apiKey: getGatewayApiKey() });
}
