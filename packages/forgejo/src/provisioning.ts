import {
  createGitAccount,
  existsGitAccountUsername,
  findGitAccountByUserId,
  findProfileForApi,
} from "@beutl/db";
import {
  forgejoRequest,
  forgejoRequestOrNull,
  getForgejoConfig,
} from "./client";
import {
  ForgejoAccountMismatchError,
  ForgejoEmailInUseError,
  ForgejoError,
} from "./errors";
import type { ForgejoUser } from "./types";

const USERNAME_MAX_LENGTH = 30;
const USERNAME_FALLBACK = "beutl-user";
const MAX_USERNAME_ATTEMPTS = 20;

/**
 * Beutl の表示名を Forgejo が受け付けるユーザー名に寄せる。
 * Forgejo は英数字と `-` `_` `.` だけを許し、先頭と末尾に記号を置けない。
 */
export function normalizeUsername(source: string): string {
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // 記号が 2 つ以上続く名前は Forgejo が 422 で拒む。`-` `_` `.` のどの組み合わせ
    // でも同じなので、連続をまとめて 1 つの `-` に畳む。Beutl のユーザー名は `_` を
    // 許すため、a__b のような名前は畳まないと全候補が拒否され、そのユーザーは
    // Git を一切使えなくなる。
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, USERNAME_MAX_LENGTH)
    .replace(/[-._]+$/g, "");

  return normalized.length === 0 ? USERNAME_FALLBACK : normalized;
}

/** 連番で当たりを探す回数。これを超えたらランダムなサフィックスに切り替える。 */
const SEQUENTIAL_ATTEMPTS = 5;

/**
 * attempt 回目に試すユーザー名。
 *
 * 最初は素の名前、次から `-2`, `-3`... と連番を振る。連番は読みやすいが、
 * 表示名が未設定のユーザーは全員 `beutl-user` から始まるため、ユーザーが増えると
 * 前の方の番号は埋まりきる。数回外したらランダムなサフィックスに切り替えて、
 * 候補が枯渇しないようにする。
 */
function candidateAt(base: string, attempt: number): string {
  if (attempt === 0) return base;

  const suffix =
    attempt < SEQUENTIAL_ATTEMPTS
      ? `-${attempt + 1}`
      : `-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  // 切り詰めた末尾が記号だと、サフィックスの `-` と並んで `_-` のような連続になり、
  // Forgejo に拒まれる。
  const head = base
    .slice(0, USERNAME_MAX_LENGTH - suffix.length)
    .replace(/[-._]+$/g, "");
  return `${head}${suffix}`;
}

/**
 * Beutl ユーザーに割り当てる Forgejo 側のメールアドレス。
 *
 * Forgejo はメールの一意性を要求するが、Beutl 側の実アドレスは渡したくない。
 * userId から決まる到達しない住所を合成する。対応表を失っても、この値から
 * Forgejo 上のユーザーを引き当てられる。
 */
export function noreplyEmailFor(userId: string): string {
  const host = new URL(getForgejoConfig().baseUrl).hostname;
  return `${userId}@users.noreply.${host}`;
}

/** 保存しない使い捨ての秘密値 (Forgejo ユーザーの初期パスワードなど)。 */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Beutl アカウントに対応する Forgejo ユーザーを用意する。
 * 既にあればそれを返し、無ければ管理 API で作って対応表に記録する。
 */
export async function ensureGitAccount(userId: string): Promise<{
  forgejoUserId: number;
  forgejoUsername: string;
  created: boolean;
}> {
  const existing = await findGitAccountByUserId({ userId });
  if (existing) {
    // Sudo も削除もユーザー名だけで効く。対応表と Forgejo が別の時点に復元されると
    // 同じ名前が別人を指しうるので、id まで一致することを確かめてから使う。
    // 確かめずに進むと、他人の非公開リポジトリを開いてしまう。
    const actual = await forgejoRequestOrNull<ForgejoUser>(
      `/users/${encodeURIComponent(existing.forgejoUsername)}`,
    );
    if (!actual || actual.id !== existing.forgejoUserId) {
      throw new ForgejoAccountMismatchError(
        existing.forgejoUsername,
        existing.forgejoUserId,
        actual?.id ?? null,
      );
    }

    return {
      forgejoUserId: existing.forgejoUserId,
      forgejoUsername: existing.forgejoUsername,
      created: false,
    };
  }

  const profile = await findProfileForApi({ where: { userId } });
  const base = normalizeUsername(profile?.userName ?? USERNAME_FALLBACK);
  const email = noreplyEmailFor(userId);

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
    const username = candidateAt(base, attempt);

    // 先に対応表を見て、明らかに埋まっている候補は Forgejo に投げない。
    if (await existsGitAccountUsername({ forgejoUsername: username })) {
      continue;
    }

    let created: ForgejoUser;
    try {
      created = await forgejoRequest<ForgejoUser>("/admin/users", {
        method: "POST",
        body: {
          username,
          email,
          password: randomSecret(),
          must_change_password: false,
          visibility: "private",
          restricted: false,
        },
      });
    } catch (error) {
      if (error instanceof ForgejoError && error.isConflict) {
        // メールは全候補で同じなので、これが埋まっていると 20 回とも同じ理由で
        // 失敗する。回しても意味が無いうえ、原因がユーザー名の枯渇に見えてしまう。
        if (error.body.includes("e-mail already in use")) {
          throw new ForgejoEmailInUseError(email);
        }
        // ユーザー名が埋まっている / 予約語だった場合は次の候補へ。
        continue;
      }
      throw error;
    }

    try {
      await createGitAccount({
        userId,
        forgejoUserId: created.id,
        forgejoUsername: created.login,
      });
    } catch (error) {
      // 対応表に書けないと Forgejo 側が孤児になる。作ったものは畳んでから投げ直す。
      await forgejoRequest(`/admin/users/${created.login}`, {
        method: "DELETE",
        // 作った直後なので通常は何も持っていないが、同時実行で push が入ると
        // purge 無しでは 422 で拒まれ、孤児が残る。
        searchParams: { purge: true },
        responseType: "none",
      }).catch((deleteError) => {
        // 畳めなかった場合は孤児が残る。元の例外は投げ直すので、こちらは記録だけ。
        console.error(
          `failed to roll back the Forgejo user ${created.login}`,
          deleteError,
        );
      });
      throw error;
    }

    return {
      forgejoUserId: created.id,
      forgejoUsername: created.login,
      created: true,
    };
  }

  throw new Error(
    `Could not find an available Forgejo username for user ${userId}`,
  );
}

