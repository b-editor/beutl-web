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

export class ForgejoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgejoConfigurationError";
  }
}
