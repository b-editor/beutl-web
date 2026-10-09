"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Input } from "@beutl/ui/ui/input";

export function TargetVersionInput({
  id,
  lang,
  value,
  versions,
  placeholder,
  disabled,
  onValueChange,
}: {
  id: string;
  lang: string;
  value: string;
  versions: string[];
  placeholder?: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation(lang);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const options = versions.filter((version) =>
    version.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const showOptions = open && !disabled && options.length > 0;
  const listId = `${id}-options`;

  useEffect(() => {
    if (showOptions && activeIndex >= 0) {
      listRef.current?.children[activeIndex]?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
    }
  }, [activeIndex, showOptions]);

  function selectVersion(version: string) {
    onValueChange(version);
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showOptions}
        aria-controls={showOptions ? listId : undefined}
        aria-activedescendant={showOptions && activeIndex >= 0
          ? `${listId}-${activeIndex}`
          : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => {
          setQuery("");
          setActiveIndex(-1);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActiveIndex(-1);
        }}
        onChange={(event) => {
          onValueChange(event.target.value);
          setQuery(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;

          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = !showOptions || activeIndex < 0
              ? direction === 1 ? 0 : options.length - 1
              : (activeIndex + direction + options.length) % options.length;
            setOpen(true);
            setActiveIndex(nextIndex);
          } else if (event.key === "Enter" && showOptions && activeIndex >= 0) {
            event.preventDefault();
            selectVersion(options[activeIndex]);
          } else if (event.key === "Escape" && showOptions) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
      />
      {showOptions && (
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          onMouseDown={(event) => event.preventDefault()}
        >
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("developer:release.beutlVersions")}
          </p>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t("developer:release.beutlVersions")}
            className="max-h-60 overflow-y-auto"
          >
            {options.map((version, index) => (
              <button
                key={version}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                tabIndex={-1}
                className={cn(
                  "block w-full rounded-sm px-2 py-2 text-left font-mono text-sm hover:bg-accent hover:text-accent-foreground",
                  activeIndex === index && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectVersion(version)}
              >
                {version}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
