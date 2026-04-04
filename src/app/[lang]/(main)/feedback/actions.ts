"use server";

import { getTranslation, type Zod } from "@/app/i18n/server";
import { getLanguage } from "@/lib/lang-utils";
import { getDbAsync } from "@/prisma";
import { sendEmail } from "@/resend";
import { auth } from "@/lib/better-auth";
import { headers } from "next/headers";

const feedbackSchema = (z: Zod) =>
  z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    category: z.enum(["BUG_REPORT", "FEATURE_REQUEST", "QUESTION", "OTHER"]),
    message: z.string().min(1).max(2000),
  });

export type State = {
  errors?: {
    name?: string[];
    email?: string[];
    category?: string[];
    message?: string[];
  };
  success?: boolean;
  message?: string | null;
};

export async function submitFeedback(
  state: State,
  formData: FormData,
): Promise<State> {
  const lang = await getLanguage();
  const { t, z } = await getTranslation(lang);

  const validated = feedbackSchema(z).safeParse(
    Object.fromEntries(formData.entries()),
  );
  if (!validated.success) {
    return {
      errors: validated.error.flatten().fieldErrors,
      message: t("invalidRequest"),
      success: false,
    };
  }

  const { name, email, category, message } = validated.data;

  let userId: string | null = null;
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (session?.user?.id) {
      userId = session.user.id;
    }
  } catch {
    // Anonymous is fine
  }

  try {
    const db = await getDbAsync();

    const categoryLabels: Record<string, string> = {
      BUG_REPORT: t("feedback:categories.BUG_REPORT"),
      FEATURE_REQUEST: t("feedback:categories.FEATURE_REQUEST"),
      QUESTION: t("feedback:categories.QUESTION"),
      OTHER: t("feedback:categories.OTHER"),
    };

    const dbSave = db.feedback.create({
      data: {
        name,
        email,
        category,
        message,
        userId,
      },
    });

    const emailNotification = sendEmail({
      to: "contact@beditor.net",
      subject: `[Feedback] ${categoryLabels[category]}: from ${name}`,
      body: `
        <h2>New Feedback Received</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Category:</strong> ${categoryLabels[category]}</p>
        <p><strong>Message:</strong></p>
        <p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>
      `,
    });

    await Promise.all([dbSave, emailNotification]);

    return {
      success: true,
      message: t("feedback:successMessage"),
    };
  } catch (error) {
    console.error("Failed to submit feedback:", error);
    return {
      success: false,
      message: t("feedback:errorMessage"),
    };
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
