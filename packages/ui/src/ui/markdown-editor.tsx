"use client";

import { useId, useState } from "react";
import { cn } from "@beutl/core";
import { Button } from "./button";
import { Markdown } from "./markdown";
import { Textarea, type TextareaProps } from "./textarea";

type MarkdownEditorProps = Omit<TextareaProps, "value" | "defaultValue"> & {
  value: string;
  labels: {
    write: string;
    preview: string;
    hint: string;
    emptyPreview: string;
  };
};

export function MarkdownEditor({
  value,
  labels,
  className,
  disabled,
  id,
  "aria-describedby": describedBy,
  ...props
}: MarkdownEditorProps) {
  const generatedId = useId();
  const editorId = id ?? generatedId;
  const hintId = `${editorId}-hint`;
  const contentId = `${editorId}-content`;
  const [preview, setPreview] = useState(false);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={preview ? "ghost" : "secondary"}
            aria-pressed={!preview}
            aria-controls={contentId}
            disabled={disabled}
            onClick={() => setPreview(false)}
          >
            {labels.write}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={preview ? "secondary" : "ghost"}
            aria-pressed={preview}
            aria-controls={contentId}
            disabled={disabled}
            onClick={() => setPreview(true)}
          >
            {labels.preview}
          </Button>
        </div>
        <p id={hintId} className="text-sm text-muted-foreground">
          {labels.hint}
        </p>
      </div>
      <div id={contentId}>
        {/* Keep the source field in native form submissions while previewing. */}
        <Textarea
          {...props}
          id={editorId}
          value={value}
          disabled={disabled}
          aria-describedby={[describedBy, hintId].filter(Boolean).join(" ")}
          className={cn("min-h-40 font-mono", preview && "hidden")}
        />
        {preview && (
          <div
            role="region"
            aria-label={labels.preview}
            className="min-h-40 rounded-md border border-input bg-background px-3 py-2"
          >
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">{labels.emptyPreview}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
