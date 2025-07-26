"use client";

import { Separator } from "@/components/ui/separator";
import type { Package } from "./types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { type FormEvent, useCallback, useOptimistic } from "react";
import { useToast } from "@/hooks/use-toast";
import { updateTag } from "./actions";

export function PackageDetailsForm({ pkg }: { pkg: Package }) {
  const [tags, manipulateTags] = useOptimistic<
    string[],
    { type: "add" | "delete"; tag: string } | { type: "reset"; tags: string[] }
  >(pkg.tags, (state, req) => {
    if (req.type === "add") {
      return [...state, req.tag];
    }

    if (req.type === "delete") {
      return state.filter((tag) => tag !== req.tag);
    }

    if (req.type === "reset") {
      return req.tags;
    }

    return state;
  });
  const { toast } = useToast();

  const handleAddTag = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const formData = new FormData(form);
      const newTag = formData.get("newtag") as string;
      if (tags.includes(newTag)) return;
      manipulateTags({ type: "add", tag: newTag });
      form.reset();

      const res = await updateTag({
        packageId: pkg.id,
        tags: [...tags, newTag],
      });
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
        manipulateTags({ type: "delete", tag: newTag });
      }
    },
    [manipulateTags, tags, pkg.id, toast],
  );

  const handleDeleteTag = useCallback(
    async (tag: string) => {
      // 多分不要？
      const tmptags = tags;
      manipulateTags({ type: "delete", tag });
      const res = await updateTag({
        packageId: pkg.id,
        tags: tags.filter((t) => t !== tag),
      });
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
        manipulateTags({ type: "reset", tags: tmptags });
      }
    },
    [manipulateTags, tags, pkg.id, toast],
  );

  return (
    <div className="lg:basis-1/3">
      <h4 className="font-bold text-lg mt-6 border-b pb-2">詳細</h4>
      <div className="flex gap-2 flex-col my-4">
        <h4>タグ</h4>
        <div className="flex gap-1 flex-wrap">
          {pkg.tags.map((tag) => (
            <Badge key={tag} onClick={() => handleDeleteTag(tag)}>
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
                  <Label htmlFor="newtag">タグ名</Label>
                  <Input name="newtag" id="newtag" className="col-span-2 h-8" />
                </div>
                <Button type="submit" size="sm">
                  追加
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <Separator />
      {/* <div className="flex gap-2 my-4 justify-between">
        <h4>{selectedVersion === defaultVersion ? "最新のバージョン" : "選択されているバージョン"}</h4>
        <p>{selectedVersion}</p>
      </div>
      <Separator />
      <div className="flex gap-2 my-4 justify-between">
        <h4>ターゲットバージョン</h4>
        <p>{selectedRelease?.target_version}</p>
      </div> */}
    </div>
  );
}
