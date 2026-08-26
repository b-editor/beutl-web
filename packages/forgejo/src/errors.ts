/**
 * Forgejo の HTTP エラーを 1 つの型にまとめる。
 * 呼び出し側が status で分岐できるよう、生のステータスコードを残している。
 */
export class ForgejoError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Forgejo ${method} ${path} failed with ${status}: ${body}`);
    this.name = "ForgejoError";
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isConflict() {
    return this.status === 409 || this.status === 422;
  }

  /**
   * Caddy が /api/v1/* の共有シークレットを弾いた場合。
   * Forgejo 自身は 403 に本文を付けないので、設定ミスの切り分けに使う。
   */
  get isProxyRejected() {
    return this.status === 403 && this.body.includes("forbidden");
  }
}

/**
 * Beutl ユーザー用に合成したメールアドレスが、既に別の Forgejo ユーザーのものに
 * なっている。beutl-web の DB と Forgejo が別々の時点に復元されると起きる
 * (対応表だけが失われ、Forgejo 側のユーザーが残る)。
 *
 * ここで新しいユーザーを作ると、元のユーザーのリポジトリと発行済みトークンが
 * 宙に浮いたまま残るので、自動では畳まず運用者に判断させる。
 */
export class ForgejoEmailInUseError extends Error {
  constructor(readonly email: string) {
    super(
      `Forgejo already has a user with the address ${email}. ` +
        "The beutl-web database and Forgejo are probably restored to different " +
        "points in time; restore the GitAccount mapping or remove the stale " +
        "Forgejo user before retrying.",
    );
    this.name = "ForgejoEmailInUseError";
  }
}

/**
 * 対応表が指す Forgejo ユーザーが、実際のものと食い違っている。
 *
 * 対応表 (CockroachDB) と Forgejo (Postgres) は別々にバックアップされる。別の時点に
 * 復元すると、同じユーザー名が別人を指しうる。名前だけを信じて Sudo すると、
 * その別人の非公開リポジトリを開き、その人向けのトークンを配り、退会時にはその人ごと
 * 消してしまう。名前が一致しても id が違えば止める。
 */
export class ForgejoAccountMismatchError extends Error {
  constructor(
    readonly forgejoUsername: string,
    readonly expectedId: number,
    readonly actualId: number | null,
  ) {
    super(
      actualId === null
        ? `Forgejo has no user named ${forgejoUsername}, but the mapping expects id ${expectedId}. ` +
            "The beutl-web database and Forgejo are probably restored to different points in time."
        : `Forgejo user ${forgejoUsername} has id ${actualId}, but the mapping expects ${expectedId}. ` +
            "The name now belongs to a different account; refusing to act on it.",
    );
    this.name = "ForgejoAccountMismatchError";
  }
}

export class ForgejoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgejoConfigurationError";
  }
}

/**
 * 送った変更が「届かなかった」と言い切れるか。
 *
 * 言い切れるのは 4xx だけ。5xx も待ち時間切れも、Forgejo 側が後から確定させる
 * ことがある。言い切れないものを「無かったこと」にすると、押さえていた名前を
 * 手放した後に遅れて着地し、その名前を取った別のリポジトリに当たる。
 * 逆に、言い切れるものを「分からない」扱いにすると、断られた削除の控えが残り、
 * 定期実行が後からそれを実行してしまう。
 */
export function isDecided(error: unknown): boolean {
  return (
    error instanceof ForgejoError && error.status >= 400 && error.status < 500
  );
}
