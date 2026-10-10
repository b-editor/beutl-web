import {
  columnFilteringFeature,
  columnVisibilityFeature,
  filterFn_equals,
  filterFn_includesString,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  type Column,
  type ColumnDef,
  type Row,
  type Table,
} from "@tanstack/react-table";
import type { StorageFile } from "./types";

// The server owns filtering, sorting, and pagination. Register their state
// APIs without adding client row-model stages that would process the page again.
export const storageTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filterFns: { equals: filterFn_equals, includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

export type StorageColumn = Column<typeof storageTableFeatures, StorageFile>;
export type StorageColumnDef = ColumnDef<typeof storageTableFeatures, StorageFile>;
export type StorageRow = Row<typeof storageTableFeatures, StorageFile>;
export type StorageTable = Table<typeof storageTableFeatures, StorageFile>;
