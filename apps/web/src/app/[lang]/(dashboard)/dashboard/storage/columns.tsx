"use client";

import type { Column, ColumnDef, Row, Table } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@beutl/ui/ui/button";
import { Checkbox } from "@beutl/ui/ui/checkbox";
import { cn, formatBytes, formatDateTime } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { fileKind, fileKindIcon, RAW } from "./file-kind";
import { RowActionsButton, type FileListHandlers } from "./file-actions";
import { useVisibilitySpec, VisibilityBadge } from "./visibility-badge";
import type { StorageFile } from "./types";

// Widths and responsive visibility are keyed by column id, so the <th> and
// <td> of one column (and the folder rows the list renders itself) agree.
export const COLUMN_CLASS: Record<string, string> = {
  select: "w-10 pr-0",
  // max-w-0 lets the name cell take the remaining width and still truncate;
  // the min width keeps it readable and lets the table scroll sideways
  // instead of squeezing the name to nothing.
  name: "w-full min-w-40 max-w-0",
  location: "hidden w-48 max-w-0 md:table-cell",
  // Below sm the size and visibility move under the file name (see NameCell).
  size: "hidden w-28 whitespace-nowrap text-right sm:table-cell",
  visibility: "hidden w-28 whitespace-nowrap sm:table-cell",
  createdAt: "hidden w-44 whitespace-nowrap md:table-cell",
  actions: "w-12 pl-0",
};

// Checkboxes stay out of the way until a row is hovered, focused or selected.
// Coarse pointers have no hover, so they always get them.
export function checkboxVisibility(visible: boolean): string {
  return visible
    ? "opacity-100"
    : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100";
}

function ColumnHeader({
  column,
  labelKey,
  lang,
  align = "left",
}: {
  column: Column<StorageFile, unknown>;
  labelKey: string;
  lang: string;
  align?: "left" | "right";
}) {
  const { t } = useTranslation(lang);
  if (!column.getCanSort()) {
    return <span>{t(labelKey)}</span>;
  }
  const sorted = column.getIsSorted();
  const Icon =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-8 gap-1 px-2", align === "left" ? "-ml-2" : "-mr-2")}
      onClick={() => column.toggleSorting(sorted === "asc")}
      title={
        sorted === "asc" ? t("storage:sortDescending") : t("storage:sortAscending")
      }
    >
      {t(labelKey)}
      <Icon
        className={cn("h-3.5 w-3.5", !sorted && "text-muted-foreground")}
        aria-hidden
      />
    </Button>
  );
}

function SelectAllCheckbox({
  table,
  lang,
  visible,
}: {
  table: Table<StorageFile>;
  lang: string;
  visible: boolean;
}) {
  const { t } = useTranslation(lang);
  const all = table.getIsAllPageRowsSelected();
  const some = table.getIsSomePageRowsSelected();
  return (
    <Checkbox
      className={cn("transition-opacity", checkboxVisibility(visible || all || some))}
      checked={all || (some && "indeterminate")}
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      aria-label={t("storage:selectAll")}
    />
  );
}

function SelectRowCheckbox({
  row,
  lang,
  visible,
}: {
  row: Row<StorageFile>;
  lang: string;
  visible: boolean;
}) {
  const { t } = useTranslation(lang);
  const selected = row.getIsSelected();
  return (
    <Checkbox
      className={cn("block transition-opacity", checkboxVisibility(visible || selected))}
      checked={selected}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      aria-label={t("storage:selectRow", { name: row.original.name, ...RAW })}
    />
  );
}

function NameCell({ file, lang }: { file: StorageFile; lang: string }) {
  const Icon = fileKindIcon(fileKind(file.mimeType));
  const visibility = useVisibilitySpec(file.visibility, lang);
  return (
    <div className="flex min-w-0 items-center gap-2 font-medium" title={file.name}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{file.name}</span>
        {/* Narrow screens drop the size and visibility columns; the same
            facts move under the name so a row still says what it is. */}
        <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground sm:hidden">
          <span className="tabular-nums">{formatBytes(Number(file.size))}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <visibility.Icon className="h-3 w-3" aria-hidden />
            {visibility.label}
          </span>
        </span>
      </span>
    </div>
  );
}

export function getColumns({
  lang,
  busy,
  handlers,
  showCheckboxes,
  locationOf,
}: {
  lang: string;
  busy: boolean;
  handlers: FileListHandlers;
  showCheckboxes: boolean;
  locationOf: (file: StorageFile) => string;
}): ColumnDef<StorageFile>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <SelectAllCheckbox table={table} lang={lang} visible={showCheckboxes} />
      ),
      cell: ({ row }) => (
        <SelectRowCheckbox row={row} lang={lang} visible={showCheckboxes} />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <ColumnHeader column={column} labelKey="storage:fileName" lang={lang} />
      ),
      cell: ({ row }) => <NameCell file={row.original} lang={lang} />,
      sortingFn: "alphanumeric",
      filterFn: "includesString",
    },
    {
      id: "location",
      accessorFn: (file) => locationOf(file),
      header: ({ column }) => (
        <ColumnHeader column={column} labelKey="storage:location" lang={lang} />
      ),
      cell: ({ getValue }) => (
        <span
          className="block truncate text-muted-foreground"
          title={getValue<string>()}
        >
          {getValue<string>()}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "size",
      accessorFn: (file) => Number(file.size),
      header: ({ column }) => (
        <ColumnHeader
          column={column}
          labelKey="storage:size"
          lang={lang}
          align="right"
        />
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums">{formatBytes(getValue<number>())}</span>
      ),
      sortingFn: "basic",
    },
    {
      id: "visibility",
      accessorKey: "visibility",
      header: ({ column }) => (
        <ColumnHeader
          column={column}
          labelKey="storage:visibilitySettings"
          lang={lang}
        />
      ),
      cell: ({ row }) => (
        <VisibilityBadge visibility={row.original.visibility} lang={lang} />
      ),
      enableSorting: false,
      filterFn: "equals",
    },
    {
      id: "createdAt",
      accessorFn: (file) => new Date(file.createdAt).getTime(),
      header: ({ column }) => (
        <ColumnHeader column={column} labelKey="storage:createdAt" lang={lang} />
      ),
      cell: ({ row }) => (
        <time
          dateTime={new Date(row.original.createdAt).toISOString()}
          className="tabular-nums text-muted-foreground"
        >
          {formatDateTime(row.original.createdAt, lang)}
        </time>
      ),
      sortingFn: "basic",
    },
    {
      // Never shown; exists so the "type" chip can filter through the table.
      id: "kind",
      accessorFn: (file) => fileKind(file.mimeType),
      enableSorting: false,
      filterFn: "equals",
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <RowActionsButton
          file={row.original}
          lang={lang}
          busy={busy}
          handlers={handlers}
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
  ];
}
