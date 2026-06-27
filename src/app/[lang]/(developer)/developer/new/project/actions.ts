"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated } from "@/lib/auth-guard";
import { createDevPackage, existsPackageName } from "@/lib/db/package";
import { getLanguage } from "@/lib/lang-utils";
import { getTranslation, type Translator } from "@/app/i18n/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

export type State = {
  errors?: {
    packageId?: string[];
  };
  success?: boolean;
  message?: string | null;
};

const formSchema = (t: Translator) =>
  z.object({
    packageId: z
      .string()
      .regex(
        /^[a-zA-Z0-9_.]*$/,
        t("developer:validation.packageIdCharacters"),
      )
      .and(z.string().max(50, t("developer:validation.packageIdMax")))
      .and(z.string().min(3, t("developer:validation.packageIdMin"))),
  });

export async function createNewProject(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const lang = await getLanguage();
    const { t } = await getTranslation(lang);
    const validated = formSchema(t).safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: t("developer:errors.invalidInput"),
        success: false,
      };
    }

    const { packageId } = validated.data;
    if (await existsPackageName({ name: packageId })) {
      return {
        errors: {
          packageId: [t("developer:validation.packageIdTaken")],
        },
        message: t("developer:errors.invalidInput"),
        success: false,
      };
    }
    const { id } = await createDevPackage({
      name: packageId,
      userId: session.user.id,
    });
    await addAuditLog({
      userId: session.user.id,
      action: auditLogActions.developer.createPackage,
      details: `packageId: ${id}, name: ${packageId}`,
    });
    revalidatePath(`/${lang}/developer`);
    redirect(`/${lang}/developer/projects/${packageId}`);
  });
}
