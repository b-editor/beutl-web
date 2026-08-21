/**
 * Forgejo API のレスポンスのうち、beutl-web が実際に読む部分だけを写した型。
 * 全フィールドを網羅する意図はない。
 */

export type ForgejoUser = {
  id: number;
  login: string;
  email: string;
  full_name: string;
  avatar_url: string;
};

export type ForgejoAccessToken = {
  id: number;
  name: string;
  /**
   * トークンの平文。発行直後のレスポンスにしか入らない。
   * Forgejo 16.0.2 では 40 文字の 16 進文字列。
   */
  sha1?: string;
  /** 識別用の末尾 8 文字。一覧の応答にも入る。 */
  token_last_eight?: string;
  scopes: string[];
};

export type ForgejoRepository = {
  id: number;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  empty: boolean;
  /**
   * 読み取り専用。push は 403、contents API の書き込みは 423 で拒まれ、clone は
   * 通る (Forgejo 16.0.2 で実測)。テンプレートを入れ損ねたリポジトリを、LFS を
   * 通らない push から守るために立てる。
   */
  archived: boolean;
  /**
   * KiB 単位。リポジトリ本体と LFS の合計で、LFS の保存先が S3 でも変わらない
   * (Forgejo 16.0.2 で実測)。同じ名前でも ForgejoContentsEntry.size は別物なので注意。
   */
  size: number;
  default_branch: string;
  html_url: string;
  clone_url: string;
  created_at: string;
  updated_at: string;
  owner: Pick<ForgejoUser, "id" | "login">;
};

export type ForgejoContentsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  /** file の場合のみ。LFS 管理下ならポインタファイルのサイズになる。 */
  size: number;
  sha: string;
  download_url: string | null;
};

export type ForgejoCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  author: Pick<ForgejoUser, "login" | "avatar_url"> | null;
};

export type ForgejoBranch = {
  name: string;
  commit: { id: string; message: string; timestamp: string };
};
