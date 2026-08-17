"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Badge } from "@beutl/ui/ui/badge";
import {
  AudioLines,
  ChevronRight,
  Clapperboard,
  History,
  Image as ImageIcon,
  Languages,
  Loader2,
  WandSparkles,
} from "lucide-react";
import Link from "next/link";
import {
  AiAccessNotice,
  AiUsageCard,
  type AiAccess,
  type AiBalance,
} from "./shared";

const IMAGE_EDIT_OPERATIONS = [
  "image.edit.remove_background",
  "image.edit.upscale",
  "image.edit.restyle",
  "image.edit.remove_object",
  "image.edit.outpaint",
] as const;

export function AiFeatureLinks({
  lang,
  access,
  balance,
  activeJobCount,
}: {
  lang: string;
  access: AiAccess;
  balance: AiBalance;
  activeJobCount: number;
}) {
  const { t } = useTranslation(lang);
  const features = [
    {
      slug: "generate",
      title: t("dashboard:ai.imageGeneration"),
      description: t("dashboard:ai.imageGenerationDescription"),
      icon: ImageIcon,
      operations: ["image.generate"],
    },
    {
      slug: "edit",
      title: t("dashboard:ai.imageEdit"),
      description: t("dashboard:ai.imageEditDescription"),
      icon: WandSparkles,
      operations: IMAGE_EDIT_OPERATIONS,
    },
    {
      slug: "transcribe",
      title: t("dashboard:ai.transcription"),
      description: t("dashboard:ai.transcriptionDescription"),
      icon: AudioLines,
      operations: ["audio.transcribe"],
    },
    {
      slug: "translate",
      title: t("dashboard:ai.translation"),
      description: t("dashboard:ai.translationDescription"),
      icon: Languages,
      operations: ["subtitle.translate"],
    },
    {
      slug: "video",
      title: t("dashboard:ai.videoGeneration"),
      description: t("dashboard:ai.videoGenerationDescription"),
      icon: Clapperboard,
      operations: ["video.generate"],
    },
    {
      // History stays reachable without a balance: it is where a result that
      // was already paid for is retrieved.
      slug: "jobs",
      title: t("dashboard:ai.jobHistory"),
      description: t("dashboard:ai.jobHistoryDescription"),
      icon: History,
      operations: [] as readonly string[],
    },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <AiUsageCard lang={lang} balance={balance} />

      {!access.canUseAi && <AiAccessNotice lang={lang} reason="plan" />}

      {activeJobCount > 0 && (
        <Link
          href={`/${lang}/dashboard/ai/jobs`}
          className="flex items-center gap-3 rounded-lg border bg-card p-4 text-card-foreground transition-colors hover:bg-accent/50"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="flex-1 text-sm">
            {t("dashboard:ai.activeJobs", { total: activeJobCount })}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      )}

      {/* Six cards over three columns rather than two: at two they stretch to
          about 530px for two lines of text. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => {
          const unaffordable =
            access.canUseAi &&
            feature.operations.length > 0 &&
            !feature.operations.some(
              (operation) => access.availability[operation],
            );
          return (
            <Link
              key={feature.slug}
              href={`/${lang}/dashboard/ai/${feature.slug}`}
              className="flex flex-col gap-3 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50"
            >
              <div className="flex items-start justify-between gap-2">
                <feature.icon className="h-6 w-6 shrink-0 text-muted-foreground" />
                {unaffordable && (
                  <Badge variant="outline" className="shrink-0">
                    {t("dashboard:ai.balanceExhaustedBadge")}
                  </Badge>
                )}
              </div>
              <div>
                <p className="font-bold">{feature.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
