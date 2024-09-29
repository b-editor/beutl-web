"use client";

import type { PackageResponse } from "@/lib/api"; import { Edit, EyeOff, MoreVertical, Save } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import NavBar from "@/components/nav-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export function PackageInfoForm({ pkg }: { pkg: PackageResponse }) {
  const [edit, setEdit] = useState(false);

  return (
    <>
      <div className="sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4">
          <div className="flex gap-4">
            <Image width={64} height={64}
              className="w-16 h-16 max-w-fit rounded-md"
              alt="Package icon" src={pkg.logo_url ?? ""} />
            <div>
              <h2 className={cn("font-bold text-2xl", edit && "hidden")}>{pkg.display_name}</h2>
              <Input className={cn(!edit && "hidden")} defaultValue={pkg.display_name} />
              <p className="text-muted-foreground text-sm font-medium">{pkg.name}</p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="default" size="default" className={cn(!edit && "hidden")} onClick={() => {
              setEdit(false);
            }}>
              <Save className="w-4 h-4 mr-2" />
              保存
            </Button>
            <Button variant="outline" size="default" className={cn(!edit && "hidden")} onClick={() => {
              setEdit(false);
            }}>
              キャンセル
            </Button>
            <Button variant="ghost" size="icon" className={cn(edit && "hidden")} onClick={() => setEdit(true)}>
              <Edit className="w-4 h-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className={cn(edit && "hidden")}>
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>操作</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>削除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <p className={cn("mt-4 text-foreground/70", edit && "hidden")}>{pkg.short_description}</p>
      <Input className={cn("mt-4", !edit && "hidden")} defaultValue={pkg.short_description} />
    </>
  )
}