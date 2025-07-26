import { type NextRequest, NextResponse } from 'next/server';
import { deleteUser } from './actions';
import { auth, signOut } from '@/auth';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  const identifier = searchParams.get('identifier');

  const session = await auth();
  if (token && identifier) {
    await deleteUser(token, identifier);

    if (!session?.user) {
      const redirectUrl = new URL('/account/manage/personal-data/handle', req.nextUrl.origin);
      redirectUrl.searchParams.set('token', token);
      redirectUrl.searchParams.set('identifier', identifier);
      await signOut({
        redirectTo: redirectUrl.toString(),
      });
    }
  }

  return NextResponse.redirect(new URL('/', req.nextUrl.origin));
}
