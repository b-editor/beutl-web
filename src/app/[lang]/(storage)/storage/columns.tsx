"use client";

import { changeFileVisibility, deleteFile, getTemporaryUrl } from "@/app/(storage)/storage/actions";
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, File as FileIcon, Image as ImageIcon, Loader2, MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatBytes } from "@/lib/utils";
import type { FileVisibility } from "@prisma/client";
import { useCallback, useTransition } from "react";
import { useToast } from "@/hooks/use-toast";
import type { File } from "./types";

export const columns: ColumnDef<File>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        className="block"
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "name",
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          ファイル名
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      )
    },
    cell: ({ row }) => {
      const mimeType = row.original.mimeType;
      const { toast } = useToast();
      const [pending, startTransition] = useTransition();
      const handleClick = useCallback(() => {
        startTransition(async () => {
          const res = await getTemporaryUrl(row.original.id);
          if (!res.success) {
            toast({
              title: "エラー",
              description: res.message,
              variant: "destructive",
            });
            return;
          }

          window.open(res.url, "_blank");
        });
      }, [row.original.id, toast]);

      return (
        <div className="flex gap-2 items-center">
          <Button variant="ghost" size="icon" onClick={handleClick}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" />
              : mimeType.startsWith("image/") ? <ImageIcon className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
          </Button>
          {row.getValue("name")}
        </div>
      );
    },
  },
  {
    accessorKey: "size",
    header: () => <div className="text-right">サイズ</div>,
    cell: ({ row }) => {
      const size = Number.parseFloat(row.getValue("size"))

      return <div className="text-right font-medium">{formatBytes(size)}</div>
    },
  },
  {
    accessorKey: "visibility",
    header: () => <div className="text-right">公開設定</div>,
    cell: ({ row }) => {
      const visibility = row.getValue("visibility") as FileVisibility

      return (
        <div className="text-right font-medium">
          {visibility === "PUBLIC" ? "公開"
            : visibility === "PRIVATE" ? "非公開"
              : "専用"}
        </div>
      )
    },
  },
  {
    id: "actions",
    enableHiding: false,
    cell: ({ row }) => {
      const file = row.original;
      const [pending, startTransition] = useTransition();
      const { toast } = useToast();

      function handleDeleteClick() {
        startTransition(async () => {
          const res = await deleteFile([file.id])
          if (!res.success) {
            toast({
              title: "エラー",
              description: res.message,
              variant: "destructive",
            });
          }
        });
      }

      function handleChangeVisibilityClick(visibility: "PRIVATE" | "PUBLIC") {
        return () => {
          startTransition(async () => {
            const res = await changeFileVisibility([file.id], visibility);
            if (!res.success) {
              toast({
                title: "エラー",
                description: res.message,
                variant: "destructive",
              });
            }
          });
        }
      }

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0" disabled={pending || file.visibility === "DEDICATED"}>
              <span className="sr-only">Open menu</span>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleDeleteClick}>
              削除
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {file.visibility === "PUBLIC" && <DropdownMenuItem onClick={handleChangeVisibilityClick("PRIVATE")}>非公開にする</DropdownMenuItem>}
            {file.visibility === "PRIVATE" && <DropdownMenuItem onClick={handleChangeVisibilityClick("PUBLIC")}>公開する</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  },
]
