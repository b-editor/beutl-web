export function randomString(size: number) {
  const i2hex = (i: number) => `0${i.toString(16)}`.slice(-2);
  const r = (a: string, i: number): string => a + i2hex(i);
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes).reduce(r, "");
}

// crypto.randomUUID exists only in a secure context, so it is undefined on a
// page served over plain HTTP — which is how a dev server is reached from
// another device on the network — and on Safari before 15.4. crypto.getRandomValues
// carries no such restriction, so the fallback is still random rather than
// derived from the clock: these values identify a payment attempt, and two
// attempts that collide are refused as a replay of each other.
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4, variant 1, as RFC 9562 requires of a random UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export async function createHash(message: string) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toString();
}
