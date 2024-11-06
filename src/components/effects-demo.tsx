import styles from "@/styles/loop-slide.module.css";
import transparentStyles from "@/styles/transparent.module.css";
import growStyles from "@/styles/grow.module.css";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslation } from "@/app/i18n/server";

function getEffects(t: Awaited<ReturnType<typeof getTranslation>>["t"]) {
  return [
    {
      name: t("effects:blur"),
    },
    {
      name: t("effects:dropShadow"),
    },
    {
      name: t("effects:innerShadow"),
    },
    {
      name: t("effects:flatShadow"),
    },
    {
      name: t("effects:border"),
    },
    {
      name: t("effects:strokeEffect"),
    },
    {
      name: t("effects:clipping"),
    },
    {
      name: t("effects:dilate"),
    },
    {
      name: t("effects:erode"),
    },
    {
      name: t("effects:highContrast"),
    },
    {
      name: t("effects:hueRotate"),
    },
    {
      name: t("effects:light"),
    },
    {
      name: t("effects:lumaColor"),
    },
    {
      name: t("effects:saturationAdjustment"),
    },
    {
      name: t("effects:threshold"),
    },
    {
      name: t("effects:brightness"),
    },
    {
      name: t("effects:gamma"),
    },
    {
      name: t("effects:invert"),
    },
    {
      name: t("effects:lut"),
    },
    {
      name: t("effects:blend"),
    },
    {
      name: t("effects:negaposi"),
    },
    {
      name: t("effects:chromaKey"),
    },
    {
      name: t("effects:colorKey"),
    },
    {
      name: t("effects:divideEqually"),
    },
    {
      name: t("effects:divideByParts"),
    },
    {
      name: t("effects:transform"),
    },
    {
      name: t("effects:mosaic"),
    },
    {
      name: t("effects:colorShift"),
    }
  ]
}

export default async function EffectsDemo({ lang }: { lang: string }) {
  const { t } = await getTranslation(lang);
  const effects = getEffects(t);

  return (
    // styles.loopSlide, 
    <div className={cn(styles.loopSlide, transparentStyles.transparent, "mt-8 -mx-6 px-6")}>
      <ul className={cn("pt-4 flex flex-wrap justify-between md:justify-center gap-4")}>
        {/* <ul className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8", styles.transparent)}> */}
        {effects.map((item) => (
          <li key={item.name} className={cn(growStyles.listItem, "max-md:flex-auto")}>
            <Card className={growStyles.grow}>
              <CardHeader>
                <CardTitle className="max-md:text-center">{item.name}</CardTitle>
                {/* <CardDescription>Deploy your new project in one-click.</CardDescription> */}
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
      <ul className={cn("pt-4 flex flex-wrap justify-between md:justify-center gap-4")}>
        {/* <ul className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-8", styles.transparent)}> */}
        {effects.map((item) => (
          <li key={item.name} className={cn(growStyles.listItem, "max-md:flex-auto")}>
            <Card className={growStyles.grow}>
              <CardHeader>
                <CardTitle className="max-md:text-center">{item.name}</CardTitle>
                {/* <CardDescription>Deploy your new project in one-click.</CardDescription> */}
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  )
}