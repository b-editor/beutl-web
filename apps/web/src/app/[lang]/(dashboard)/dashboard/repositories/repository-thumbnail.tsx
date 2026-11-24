"use client";

import { useState } from "react";
import { GitBranch } from "lucide-react";
import type { GitRepositorySummary } from "@beutl/core";

export function repositoryThumbnailUrl(
  repository: Pick<GitRepositorySummary, "id" | "thumbnailUpdatedAt">,
): string | null {
  if (!repository.thumbnailUpdatedAt) return null;
  return `/api/repositories/${repository.id}/thumbnail?v=${encodeURIComponent(repository.thumbnailUpdatedAt)}`;
}

export function RepositoryThumbnail({
  repository,
  variant,
}: {
  repository: Pick<GitRepositorySummary, "id" | "thumbnailUpdatedAt">;
  variant: "card" | "list" | "header";
}) {
  const src = repositoryThumbnailUrl(repository);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = src !== null && failedSrc !== src;

  const image = showImage ? (
    // Authenticated private thumbnails are served directly; /_next/image is intentionally disabled.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      alt=""
      loading={variant === "header" ? undefined : "lazy"}
      decoding="async"
      className="size-full object-cover"
      onError={() => setFailedSrc(src)}
    />
  ) : null;

  if (variant === "card") {
    return image ?? <GitBranch className="size-10 text-muted-foreground" aria-hidden />;
  }

  if (variant === "list") {
    return (
      <span className="flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40">
        {image ?? <GitBranch className="size-4 text-muted-foreground" aria-hidden />}
      </span>
    );
  }

  if (image) {
    return (
      <span className="h-10 aspect-video shrink-0 overflow-hidden rounded-lg border bg-muted/40">
        {image}
      </span>
    );
  }

  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/5 text-primary">
      <GitBranch className="size-5" aria-hidden />
    </span>
  );
}
