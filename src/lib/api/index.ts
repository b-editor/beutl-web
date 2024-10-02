import { cookies } from 'next/headers';
import * as Api from './generated';
import { parseSetCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { auth } from '@/auth';
import { ProduceJWT } from 'jose';

const _baseUrl = process.env.API_URL;
export const baseUrl = _baseUrl;

export class http {
  static readonly current: http = new http();
  token: string | null = null;

  async fetch(url: RequestInfo, init?: RequestInit): Promise<Response> {
    const session = await auth();
    if (session?.user?.id) {
      // ProduceJWT
    }

    let _init = init;
    if (_init == null) {
      _init = {};
    }

    _init = {
      ..._init,
      cache: 'no-store',
      headers: {
        ..._init.headers,
        "Authorization": `Bearer ${this.token}`
      }
    };

    return await fetch(url, _init);
  }
}

const api = {
  app: new Api.AppClient(baseUrl, http.current),
  assets: new Api.AssetsClient(baseUrl, http.current),
  discover: new Api.DiscoverClient(baseUrl, http.current),
  packages: new Api.PackagesClient(baseUrl, http.current),
  releases: new Api.ReleasesClient(baseUrl, http.current),
  users: new Api.UsersClient(baseUrl, http.current),
  account: new Api.AccountClient(baseUrl, http.current),
  library: new Api.LibraryClient(baseUrl, http.current),
  identity: new Api.IdentityClient(baseUrl, http.current),
  twoFactorAuth: new Api.TwoFactorAuthenticationClient(baseUrl, http.current),
  fido2: new Api.Fido2Client(baseUrl, http.current)
};

export * from './generated';
export default api;