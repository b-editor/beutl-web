"use client";

import {
  changeFileVisibility,
  createFolder,
  deleteFile,
  deleteFolder,
  moveFiles,
  moveFolder,
  renameFile,
  renameFolder,
} from "./actions";
import {
  type ColumnFiltersState,
  type Row,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Folder,
  FolderPlus,
  HardDrive,
  Info,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@beutl/ui/ui/alert-dialog";
import { Button } from "@beutl/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@beutl/ui/ui/dropdown-menu";
import { Input } from "@beutl/ui/ui/input";
import { Progress } from "@beutl/ui/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@beutl/ui/ui/toggle-group";
import { TooltipProvider } from "@beutl/ui/ui/tooltip";
import { cn, formatDateTime } from "@beutl/core";
import type { ActionResult } from "@beutl/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type DragEvent,
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useToast } from "@beutl/ui/use-toast";
import { showOpenFileDialog } from "@/lib/fileDialog";
import {
  resumeStorageUploadCompletion,
  discardPendingStorageUploadCompletion,
  loadPendingStorageUploadCompletions,
  persistPendingStorageUploadCompletion,
  withStorageUploadLock,
  type PendingStorageUploadCompletion,
  uploadStorageFile,
} from "@/lib/storage-upload";
import { useTranslation } from "@beutl/ui/i18n-client";
import type { StorageFile, StorageFolder } from "./types";
import { COLUMN_CLASS, getColumns } from "./columns";
import { FILE_KINDS, isDedicated, openFile, RAW } from "./file-kind";
import {
  FileContextMenu,
  FolderActionsButton,
  FolderContextMenu,
  SelectionBar,
  type FileListHandlers,
  type FileVisibilityChange,
  type FolderHandlers,
} from "./file-actions";
import { FileCard, FolderCard } from "./grid-card";
import { DetailsPanel } from "./details-panel";
import { NameDialog } from "./name-dialog";
import { MoveDialog } from "./move-dialog";

const PAGE_SIZE = 24;
// The shared table pads cells for forms; a file list wants the tighter rows of
// a file manager, so the storage screen overrides the vertical padding here.
const HEAD_CLASS = "h-10";
const CELL_CLASS = "py-2";
const VIEW_STORAGE_KEY = "beutl.storage.view";
// Internal drag payload type. OS file drops carry "Files" instead, so the two
// never get confused.
const DRAG_TYPE = "application/x-beutl-storage";

type ViewMode = "grid" | "list";
type SortField = "name" | "size" | "createdAt";
type DragPayload = { files: string[]; folders: string[] };
type UploadStatus = {
  name: string;
  index: number;
  total: number;
  progress: number;
};
type ItemProps = HTMLAttributes<HTMLElement> & { draggable?: boolean };

function readStoredView(): ViewMode | null {
  try {
    const value = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return value === "grid" || value === "list" ? value : null;
  } catch {
    return null;
  }
}

function storeView(view: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // A blocked store only loses the preference.
  }
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Clicks on controls inside a row or card belong to the control, not to the
// selection.
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "a, button, input, textarea, select, [role='menuitem'], [role='checkbox']",
    ) !== null
  );
}

function hasOsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function hasInternalDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE);
}

function readDrag(event: DragEvent): DragPayload | null {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { files, folders } = parsed as Record<string, unknown>;
    if (!Array.isArray(files) || !Array.isArray(folders)) return null;
    const strings = (list: unknown[]) =>
      list.filter((value): value is string => typeof value === "string");
    return { files: strings(files), folders: strings(folders) };
  } catch {
    return null;
  }
}

function byName(left: StorageFolder, right: StorageFolder): number {
  return left.name.localeCompare(right.name);
}

