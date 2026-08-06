import { type NextRequest, NextResponse } from 'next/server';
import { deleteUser } from './actions';
import { getAuth } from '@/lib/better-auth';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  const identifier = searchParams.get('identifier');
  const auth = await getAuth();

  const session = await auth.api.getSession({ headers: req.headers });
  if (token && identifier) {
    await deleteUser(token, identifier);

    if (!session?.user) {
      const redirectUrl = new URL('/account/manage/personal-data/handle', req.nextUrl.origin);
      redirectUrl.searchParams.set('token', token);
      redirectUrl.searchParams.set('identifier', identifier);
      await auth.api.signOut({
        headers: req.headers
      });
      return NextResponse.redirect(redirectUrl.toString());
    }
  }

  return NextResponse.redirect(new URL('/', req.nextUrl.origin));
}
