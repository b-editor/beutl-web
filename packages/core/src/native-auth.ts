// Hosts allowed as the native-app sign-in continue URL. createAuthUri validates
// the continue_uri against this list when minting a NativeAppAuth, and the
// native-auth handler page re-validates it before redirecting the auth code
// back to the desktop app. Both must agree, so the list lives here.
const ALLOWED_CONTINUE_URL_HOSTS = ["localhost", "beutl.beditor.net"];

export function isAllowedContinueUrlHost(hostname: string): boolean {
  return ALLOWED_CONTINUE_URL_HOSTS.includes(hostname);
}
