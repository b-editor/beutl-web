import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/better-auth";

export async function GET(request: Request) {
  return oauthProviderAuthServerMetadata(await getAuth())(request);
}
