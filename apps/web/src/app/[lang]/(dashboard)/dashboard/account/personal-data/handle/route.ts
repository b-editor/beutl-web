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
    // deleteUser は確認トークンを消費し、二度目は throw する。以前はこの後
    // 同じハンドラへ token 付きでリダイレクトしていたため、削除は済んでいるのに
    // 続くリクエストが invalid-token で落ちていた。
    await deleteUser(token, identifier);

    if (session?.user) {
      await auth.api.signOut({
        headers: req.headers
      });
    }
  }

  // ロケール接頭辞なしで返し、middleware に解決させる。
  return NextResponse.redirect(new URL('/', req.nextUrl.origin));
}
