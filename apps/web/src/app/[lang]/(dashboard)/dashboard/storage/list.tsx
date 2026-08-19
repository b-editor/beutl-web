"use client";

import { deleteFile } from "./actions";
import {
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Loader2, Trash, Upload } from "lucide-react";

import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import { cn } from "@beutl/core";
import { useCallback, useMemo, useState, useTransition } from "react";
import { useToast } from "@beutl/ui/use-toast";
import { showOpenFileDialog } from "@/lib/fileDialog";
import { uploadStorageFile } from "@/lib/storage-upload";
import { useRouter } from "next/navigation";
import type { File } from "./types";
import { getColumns } from "./columns";
import { useTranslation } from "@beutl/ui/i18n-client";

export function List({ data, lang }: { data: File[]; lang: string }) {
  const { t } = useTranslation(lang);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const [uploading, setUploading] = useState(false);
  // How far the file has got, so a large one does not look stuck. Null when
  // nothing is being sent.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const router = useRouter();
  const [deleting, startDelete] = useTransition();
  const pending = useMemo(() => uploading || deleting, [uploading, deleting]);
  const { toast } = useToast();
  const columns = useMemo(() => getColumns(lang), [lang]);

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
  });
  const handleUploadClick = useCallback(async () => {
    const files = await showOpenFileDialog();

    const file = files?.[0];
    if (!file) {
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      // Sent in parts: one request cannot carry more than 100 MB, and a file
      // here may be as large as the whole quota.
      const outcome = await uploadStorageFile(file, {
        onProgress: (sentBytes) =>
          setUploadProgress(file.size === 0 ? 1 : sentBytes / file.size),
      });
      if (!outcome.ok) {
        toast({
          title: t("error"),
          description: t(`storage:uploadErrors.${outcome.errorCode}`),
          variant: "destructive",
        });
        return;
      }
      router.refresh();
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, [toast, t, router]);

  const handleDeleteClick = useCallback(() => {
    const selectedRows = table.getFilteredSelectedRowModel().rows;
    if (!selectedRows.length) {
      return;
    }
    startDelete(async () => {
      const res = await deleteFile(selectedRows.map((row) => row.original.id));
      if (!res.success) {
        toast({
          title: t("error"),
          description: res.message,
          variant: "destructive",
        });
      } else {
        setRowSelection({});
      }
    });
  }, [table, toast, t]);

  return (
    <div className="w-full px-4">
      <div className="flex items-center py-4 gap-4">
        <Input
          placeholder={t("storage:searchByFileName")}
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
            className={cn(
              Object.keys(rowSelection).length ? "opacity-100" : "opacity-0!",
              "transition-opacity",
            )}
            onClick={handleDeleteClick}
            disabled={pending}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash className="w-4 h-4" />
            )}
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={handleUploadClick}
            disabled={pending}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
      {/* A large file is sent in parts over a long minute or two, so how far it
          has got is worth showing rather than only that something is going on. */}
      {uploadProgress !== null && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(uploadProgress * 100)}
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.round(uploadProgress * 100)}%` }}
          />
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        header.id === "select" && "w-12",
                        header.id === "actions" && "w-16",
                        header.id === "visibility" && "w-24",
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  );
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
                        cell.getContext(),
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
