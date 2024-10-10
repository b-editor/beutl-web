"use client";

import { ArrowLeft, ArrowRight, Loader2, MoreVertical, Plus, Trash } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCallback, useOptimistic, useTransition } from "react";
import { addScreenshot, moveScreenshot, deleteScreenshot } from "./actions";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { showOpenFileDialog } from "@/lib/fileDialog";
import { useToast } from "@/hooks/use-toast";
import type { Package } from "./types";

export function ScreenshotForm({ pkg }: { pkg: Package }) {
  const [screenshots, moveOptimisticScreenshot] = useOptimistic<Package["PackageScreenshot"], { delta: number, item: Package["PackageScreenshot"][number] }
  >(pkg.PackageScreenshot, (state, req) => {
    const index = state.indexOf(req.item);
    if (index === 0 && req.delta < 0)
      return state;
    if (index === state.length - 1 && req.delta > 0)
      return state;
    if (index === -1)
      return state;

    const newState = state.slice();
    newState.splice(index, 1);
    // req.deltaが0の場合は削除
    if (req.delta !== 0) {
      newState.splice(index + req.delta, 0, req.item);
    }
    return newState;
  });
  const [adding, startAdd] = useTransition();
  const { toast } = useToast();

  const handleAddClick = useCallback(async () => {
    const files = await showOpenFileDialog({ accept: "image/*" });

    const file = files?.[0];
    if (!file) {
      return;
    }
    startAdd(async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("id", pkg.id);
      const res = await addScreenshot(formData);
      if (!res.success) {
        toast({
          title: "エラー",
          description: res.message,
          variant: "destructive",
        });
      }
    });
  }, [toast, pkg.id]);

  const handleMove = useCallback(async (delta: number, item: Package["PackageScreenshot"][number]) => {
    moveOptimisticScreenshot({ delta, item })
    const res = await moveScreenshot({ delta, packageId: pkg.id, fileId: item.file.id });
    if (!res.success) {
      toast({
        title: "エラー",
        description: res.message,
        variant: "destructive",
      });
    }
  }, [pkg.id, moveOptimisticScreenshot, toast]);

  const handleDelete = useCallback(async (item: Package["PackageScreenshot"][number]) => {
    moveOptimisticScreenshot({ delta: 0, item })
    const res = await deleteScreenshot({ packageId: pkg.id, fileId: item.file.id });
    if (!res.success) {
      toast({
        title: "エラー",
        description: res.message,
        variant: "destructive",
      });
    }
  }, [pkg.id, moveOptimisticScreenshot, toast]);

  return (
    <>
      <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
      <Carousel className="mt-4">
        <CarouselContent>
          {screenshots.map((item) => (
            <CarouselItem className="w-min max-w-min min-w-min group relative" key={item.file.id}>
              <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src={item.url} priority />
              <div className="absolute top-2 right-2">

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="invisible group-hover:visible max-lg:visible">
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => handleMove(-1, item)}>
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      左に移動
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleMove(1, item)}>
                      <ArrowRight className="w-4 h-4 mr-2" />
                      右に移動
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDelete(item)}>
                      <Trash className="w-4 h-4 mr-2" />
                      削除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CarouselItem>
          ))}
          <CarouselItem className="w-min max-w-min min-w-min">
            <Button variant="secondary" className="rounded w-80 h-80" onClick={handleAddClick}>
              <div className="flex gap-2 items-center justify-center h-full">
                {adding ? <Loader2 className="w-8 h-8" /> : <Plus className="w-8 h-8" />}
                追加
              </div>
            </Button>
          </CarouselItem>
        </CarouselContent>
        <CarouselPrevious className="max-lg:hidden left-0 -translate-x-1/2 w-8 h-8" />
        <CarouselNext className="max-lg:hidden right-0 translate-x-1/2 w-8 h-8" />
      </Carousel>
    </>
  )
}
