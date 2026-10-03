// The Worker runtime module exists only inside workerd. Contract tests run in
// Node, so it resolves here; tests that need bindings or waitUntil() replace it
// with vi.mock("cloudflare:workers", ...).
export const env: Record<string, unknown> = {};

export function waitUntil(promise: Promise<unknown>): void {
  void promise;
}