function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const active = value !== "all";
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1 rounded-full pl-3 pr-2",
            active && "border-primary/50 bg-primary/10",
          )}
        >
          {active && current ? `${label}: ${current.label}` : label}
          <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortChip({
  lang,
  sorting,
  onChange,
}: {
  lang: string;
  sorting: SortingState[number] | undefined;
  onChange: (field: SortField, desc: boolean) => void;
}) {
  const { t } = useTranslation(lang);
  const field = (sorting?.id ?? "createdAt") as SortField;
  const desc = sorting?.desc ?? true;
  const labels: Record<SortField, string> = {
    name: t("storage:sortName"),
    size: t("storage:sortSize"),
    createdAt: t("storage:sortCreatedAt"),
  };
  const Arrow = desc ? ArrowDown : ArrowUp;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1 rounded-full pl-3 pr-2"
        >
          {t("storage:sortBy")}: {labels[field]}
          <Arrow className="h-3.5 w-3.5 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={field}
          onValueChange={(value) => onChange(value as SortField, desc)}
        >
          {(Object.keys(labels) as SortField[]).map((key) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {labels[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={desc ? "desc" : "asc"}
          onValueChange={(value) => onChange(field, value === "desc")}
        >
          <DropdownMenuRadioItem value="asc">
            {t("storage:sortAscending")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc">
            {t("storage:sortDescending")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function List({
  data,
  folders,
  lang,
  userId,
}: {
  data: StorageFile[];
  folders: StorageFolder[];
  lang: string;
  userId: string;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isLarge = useMediaQuery("(min-width: 1024px)");

  // ---- folder tree -------------------------------------------------------
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder] as const)),
    [folders],
  );
  // A parent that no longer exists is treated as the root rather than losing
  // the folder from view.
  const parentOf = useCallback(
    (folder: StorageFolder): string | null =>
      folder.parentId !== null && foldersById.has(folder.parentId)
        ? folder.parentId
        : null,
    [foldersById],
  );
  const folderOf = useCallback(
    (file: StorageFile): string | null =>
      file.folderId !== null && foldersById.has(file.folderId)
        ? file.folderId
        : null,
    [foldersById],
  );
  const childFolders = useMemo(() => {
    const map = new Map<string | null, StorageFolder[]>();
    for (const folder of folders) {
      const key = parentOf(folder);
      const list = map.get(key);
      if (list) list.push(folder);
      else map.set(key, [folder]);
    }
    for (const list of map.values()) list.sort(byName);
    return map;
  }, [folders, parentOf]);
  const requestedFolderId = searchParams?.get("folder") ?? null;
  const currentFolderId =
    requestedFolderId !== null && foldersById.has(requestedFolderId)
      ? requestedFolderId
      : null;
  const currentFolderRef = useRef(currentFolderId);
  useEffect(() => {
    currentFolderRef.current = currentFolderId;
  }, [currentFolderId]);
  const folderChain = useMemo(() => {
    const chain: StorageFolder[] = [];
    let cursor = currentFolderId;
    while (cursor !== null) {
      const folder = foldersById.get(cursor);
      if (!folder || chain.includes(folder)) break;
      chain.unshift(folder);
      cursor = parentOf(folder);
    }
    return chain;
  }, [currentFolderId, foldersById, parentOf]);
  const folderPath = useCallback(
    (folderId: string | null): string => {
      const parts: string[] = [];
      let cursor = folderId;
      const seen = new Set<string>();
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const folder = foldersById.get(cursor);
        if (!folder) break;
        parts.unshift(folder.name);
        cursor = parentOf(folder);
      }
      return [t("storage:myStorage"), ...parts].join(" / ");
    },
    [foldersById, parentOf, t],
  );
  const folderName = useCallback(
    (folderId: string | null): string =>
      folderId === null
        ? t("storage:myStorage")
        : (foldersById.get(folderId)?.name ?? t("storage:myStorage")),
    [foldersById, t],
  );
  // The folder and everything below it.
  const subtreeIds = useCallback(
    (folderId: string): Set<string> => {
      const ids = new Set([folderId]);
      const queue = [folderId];
      while (queue.length > 0) {
        const id = queue.shift() as string;
        for (const child of childFolders.get(id) ?? []) {
          if (!ids.has(child.id)) {
            ids.add(child.id);
            queue.push(child.id);
          }
        }
      }
      return ids;
    },
    [childFolders],
  );

  // ---- table state -------------------------------------------------------
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [view, setView] = useState<ViewMode>("grid");
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const stored = readStoredView();
    if (stored) setView(stored);
  }, []);

  const filterValue = (id: string): string =>
    (columnFilters.find((filter) => filter.id === id)?.value as
      | string
      | undefined) ?? "";
  const setFilter = (id: string, value: string | undefined) =>
    setColumnFilters((current) => [
      ...current.filter((filter) => filter.id !== id),
      ...(value ? [{ id, value }] : []),
    ]);
  const query = filterValue("name");
  const kindFilter = filterValue("kind") || "all";
  const visibilityFilter = filterValue("visibility") || "all";
  const searching = query.trim().length > 0;
  const filtersActive = kindFilter !== "all" || visibilityFilter !== "all";

  // Search looks everywhere, the way Drive does; otherwise only this folder.
  const tableData = useMemo(
    () =>
      searching
        ? data
        : data.filter((file) => folderOf(file) === currentFolderId),
    [data, searching, currentFolderId, folderOf],
  );
  const visibleFolders = useMemo(() => {
    if (!searching) return childFolders.get(currentFolderId) ?? [];
    const needle = query.trim().toLowerCase();
    return folders
      .filter((folder) => folder.name.toLowerCase().includes(needle))
      .sort(byName);
  }, [searching, childFolders, currentFolderId, folders, query]);

  // Every file and folder is already on the client, so opening a folder is a
  // URL change and nothing else. Next.js integrates the native pushState with
  // its router (14.1+), so useSearchParams above sees the new "folder" value
  // and the back button walks the folders again; router.push would instead
  // refetch the whole page from the server for each step.
  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (folderId) params.set("folder", folderId);
      else params.delete("folder");
      const search = params.toString();
      window.history.pushState(
        null,
        "",
        search ? `${pathname}?${search}` : pathname,
      );
      setRowSelection({});
    },
    [searchParams, pathname],
  );

  // ---- requests ----------------------------------------------------------
  const [pendingOps, setPendingOps] = useState(0);
  const mutate = useCallback(
    async (
      request: () => Promise<ActionResult<unknown>>,
      successTitle?: string,
    ): Promise<boolean> => {
      setPendingOps((count) => count + 1);
      try {
        const result = await request();
        if (!result.success) {
          toast({
            title: t("error"),
            description: result.message,
            variant: "destructive",
          });
          return false;
        }
        if (successTitle) toast({ title: successTitle });
        return true;
      } catch {
        toast({
          title: t("error"),
          description: t("somethingWentWrong"),
          variant: "destructive",
        });
        return false;
      } finally {
        setPendingOps((count) => count - 1);
      }
    },
    [toast, t],
  );

  const [confirmDelete, setConfirmDelete] = useState<{
    files: StorageFile[];
    skipped: number;
  } | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] =
    useState<StorageFolder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<
    | { kind: "file"; file: StorageFile }
    | { kind: "folder"; folder: StorageFolder }
    | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<
    | { kind: "files"; files: StorageFile[] }
    | { kind: "folder"; folder: StorageFolder }
    | null
  >(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  const changeVisibility = useCallback(
    async (files: StorageFile[], visibility: FileVisibilityChange) => {
      const ids = files.filter((file) => !isDedicated(file)).map((f) => f.id);
      if (!ids.length) return false;
      return mutate(
        () => changeFileVisibility(ids, visibility),
        t("storage:visibilityChanged"),
      );
    },
    [mutate, t],
  );
  const requestDelete = useCallback((files: StorageFile[]) => {
    const deletable = files.filter((file) => !isDedicated(file));
    if (deletable.length) {
      setConfirmDelete({
        files: deletable,
        skipped: files.length - deletable.length,
      });
    }
  }, []);
  const requestRename = useCallback((file: StorageFile) => {
    setRenameTarget({ kind: "file", file });
  }, []);
  const requestMove = useCallback((files: StorageFile[]) => {
    if (files.length) setMoveTarget({ kind: "files", files });
  }, []);
  const showDetails = useCallback((file: StorageFile) => {
    setRowSelection({ [file.id]: true });
    setDetailsOpen(true);
  }, []);
  const handlers = useMemo<FileListHandlers>(
    () => ({
      requestDelete,
      requestRename,
      requestMove,
      changeVisibility,
      showDetails,
      detailsAvailable: isLarge,
    }),
    [requestDelete, requestRename, requestMove, changeVisibility, showDetails, isLarge],
  );
  const folderHandlers = useMemo<FolderHandlers>(
    () => ({
      openFolder: (folder) => navigateToFolder(folder.id),
      requestRenameFolder: (folder) => setRenameTarget({ kind: "folder", folder }),
      requestMoveFolder: (folder) => setMoveTarget({ kind: "folder", folder }),
      requestDeleteFolder: (folder) => setConfirmDeleteFolder(folder),
    }),
    [navigateToFolder],
  );

  // ---- upload ------------------------------------------------------------
  const [uploading, setUploading] = useState(false);
  // What is being sent right now, so a large file does not look stuck. Null
  // when nothing is being sent.
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  // Completion is retried by opaque receipt handle, not by retaining the File
  // selected in the picker. The handle survives a failed click and a new File
  // object on the next click, while the body bytes are never retained here.
  const [pendingCompletion, setPendingCompletion] =
    useState<PendingStorageUploadCompletion | null>(null);
  const pendingCompletionRef = useRef<PendingStorageUploadCompletion[]>([]);
  const uploadLock = useRef(false);
  const autoResume = useRef(false);
  const ownerRef = useRef(userId);
  useEffect(() => {
    ownerRef.current = userId;
    autoResume.current = false;
    pendingCompletionRef.current = loadPendingStorageUploadCompletions(userId);
    setPendingCompletion(pendingCompletionRef.current[0] ?? null);
  }, [userId]);
  const rememberCompletion = useCallback(
    (handle: PendingStorageUploadCompletion | undefined) => {
      if (ownerRef.current !== userId) return;
      if (!handle) {
        const current = pendingCompletionRef.current[0];
        if (current)
          discardPendingStorageUploadCompletion(current.uploadId, userId);
        pendingCompletionRef.current = pendingCompletionRef.current.slice(1);
      } else {
        persistPendingStorageUploadCompletion(handle);
        pendingCompletionRef.current = [
          ...pendingCompletionRef.current.filter(
            (entry) => entry.uploadId !== handle.uploadId,
          ),
          handle,
        ];
      }
      setPendingCompletion(pendingCompletionRef.current[0] ?? null);
    },
    [userId],
  );
  const rememberVolatileCompletion = useCallback(
    (handle: PendingStorageUploadCompletion | undefined) => {
      if (!handle || ownerRef.current !== userId) return;
      pendingCompletionRef.current = [
        ...pendingCompletionRef.current.filter(
          (entry) => entry.uploadId !== handle.uploadId,
        ),
        handle,
      ];
      setPendingCompletion(handle);
    },
    [userId],
  );
  const completionPending = pendingCompletion !== null;
  const busy = uploading || pendingOps > 0 || deleting;

  // Assumes the upload lock is held by the caller.
  const runResume = useCallback(async () => {
    const pending = pendingCompletionRef.current[0];
    if (!pending) return;
    setUploading(true);
    try {
      const outcome = await resumeStorageUploadCompletion(pending);
      if (outcome.ok) {
        rememberCompletion(undefined);
        toast({
          title: t("storage:uploaded", { name: outcome.file.name, ...RAW }),
        });
        router.refresh();
      } else {
        // Only a clear terminal response drops the handle. Network, 5xx and
        // unreadable JSON return it so the next click can ask again.
        if (outcome.errorCode === "storagePersistenceUnavailable") {
          rememberVolatileCompletion(outcome.pendingCompletion);
        } else {
          rememberCompletion(outcome.pendingCompletion);
        }
        toast({
          title: t("error"),
          description: t(`storage:uploadErrors.${outcome.errorCode}`),
          variant: "destructive",
        });
      }
    } finally {
      setUploading(false);
    }
  }, [rememberCompletion, rememberVolatileCompletion, toast, t, router]);

  // Assumes the upload lock is held by the caller. Files go one after another:
  // the server caps in-flight uploads per user, and one progress bar is easier
  // to read than several. The first failure stops the rest.
  const runUploads = useCallback(
    async (files: File[]) => {
      if (!files.length || pendingCompletionRef.current.length) return;
      setUploading(true);
      let uploaded = 0;
      let lastName = "";
      try {
        for (const [index, file] of files.entries()) {
          setUploadStatus({
            name: file.name,
            index: index + 1,
            total: files.length,
            progress: 0,
          });
          // Sent in parts: one request cannot carry more than 100 MB, and a
          // file here may be as large as the whole quota.
          const outcome = await uploadStorageFile(file, {
            ownerId: userId,
            onProgress: (sentBytes) =>
              setUploadStatus((status) =>
                status && {
                  ...status,
                  progress: file.size === 0 ? 1 : sentBytes / file.size,
                },
              ),
          });
          if (!outcome.ok) {
            if (outcome.errorCode === "storagePersistenceUnavailable") {
              rememberVolatileCompletion(outcome.pendingCompletion);
            } else {
              rememberCompletion(outcome.pendingCompletion);
            }
            toast({
              title: t("storage:uploadFailedFor", { name: file.name, ...RAW }),
              description: t(`storage:uploadErrors.${outcome.errorCode}`),
              variant: "destructive",
            });
            break;
          }
          rememberCompletion(undefined);
          uploaded += 1;
          lastName = outcome.file.name;
          // The upload pipeline knows nothing about folders; the finished file
          // is filed where the user is looking as a separate step. If that
          // step fails the file is still safe at the root.
          const folderId = currentFolderRef.current;
          if (folderId !== null) {
            await moveFiles([outcome.file.id], folderId).catch(() => undefined);
          }
          // Each finished file shows up right away rather than after the batch.
          router.refresh();
        }
        if (uploaded === 1) {
          toast({ title: t("storage:uploaded", { name: lastName, ...RAW }) });
        } else if (uploaded > 1) {
          toast({ title: t("storage:uploadedMany", { count: uploaded }) });
        }
      } finally {
        setUploading(false);
        setUploadStatus(null);
      }
    },
    [rememberCompletion, rememberVolatileCompletion, toast, t, router, userId],
  );

  const resumePending = useCallback(
    () => withStorageUploadLock(uploadLock, runResume),
    [runResume],
  );

  const handleUploadClick = useCallback(async () => {
    await withStorageUploadLock(uploadLock, async () => {
      if (pendingCompletionRef.current.length) {
        await runResume();
        return;
      }
      const picked = await showOpenFileDialog({ multiple: true });
      await runUploads(Array.from(picked ?? []));
    });
  }, [runResume, runUploads]);

  useEffect(() => {
    if (autoResume.current || pendingCompletionRef.current.length === 0) return;
    autoResume.current = true;
    void resumePending();
  }, [resumePending]);

  // ---- table -------------------------------------------------------------
  const hasSelection = Object.keys(rowSelection).length > 0;
  const locationOf = useCallback(
    (file: StorageFile) => folderPath(folderOf(file)),
    [folderPath, folderOf],
  );
  const columns = useMemo(
    () =>
      getColumns({
        lang,
        busy,
        handlers,
        showCheckboxes: hasSelection,
        locationOf,
      }),
    [lang, busy, handlers, hasSelection, locationOf],
  );
  const table = useReactTable({
    data: tableData,
    columns,
    getRowId: (file) => file.id,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
    state: {
      sorting,
      columnFilters,
      rowSelection,
      columnVisibility: { kind: false, location: searching },
    },
  });
  const fileRows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const selectedFiles = useMemo(
    () => table.getFilteredSelectedRowModel().rows.map((row) => row.original),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, rowSelection, tableData],
  );
  const selectedFilesRef = useRef(selectedFiles);
  useEffect(() => {
    selectedFilesRef.current = selectedFiles;
  }, [selectedFiles]);
  const selectedIds = useMemo(
    () => new Set(selectedFiles.map((file) => file.id)),
    [selectedFiles],
  );
  const clearSelection = useCallback(() => setRowSelection({}), []);

  // ---- selection by pointer and keyboard ---------------------------------
  // The last row clicked without shift; shift-click selects from here.
  const anchorRef = useRef<string | null>(null);
  const selectByPointer = (event: MouseEvent, row: Row<StorageFile>) => {
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && anchorRef.current !== null) {
      const start = fileRows.findIndex((r) => r.id === anchorRef.current);
      const end = fileRows.findIndex((r) => r.id === row.id);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        const next: RowSelectionState = additive ? { ...rowSelection } : {};
        for (let index = from; index <= to; index++) next[fileRows[index].id] = true;
        setRowSelection(next);
        return;
      }
    }
    if (additive) row.toggleSelected();
    else setRowSelection({ [row.id]: true });
    anchorRef.current = row.id;
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.closest("[role='dialog'], [role='alertdialog'], [role='menu']"))
      ) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        table.toggleAllRowsSelected(true);
        return;
      }
      if (event.key === "Escape") {
        setRowSelection({});
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedFilesRef.current.length > 0
      ) {
        event.preventDefault();
        requestDelete(selectedFilesRef.current);
        return;
      }
      if (event.key === "Enter" && selectedFilesRef.current.length === 1) {
        openFile(selectedFilesRef.current[0]);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [table, requestDelete]);

  // ---- moving by drag and drop -------------------------------------------
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dropKey = (folderId: string | null) => folderId ?? "root";
  const dropInto = async (payload: DragPayload, targetId: string | null) => {
    const fileIds = payload.files.filter((id) => {
      const file = data.find((candidate) => candidate.id === id);
      return file !== undefined && folderOf(file) !== targetId;
    });
    const folderIds = payload.folders.filter((id) => {
      const folder = foldersById.get(id);
      if (!folder || id === targetId || parentOf(folder) === targetId) return false;
      return targetId === null || !subtreeIds(id).has(targetId);
    });
    if (!fileIds.length && !folderIds.length) return;
    let ok = true;
    if (fileIds.length) ok = (await mutate(() => moveFiles(fileIds, targetId))) && ok;
    for (const id of folderIds) {
      ok = (await mutate(() => moveFolder(id, targetId))) && ok;
    }
    if (ok) {
      toast({
        title: t("storage:movedTo", { name: folderName(targetId), ...RAW }),
      });
      setRowSelection({});
    }
  };
  const dropTargetProps = (targetId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!hasInternalDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTargetId(dropKey(targetId));
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasInternalDrag(event)) return;
      event.stopPropagation();
      setDropTargetId((current) =>
        current === dropKey(targetId) ? null : current,
      );
    },
    onDrop: (event: DragEvent) => {
      if (!hasInternalDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTargetId(null);
      const payload = readDrag(event);
      if (payload) void dropInto(payload, targetId);
    },
    "data-drop-active": dropTargetId === dropKey(targetId) ? "true" : undefined,
  });

  const fileItemProps = (row: Row<StorageFile>): ItemProps => ({
    tabIndex: 0,
    "aria-selected": row.getIsSelected(),
    draggable: true,
    onClick: (event) => {
      if (isInteractiveTarget(event.target)) return;
      selectByPointer(event, row);
    },
    onDoubleClick: (event) => {
      if (isInteractiveTarget(event.target)) return;
      openFile(row.original);
    },
    onContextMenu: () => {
      if (!row.getIsSelected()) {
        setRowSelection({ [row.id]: true });
        anchorRef.current = row.id;
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") {
        event.preventDefault();
        openFile(row.original);
      } else if (event.key === " ") {
        event.preventDefault();
        row.toggleSelected();
      }
    },
    onDragStart: (event) => {
      const ids = row.getIsSelected()
        ? selectedFiles.map((file) => file.id)
        : [row.original.id];
      event.dataTransfer.setData(
        DRAG_TYPE,
        JSON.stringify({ files: ids, folders: [] } satisfies DragPayload),
      );
      event.dataTransfer.effectAllowed = "move";
    },
  });
  const folderItemProps = (folder: StorageFolder): ItemProps => ({
    draggable: true,
    onClick: (event) => {
      if (isInteractiveTarget(event.target)) return;
      navigateToFolder(folder.id);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") {
        event.preventDefault();
        navigateToFolder(folder.id);
      }
    },
    onDragStart: (event) => {
      event.dataTransfer.setData(
        DRAG_TYPE,
        JSON.stringify({ files: [], folders: [folder.id] } satisfies DragPayload),
      );
      event.dataTransfer.effectAllowed = "move";
    },
    ...dropTargetProps(folder.id),
  });
  // Right-click on a selected file acts on the whole selection.
  const contextFiles = (file: StorageFile): StorageFile[] =>
    selectedIds.has(file.id) ? selectedFiles : [file];

  // ---- uploading by drag and drop ----------------------------------------
  // dragenter/dragleave fire for every child crossed, so a depth counter is
  // what tells "left the drop zone" from "moved over a cell".
  const [dragDepth, setDragDepth] = useState(0);
  const acceptsDrop = !busy && !completionPending;
  const onOsDragEnter = (event: DragEvent) => {
    if (!hasOsFiles(event)) return;
    event.preventDefault();
    setDragDepth((depth) => depth + 1);
  };
  const onOsDragOver = (event: DragEvent) => {
    if (!hasOsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = acceptsDrop ? "copy" : "none";
  };
  const onOsDragLeave = (event: DragEvent) => {
    if (!hasOsFiles(event)) return;
    event.preventDefault();
    setDragDepth((depth) => Math.max(0, depth - 1));
  };
  const onOsDrop = (event: DragEvent) => {
    if (!hasOsFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);
    if (!acceptsDrop) return;
    const files = Array.from(event.dataTransfer.files);
    void withStorageUploadLock(uploadLock, () => runUploads(files));
  };
  const dragging = dragDepth > 0 && acceptsDrop;

  // ---- dialogs -----------------------------------------------------------
  const confirmDeletion = () => {
    const target = confirmDelete;
    if (!target) return;
    setDeleting(true);
    void mutate(
      () => deleteFile(target.files.map((file) => file.id)),
      t("storage:deleted", { count: target.files.length }),
    )
      .then((ok) => {
        if (ok) setRowSelection({});
      })
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  };
  const confirmFolderDeletion = () => {
    const folder = confirmDeleteFolder;
    if (!folder) return;
    const subtree = subtreeIds(folder.id);
    setDeleting(true);
    void mutate(() => deleteFolder(folder.id), t("storage:folderDeleted"))
      .then((ok) => {
        // Standing inside the deleted tree: step out to its parent.
        if (ok && currentFolderId !== null && subtree.has(currentFolderId)) {
          navigateToFolder(parentOf(folder));
        }
      })
      .finally(() => {
        setDeleting(false);
        setConfirmDeleteFolder(null);
      });
  };
  const subtreeCounts = (folder: StorageFolder) => {
    const ids = subtreeIds(folder.id);
    let files = 0;
    for (const file of data) {
      if (file.folderId !== null && ids.has(file.folderId)) files += 1;
    }
    return { folders: ids.size - 1, files };
  };

  // ---- rendering ---------------------------------------------------------
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = table.getPageCount();
  const rangeFrom = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const rangeTo = Math.min(filteredCount, (pageIndex + 1) * pageSize);
  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const rootEmpty = data.length === 0 && folders.length === 0;
  const nothingHere = visibleFolders.length === 0 && filteredCount === 0;
  const gridClass = cn(
    "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4",
    detailsOpen && isLarge ? "xl:grid-cols-4" : "xl:grid-cols-5",
  );
  const kindOptions = [
    { value: "all", label: t("storage:filterAll") },
    ...FILE_KINDS.map((kind) => ({ value: kind, label: t(`storage:kinds.${kind}`) })),
  ];
  const visibilityOptions = [
    { value: "all", label: t("storage:filterAll") },
    { value: "PUBLIC", label: t("storage:public") },
    { value: "PRIVATE", label: t("storage:private") },
    { value: "DEDICATED", label: t("storage:dedicated") },
  ];
  const clearFilters = () => setColumnFilters([]);

  const uploadButton = (
    <Button type="button" onClick={() => void handleUploadClick()} disabled={busy}>
      <Upload className="h-4 w-4" aria-hidden />
      {t("storage:upload")}
    </Button>
  );

  const folderSection = visibleFolders.length > 0 && (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("storage:folders")}
      </h3>
      <div className={gridClass}>
        {visibleFolders.map((folder) => (
          <FolderContextMenu
            key={folder.id}
            folder={folder}
            lang={lang}
            handlers={folderHandlers}
          >
            <FolderCard
              folder={folder}
              lang={lang}
              busy={busy}
              handlers={folderHandlers}
              location={searching ? folderPath(parentOf(folder)) : null}
              {...folderItemProps(folder)}
            />
          </FolderContextMenu>
        ))}
      </div>
    </section>
  );

  let content;
  if (rootEmpty) {
    content = (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <CloudUpload className="h-10 w-10 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {dragging ? t("storage:dropToUpload") : t("storage:noFiles")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("storage:dragAndDropHint")}
          </p>
        </div>
        {uploadButton}
      </div>
    );
  } else if (nothingHere && !searching && !filtersActive) {
    content = (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-16 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <Folder className="h-10 w-10 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {dragging ? t("storage:dropToUpload") : t("storage:emptyFolder")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("storage:emptyFolderHint")}
          </p>
        </div>
        {uploadButton}
      </div>
    );
  } else if (nothingHere) {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border px-6 py-16 text-center text-muted-foreground">
        <span>
          {searching
            ? t("storage:noMatchingFiles", { query: query.trim(), ...RAW })
            : t("storage:noFilesForFilter")}
        </span>
        <Button type="button" variant="link" size="sm" onClick={clearFilters}>
          {searching ? t("storage:clearSearch") : t("storage:clearFilters")}
        </Button>
      </div>
    );
  } else if (view === "grid") {
    content = (
      <div
        className={cn(
          "flex flex-col gap-5 rounded-lg transition-shadow",
          dragging && "ring-2 ring-primary/60 ring-offset-4 ring-offset-background",
        )}
      >
        {folderSection}
        <section className="flex flex-col gap-2">
          {visibleFolders.length > 0 && (
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("storage:files")}
            </h3>
          )}
          {fileRows.length > 0 ? (
            <div
              role="listbox"
              aria-multiselectable
              aria-label={t("storage:files")}
              className={gridClass}
              onClick={(event) => {
                if (event.target === event.currentTarget) clearSelection();
              }}
            >
              {fileRows.map((row) => (
                <FileContextMenu
                  key={row.id}
                  files={contextFiles(row.original)}
                  lang={lang}
                  handlers={handlers}
                >
                  <FileCard
                    row={row}
                    lang={lang}
                    busy={busy}
                    handlers={handlers}
                    showCheckbox={hasSelection}
                    location={searching ? locationOf(row.original) : null}
                    {...fileItemProps(row)}
                  />
                </FileContextMenu>
              ))}
            </div>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              {t("storage:noFilesForFilter")}
            </p>
          )}
        </section>
      </div>
    );
  } else {
    content = (
      <div
        className={cn(
          "relative rounded-md border transition-colors",
          dragging && "border-primary",
        )}
      >
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="group">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(HEAD_CLASS, COLUMN_CLASS[header.column.id])}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
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
            {visibleFolders.map((folder) => (
              <FolderContextMenu
                key={folder.id}
                folder={folder}
                lang={lang}
                handlers={folderHandlers}
              >
                <TableRow
                  tabIndex={0}
                  className="group cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[drop-active=true]:bg-primary/10"
                  {...folderItemProps(folder)}
                >
                  <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.select)} />
                  <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.name)}>
                    <div className="flex min-w-0 items-center gap-2 font-medium">
                      <Folder
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="truncate" title={folder.name}>
                        {folder.name}
                      </span>
                    </div>
                  </TableCell>
                  {searching && (
                    <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.location)}>
                      <span className="block truncate text-muted-foreground">
                        {folderPath(parentOf(folder))}
                      </span>
                    </TableCell>
                  )}
                  <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.size, "text-muted-foreground")}>
                    —
                  </TableCell>
                  <TableCell
                    className={cn(CELL_CLASS, COLUMN_CLASS.visibility, "text-muted-foreground")}
                  >
                    —
                  </TableCell>
                  <TableCell
                    className={cn(CELL_CLASS, COLUMN_CLASS.createdAt, "tabular-nums text-muted-foreground")}
                  >
                    {formatDateTime(folder.createdAt, lang)}
                  </TableCell>
                  <TableCell className={cn(CELL_CLASS, COLUMN_CLASS.actions)}>
                    <FolderActionsButton
                      folder={folder}
                      lang={lang}
                      busy={busy}
                      handlers={folderHandlers}
                    />
                  </TableCell>
                </TableRow>
              </FolderContextMenu>
            ))}
            {fileRows.map((row) => (
              <FileContextMenu
                key={row.id}
                files={contextFiles(row.original)}
                lang={lang}
                handlers={handlers}
              >
                <TableRow
                  className="group cursor-default select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-primary/10"
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  {...fileItemProps(row)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(CELL_CLASS, COLUMN_CLASS[cell.column.id])}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              </FileContextMenu>
            ))}
            {fileRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={visibleColumnCount}
                  className="h-12 text-center text-sm text-muted-foreground"
                >
                  {t("storage:noFilesForFilter")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/80 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-md border border-primary bg-background px-4 py-2 text-sm font-medium shadow-sm">
              <CloudUpload className="h-5 w-5 text-primary" aria-hidden />
              {t("storage:dropToUpload")}
            </div>
          </div>
        )}
      </div>
    );
  }

  const breadcrumbs = (
    <nav
      aria-label={t("storage:location")}
      className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm"
    >
      {[null, ...folderChain.map((folder) => folder.id)].map((id, index, ids) => {
        const last = index === ids.length - 1;
        const label = folderName(id);
        return (
          <Fragment key={id ?? "root"}>
            {index > 0 && (
              <ChevronRight
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            )}
            {last ? (
              <h2
                className="flex min-w-0 items-center gap-1.5 px-1.5 text-base font-semibold"
                aria-current="location"
              >
                {id === null && (
                  <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{label}</span>
              </h2>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 max-w-[14rem] gap-1.5 px-1.5 text-muted-foreground data-[drop-active=true]:bg-primary/10 data-[drop-active=true]:text-foreground"
                onClick={() => navigateToFolder(id)}
                {...dropTargetProps(id)}
              >
                {id === null && <HardDrive className="h-4 w-4 shrink-0" aria-hidden />}
                <span className="truncate">{label}</span>
              </Button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );

  return (
    <TooltipProvider>
      <div
        className="flex flex-col gap-4"
        onDragEnter={onOsDragEnter}
        onDragOver={onOsDragOver}
        onDragLeave={onOsDragLeave}
        onDrop={onOsDrop}
      >
        {completionPending && (
          <Alert>
            <RefreshCw className="h-4 w-4" aria-hidden />
            <AlertTitle>{t("storage:pendingCompletionTitle")}</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{t("storage:pendingCompletionDescription")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void resumePending()}
                disabled={busy}
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                {t("storage:resumeUpload")}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                disabled={busy}
                data-pending-completion={completionPending || undefined}
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden />
                )}
                {t("storage:new")}
                <ChevronDown className="h-4 w-4 opacity-70" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={() => void handleUploadClick()}>
                <Upload className="mr-2 h-4 w-4" aria-hidden />
                {t("storage:uploadFiles")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setNewFolderOpen(true)}>
                <FolderPlus className="mr-2 h-4 w-4" aria-hidden />
                {t("storage:newFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="relative min-w-[12rem] flex-1 sm:max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              placeholder={t("storage:searchPlaceholder")}
              aria-label={t("storage:searchPlaceholder")}
              value={query}
              onChange={(event) => setFilter("name", event.target.value || undefined)}
              className="pl-9 pr-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setFilter("name", undefined)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
                aria-label={t("storage:clearSearch")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={view}
              onValueChange={(value) => {
                if (value === "grid" || value === "list") {
                  setView(value);
                  storeView(value);
                }
              }}
              aria-label={t("storage:viewMode")}
            >
              <ToggleGroupItem value="grid" aria-label={t("storage:viewGrid")}>
                <LayoutGrid className="h-4 w-4" aria-hidden />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label={t("storage:viewList")}>
                <ListIcon className="h-4 w-4" aria-hidden />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              type="button"
              variant={detailsOpen ? "secondary" : "ghost"}
              size="icon"
              className="hidden h-9 w-9 lg:inline-flex"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-pressed={detailsOpen}
              aria-label={detailsOpen ? t("storage:hideDetails") : t("storage:showDetails")}
            >
              <Info className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>

        {breadcrumbs}

        {selectedFiles.length > 0 ? (
          <SelectionBar
            files={selectedFiles}
            lang={lang}
            busy={busy}
            handlers={handlers}
            onClear={clearSelection}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip
              label={t("storage:filterKind")}
              value={kindFilter}
              options={kindOptions}
              onChange={(value) => setFilter("kind", value === "all" ? undefined : value)}
            />
            <FilterChip
              label={t("storage:filterVisibility")}
              value={visibilityFilter}
              options={visibilityOptions}
              onChange={(value) =>
                setFilter("visibility", value === "all" ? undefined : value)
              }
            />
            {view === "grid" && (
              <SortChip
                lang={lang}
                sorting={sorting[0]}
                onChange={(field, desc) => setSorting([{ id: field, desc }])}
              />
            )}
          </div>
        )}

        {uploadStatus && (
          <div
            className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
            aria-live="polite"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate">
                {uploadStatus.total > 1
                  ? t("storage:uploadingFileOf", {
                      name: uploadStatus.name,
                      index: uploadStatus.index,
                      total: uploadStatus.total,
                      ...RAW,
                    })
                  : t("storage:uploadingFile", { name: uploadStatus.name, ...RAW })}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {Math.round(uploadStatus.progress * 100)}%
              </span>
            </div>
            <Progress
              value={Math.round(uploadStatus.progress * 100)}
              max={100}
              className="h-1.5"
            />
          </div>
        )}

        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {searching && (
              <p className="text-sm text-muted-foreground">
                {t("storage:searchEverywhere")}
              </p>
            )}
            {content}
            {!rootEmpty && filteredCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  {t("storage:showingRange", {
                    from: rangeFrom,
                    to: rangeTo,
                    total: filteredCount,
                  })}
                </span>
                {pageCount > 1 && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => table.previousPage()}
                      disabled={!table.getCanPreviousPage()}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                      {t("storage:previousPage")}
                    </Button>
                    <span className="tabular-nums">
                      {t("storage:pageOf", { page: pageIndex + 1, pages: pageCount })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => table.nextPage()}
                      disabled={!table.getCanNextPage()}
                    >
                      {t("storage:nextPage")}
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          {detailsOpen && isLarge && (
            <DetailsPanel
              files={selectedFiles}
              lang={lang}
              busy={busy}
              handlers={handlers}
              locationOf={locationOf}
              onClose={() => setDetailsOpen(false)}
            />
          )}
        </div>

        <AlertDialog
          open={confirmDelete !== null}
          onOpenChange={(open) => {
            if (!open && !deleting) setConfirmDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("storage:deleteTitle", { count: confirmDelete?.files.length ?? 1 })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDelete?.files.length === 1
                  ? t("storage:deleteConfirmation", {
                      name: confirmDelete.files[0].name,
                      ...RAW,
                    })
                  : t("storage:deleteConfirmationMany", {
                      count: confirmDelete?.files.length ?? 0,
                    })}
                {confirmDelete && confirmDelete.skipped > 0 && (
                  <>
                    {" "}
                    {t("storage:deleteSkipsDedicated", { count: confirmDelete.skipped })}
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={(event) => {
                  // Keep the dialog open until the server has answered, so a
                  // failure is shown in context rather than after it closed.
                  event.preventDefault();
                  confirmDeletion();
                }}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden />
                )}
                {t("delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={confirmDeleteFolder !== null}
          onOpenChange={(open) => {
            if (!open && !deleting) setConfirmDeleteFolder(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("storage:deleteFolderTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDeleteFolder &&
                  t("storage:deleteFolderConfirmation", {
                    name: confirmDeleteFolder.name,
                    ...subtreeCounts(confirmDeleteFolder),
                    ...RAW,
                  })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={(event) => {
                  event.preventDefault();
                  confirmFolderDeletion();
                }}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden />
                )}
                {t("delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <NameDialog
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          lang={lang}
          title={t("storage:renameTitle")}
          description={
            renameTarget?.kind === "file"
              ? t("storage:renameDescription")
              : t("storage:newFolderDescription")
          }
          label={renameTarget?.kind === "folder" ? t("storage:folderName") : t("storage:newName")}
          initialName={
            renameTarget?.kind === "file"
              ? renameTarget.file.name
              : (renameTarget?.folder.name ?? "")
          }
          submitLabel={t("save")}
          selectStem={renameTarget?.kind === "file"}
          invalidMessage={
            renameTarget?.kind === "folder"
              ? t("storage:invalidFolderName")
              : t("storage:invalidFileName")
          }
          onSubmit={(name) => {
            if (!renameTarget) return Promise.resolve(false);
            return renameTarget.kind === "file"
              ? mutate(() => renameFile(renameTarget.file.id, name), t("storage:renamed"))
              : mutate(() => renameFolder(renameTarget.folder.id, name), t("storage:renamed"));
          }}
        />

        <NameDialog
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          lang={lang}
          title={t("storage:newFolder")}
          description={t("storage:newFolderDescription")}
          label={t("storage:folderName")}
          initialName={t("storage:untitledFolder")}
          submitLabel={t("storage:create")}
          allowUnchanged
          invalidMessage={t("storage:invalidFolderName")}
          onSubmit={(name) =>
            mutate(() => createFolder(name, currentFolderId), t("storage:folderCreated"))
          }
        />

        <MoveDialog
          open={moveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          lang={lang}
          folders={folders}
          currentFolderId={
            moveTarget?.kind === "folder" ? parentOf(moveTarget.folder) : currentFolderId
          }
          disabledFolderIds={
            moveTarget?.kind === "folder" ? subtreeIds(moveTarget.folder.id) : new Set()
          }
          title={t("storage:moveTitle")}
          onMove={async (targetId) => {
            if (!moveTarget) return false;
            const ok =
              moveTarget.kind === "files"
                ? await mutate(
                    () => moveFiles(moveTarget.files.map((file) => file.id), targetId),
                    t("storage:movedTo", { name: folderName(targetId), ...RAW }),
                  )
                : await mutate(
                    () => moveFolder(moveTarget.folder.id, targetId),
                    t("storage:movedTo", { name: folderName(targetId), ...RAW }),
                  );
            if (ok) setRowSelection({});
            return ok;
          }}
        />
      </div>
    </TooltipProvider>
  );
}
