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

export class ForgejoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgejoConfigurationError";
  }
}
