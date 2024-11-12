import { useTranslation } from "@/app/i18n/client";
import { Translator } from "@/app/i18n/server";
import type { SignInPageErrorParam } from "@auth/core/types"

const signinErrors = {
  default: "authjs:default",
  Signin: "authjs:signin",
  OAuthSignin: "authjs:oauthSignin",
  OAuthCallbackError: "authjs:oauthCallbackError",
  OAuthCreateAccount: "authjs:oauthCreateAccount",
  EmailCreateAccount: "authjs:emailCreateAccount",
  Callback: "authjs:callback",
  OAuthAccountNotLinked: "authjs:oauthAccountNotLinked",
  EmailSignin: "authjs:emailSignin",
  CredentialsSignin: "authjs:credentialsSignin",
  SessionRequired: "authjs:sessionRequired",
}


export function translateNextAuthError(t: Translator, errorType?: SignInPageErrorParam) {
  if (!errorType) {
    return;
  }

  return errorType && (t(signinErrors[errorType]) ?? t(signinErrors.default))
}