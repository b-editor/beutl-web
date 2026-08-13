"use client";

import { Separator } from "@beutl/ui/ui/separator";
import type { Package } from "./types";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import { Plus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@beutl/ui/ui/popover";
import { Label } from "@beutl/ui/ui/label";
import { Input } from "@beutl/ui/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import {
  type FormEvent,
  useCallback,
  useOptimistic,
  useTransition,
} from "react";
import { useToast } from "@beutl/ui/use-toast";
import { updateTag } from "./actions/package";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  applyPackageType,
  getPackageType,
  isPackageType,
  isReservedPackageTag,
  PACKAGE_TYPES,
  visiblePackageTags,
} from "@beutl/core";
import type { PackageType } from "@beutl/core";

const PACKAGE_TYPE_LABEL_KEYS: Record<PackageType, string> = {
  extension: "developer:details.packageTypeExtension",
  material: "developer:details.packageTypeMaterial",
  template: "developer:details.packageTypeTemplate",
  both: "developer:details.packageTypeBoth",
};

const PACKAGE_TYPE_DESCRIPTION_KEYS: Record<PackageType, string> = {
  extension: "developer:details.packageTypeDescriptionExtension",
  material: "developer:details.packageTypeDescriptionMaterial",
  template: "developer:details.packageTypeDescriptionTemplate",
  both: "developer:details.packageTypeDescriptionBoth",
};

export function PackageDetailsForm({
  pkg,
  lang,
}: { pkg: Package; lang: string }) {
  const [tags, setTags] = useOptimistic<string[], string[]>(
    pkg.tags,
    (_state, next) => next,
  );
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const { t } = useTranslation(lang);

  /*
    The optimistic value only survives for the life of the transition, which is
    exactly what we want: a successful save revalidates `pkg.tags` underneath us,
    and a failed one falls back to the unchanged server value on its own.
  */
  const commitTags = useCallback(
    (nextTags: string[]) => {
      startTransition(async () => {
        setTags(nextTags);
        const res = await updateTag({ packageId: pkg.id, tags: nextTags });
        if (!res.success) {
          toast({
            title: t("developer:common.error"),
            description: res.message,
            variant: "destructive",
          });
        }
      });
    },
    [setTags, pkg.id, t, toast],
  );

  const handleAddTag = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (isPending) return;
      const form = e.target as HTMLFormElement;
      const formData = new FormData(form);
      const newTag = (formData.get("newtag") as string).trim();
      if (!newTag) return;
      // The store reads the package kind out of these two tags, so letting an
      // author type one by hand would silently reclassify the package.
      if (isReservedPackageTag(newTag)) {
        toast({
          title: t("developer:common.error"),
          description: t("developer:details.reservedTag"),
          variant: "destructive",
        });
        return;
      }
      if (tags.includes(newTag)) return;
      form.reset();

      commitTags([...tags, newTag]);
    },
    [commitTags, isPending, tags, t, toast],
  );

  const handleDeleteTag = useCallback(
    (tag: string) => {
      if (isPending) return;
      commitTags(tags.filter((t) => t !== tag));
    },
    [commitTags, isPending, tags],
  );

  const handleChangeType = useCallback(
    (value: string) => {
      if (isPending) return;
      if (!isPackageType(value)) return;
      commitTags(applyPackageType(tags, value));
    },
    [commitTags, isPending, tags],
  );

  return (
    <div>
      <h4 className="font-bold text-lg mt-6 border-b pb-2">
        {t("developer:details.title")}
      </h4>
      <div className="flex gap-2 flex-col my-4">
        <h4>{t("developer:details.packageType")}</h4>
        <Select value={getPackageType(tags)} onValueChange={handleChangeType} disabled={isPending}>
          <SelectTrigger className="md:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PACKAGE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(PACKAGE_TYPE_LABEL_KEYS[type])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {t(PACKAGE_TYPE_DESCRIPTION_KEYS[getPackageType(tags)])}
        </p>
      </div>
      <Separator />
      <div className="flex gap-2 flex-col my-4">
        <h4>{t("developer:details.tags")}</h4>
        <div className="flex gap-1 flex-wrap">
          {visiblePackageTags(tags).map((tag) => (
            <Badge key={tag} onClick={() => handleDeleteTag(tag)} className={isPending ? "pointer-events-none opacity-60" : undefined}>
              {tag}
              <X className="ml-1 w-4 h-4" />
            </Badge>
          ))}
          <Popover>
            <PopoverTrigger>
              <Badge className="h-full">
                <Plus className="w-4 h-4" />
              </Badge>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <form className="flex flex-col gap-4" onSubmit={handleAddTag}>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="newtag">
                    {t("developer:details.tagName")}
                  </Label>
                  <Input name="newtag" id="newtag" className="col-span-2 h-8" />
                </div>
                <Button type="submit" size="sm" disabled={isPending}>
                  {t("developer:common.add")}
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <Separator />
    </div>
  );
}
