"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authenticated } from "@/lib/auth-guard";
import { resolveGitUsername } from "@/lib/git-account";
import type { ActionResult } from "@beutl/core";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { getLanguage } from "@beutl/next/language";
import { getTranslation } from "@beutl/i18n";
import {
  ForgejoError,
  createRepository,
  deleteRepository,
  issueGitCredential,
  renameRepository,
  updateRepositoryDescription,
} from "@beutl/forgejo";

/** Forgejo が受け付けるリポジトリ名。 */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type CredentialResult = { username: string; token: string };

type Context = {
  userId: string;
  username: string;
  lang: string;
  t: Awaited<ReturnType<typeof getTranslation>>["t"];
};

/**
 * セッション・言語・Forgejo ユーザー名をまとめて用意し、Forgejo の例外を
 * 画面に出せるメッセージへ畳む。
 */
async function withGitAccount(
  fn: (ctx: Context) => Promise<ActionResult>,
): Promise<ActionResult> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const username = await resolveGitUsername(session.user.id);
    if (!username) {
      return { success: false, message: t("repositories:errors.notConfigured") };
    }

    try {
      return await fn({ userId: session.user.id, username, lang, t });
    } catch (error) {
      if (error instanceof ForgejoError) {
        if (error.isNotFound) {
          return { success: false, message: t("repositories:errors.notFound") };
        }
        if (error.isConflict) {
          return { success: false, message: t("repositories:errors.nameTaken") };
        }
      }
      throw error;
    }
  });
}

export async function createRepositoryAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  return await withGitAccount(async ({ userId, username, lang, t }) => {
    if (!name) {
      return {
        success: false,
        errors: { name: [t("repositories:errors.nameRequired")] },
      };
    }
    if (!NAME_PATTERN.test(name)) {
      return {
        success: false,
        errors: { name: [t("repositories:errors.nameInvalid")] },
      };
    }

    const repository = await createRepository(username, { name, description });
    await addAuditLog({
      userId,
      action: auditLogActions.git.createRepository,
      details: repository.full_name,
    });

    revalidatePath(`/${lang}/dashboard/repositories`);
    return { success: true };
  });
}

export async function renameRepositoryAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const owner = String(formData.get("owner") ?? "");
  const name = String(formData.get("name") ?? "");
  const newName = String(formData.get("newName") ?? "").trim();
  let destination: string | null = null;

  const result = await withGitAccount(async ({ userId, username, lang, t }) => {
    if (!newName) {
      return {
        success: false,
        errors: { newName: [t("repositories:errors.nameRequired")] },
      };
    }
    if (!NAME_PATTERN.test(newName)) {
      return {
        success: false,
        errors: { newName: [t("repositories:errors.nameInvalid")] },
      };
    }

    await renameRepository(username, owner, name, newName);
    await addAuditLog({
      userId,
      action: auditLogActions.git.renameRepository,
      details: `${owner}/${name} -> ${newName}`,
    });

    revalidatePath(`/${lang}/dashboard/repositories`);
    destination = `/${lang}/dashboard/repositories/${owner}/${newName}/settings`;
    return { success: true };
  });

  // リネーム後は今いる URL が 404 になるので、新しい URL へ送り直す。
  // redirect() は例外で制御を移すため、try/catch の外で呼ぶ。
  if (destination) redirect(destination);
  return result;
}

export async function updateDescriptionAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const owner = String(formData.get("owner") ?? "");
  const name = String(formData.get("name") ?? "");
  const description = String(formData.get("description") ?? "").trim();

  return await withGitAccount(async ({ username, lang, t }) => {
    await updateRepositoryDescription(username, owner, name, description);
    revalidatePath(`/${lang}/dashboard/repositories/${owner}/${name}`);
    return { success: true, message: t("repositories:updated") };
  });
}

export async function deleteRepositoryAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const owner = String(formData.get("owner") ?? "");
  const name = String(formData.get("name") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  let destination: string | null = null;

  const result = await withGitAccount(async ({ userId, username, lang, t }) => {
    // 名前の入力を求めるのは、Forgejo 側の削除が即時かつ不可逆なため。
    if (confirmation !== name) {
      return {
        success: false,
        errors: { confirmation: [t("repositories:errors.confirmMismatch")] },
      };
    }

    await deleteRepository(username, owner, name);
    await addAuditLog({
      userId,
      action: auditLogActions.git.deleteRepository,
      details: `${owner}/${name}`,
    });

    revalidatePath(`/${lang}/dashboard/repositories`);
    destination = `/${lang}/dashboard/repositories`;
    return { success: true };
  });

  if (destination) redirect(destination);
  return result;
}

/**
 * git 用のアクセストークンを発行する。同じ名前の既存トークンは失効する。
 * 平文の値はこのレスポンスにしか現れない。
 */
export async function issueCredentialAction(): Promise<
  ActionResult<CredentialResult>
> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);

    let credential: CredentialResult;
    try {
      credential = await issueGitCredential(session.user.id);
    } catch (error) {
      console.error(error);
      return { success: false, message: t("repositories:errors.unknown") };
    }

    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.git.issueCredential,
      details: credential.username,
    });
    return { success: true, data: credential };
  });
}
