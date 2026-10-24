export const NATIVE_CLIENT_ID = "beutl-desktop";
export const NATIVE_CLIENT_NAME = "Beutl Desktop";
export const NATIVE_SCOPE = "beutl:desktop";
export const NATIVE_SCOPES = [NATIVE_SCOPE, "offline_access"] as const;

export function nativeOAuthOrigin() {
  return (
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_ORIGIN ||
    "http://localhost:3000"
  ).replace(/\/$/u, "");
}

export const nativeOAuthIssuer = () => `${nativeOAuthOrigin()}/api/auth`;
export const nativeOAuthResource = () => `${nativeOAuthOrigin()}/api`;

export function validNativeDeviceName(name: unknown): name is string {
  return (
    typeof name === "string" && name.trim().length > 0 && name.length <= 80 && !/\p{Cc}/u.test(name)
  );
}

// Better Auth's Prisma adapter stores its `json` fields as serialized text.
export const nativeOAuthConfirmation = (keyThumbprint: string) =>
  JSON.stringify({ jkt: keyThumbprint });
