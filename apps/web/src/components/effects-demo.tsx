import type { Translator } from "@beutl/i18n";
import { Chip } from "@/components/landing/lp-parts";

const CHIPS: { key: string; hot?: boolean }[] = [
  { key: "effectsChipBlur" },
  { key: "effectsChipDropShadow" },
  { key: "effectsChipInnerShadow" },
  { key: "effectsChipChromaKey", hot: true },
  { key: "effectsChipLut" },
  { key: "effectsChipPixelSort", hot: true },
  { key: "effectsChipBorder" },
  { key: "effectsChipFlatShadow" },
  { key: "effectsChipDisplace", hot: true },
  { key: "effectsChipMosaic" },
  { key: "effectsChipColorShift" },
  { key: "effectsChipColorGrading" },
  { key: "effectsChipDilateErode" },
  { key: "effectsChipShake" },
  { key: "effectsChipPathFollow" },
];

export default function EffectsDemo({ t }: { t: Translator }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map((chip) => (
        <Chip key={chip.key} hot={chip.hot}>
          {t(`main:${chip.key}`)}
        </Chip>
      ))}
    </div>
  );
}
