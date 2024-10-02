"use client";

import { deleteFile, getTemporaryUrl, uploadFile, type retrieveFiles } from "./actions";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, ChevronDown, Delete, File as FileIcon, Image as ImageIcon, Loader2, MoreHorizontal, Trash, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn, formatBytes } from "@/lib/utils";
import type { FileVisibility } from "@prisma/client";
import { useCallback, useMemo, useState, useTransition } from "react";
import { useToast } from "@/hooks/use-toast";

type Files = Awaited<ReturnType<typeof retrieveFiles>>;
type File = Files[number];

const columns: ColumnDef<File>[] = [
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
              content: res.message,
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
      const payment = row.original

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(payment.id)}
            >
              Copy payment ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>View customer</DropdownMenuItem>
            <DropdownMenuItem>View payment details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  },
]

export function List({ data }: { data: Awaited<ReturnType<typeof retrieveFiles>> }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = useState({})
  const [uploading, startUpload] = useTransition()
  const [deleting, startDelete] = useTransition()
  const pending = useMemo(() => uploading || deleting, [uploading, deleting]);
  const { toast } = useToast();

  const table = useReactTable({
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  })
  const showOpenFileDialog = useCallback(() => new Promise<FileList | null>(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => { resolve(input.files); };
    input.click();
  }), []);

  const handleUploadClick = useCallback(async () => {
    const files = await showOpenFileDialog();

    const file = files?.[0];
    if (!file) {
      return;
    }
    startUpload(async () => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await uploadFile(formData);
      if (!res.success) {
        toast({
          title: "エラー",
          content: res.message,
          variant: "destructive",
        });
      }
    });
  }, [showOpenFileDialog, toast]);

  const handleDeleteClick = useCallback(() => {
    const selectedRows = table.getFilteredSelectedRowModel().rows;
    if (!selectedRows.length) {
      return;
    }
    startDelete(async () => {
      const res = await deleteFile(selectedRows.map(row => row.original.id));
      if (!res.success) {
        toast({
          title: "エラー",
          content: res.message,
          variant: "destructive",
        });
      }else{
        setRowSelection({});
      }
    });
  }, [table, toast]);

  return (
    <div className="w-full px-4">
      <div className="flex items-center py-4 gap-4">
        <Input
          placeholder="ファイル名で検索"
          value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
          onChange={(event) =>
            table.getColumn("name")?.setFilterValue(event.target.value)
          }
          className="max-w-sm"
        />
        <div className="ml-auto flex gap-4">

          <Button
            variant="destructive"
            size="icon"
            className={cn(Object.keys(rowSelection).length ? "opacity-100" : "!opacity-0", "transition-opacity")}
            onClick={handleDeleteClick}
            disabled={pending}
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash className="w-4 h-4" />}
          </Button>

          <Button variant="outline" size="icon" onClick={handleUploadClick} disabled={pending}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}
                      className={cn(header.id === "select" && "w-12", header.id === "actions" && "w-16", header.id === "visibility" && "w-24")}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="flex-1 text-sm text-muted-foreground">
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} row(s) selected.
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}