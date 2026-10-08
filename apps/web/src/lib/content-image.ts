// Keep the number of generated images bounded. Each preset has a normal and
// a high density version; callers cannot request arbitrary sizes or quality.
export const CONTENT_IMAGE_VARIANTS = {
  "icon-64": { width: 64, height: 64 },
  "icon-128": { width: 128, height: 128 },
  "screenshot-320": { width: 1920, height: 320 },
  "screenshot-640": { width: 3840, height: 640 },
  "thumbnail-320": { width: 320, height: 320 },
  "thumbnail-640": { width: 640, height: 640 },
  "preview-1024": { width: 1024, height: 1024 },
  "preview-2048": { width: 2048, height: 2048 },
} as const;

export type ContentImageVariant = keyof typeof CONTENT_IMAGE_VARIANTS;
export type ContentImagePreset = "icon" | "screenshot" | "thumbnail" | "preview";

const PRESET_VARIANTS: Record<ContentImagePreset, readonly [ContentImageVariant, ContentImageVariant]> = {
  icon: ["icon-64", "icon-128"],
  screenshot: ["screenshot-320", "screenshot-640"],
  thumbnail: ["thumbnail-320", "thumbnail-640"],
  preview: ["preview-1024", "preview-2048"],
};

/** Change only a stored image's display URL; uploads and live data previews pass through. */
export function contentImageSources(src: string, preset: ContentImagePreset, options?: {
  intrinsicSizing?: boolean;
}) {
  if (!src.startsWith("/") && !/^https?:\/\//u.test(src)) return { src };
  const base = new URL(src, "https://beutl.invalid");
  if (!/^\/api\/contents\/[^/]+$/u.test(base.pathname)) return { src };

  const variantUrl = (variant: ContentImageVariant) => {
    const url = new URL(base);
    url.searchParams.set("image", variant);
    return src.startsWith("/") && !src.startsWith("//")
      ? `${url.pathname}${url.search}${url.hash}`
      : url.href;
  };
  const [normal, retina] = PRESET_VARIANTS[preset];
  // Natural-size consumers must not divide a fallback original's dimensions
  // by a density descriptor. Request the largest preset without a srcset.
  if (options?.intrinsicSizing) return { src: variantUrl(retina) };
  return {
    src: variantUrl(normal),
    srcSet: `${variantUrl(normal)} 1x, ${variantUrl(retina)} 2x`,
  };
}
