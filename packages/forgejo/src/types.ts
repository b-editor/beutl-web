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
  /** 発行直後のレスポンスにしか入らない。 */
  sha1?: string;
  scopes: string[];
};

export type ForgejoRepository = {
  id: number;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  empty: boolean;
  /** リポジトリ本体のサイズ (KiB)。LFS は含まない。 */
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
