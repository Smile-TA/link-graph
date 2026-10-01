import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

export interface SiteTableRow {
  readonly siteId: string;
  readonly canonicalHost: string;
  readonly href: string;
  readonly lastCrawl: string;
  readonly crawlCount: number;
  readonly nextCrawl: string;
  readonly status: "enabled" | "disabled" | "alias";
  readonly broken: number;
  readonly orphans: number | null;
}

type StatusFilter = "all" | SiteTableRow["status"];

const columns: ColumnDef<SiteTableRow>[] = [
  {
    accessorKey: "siteId",
    header: "site",
    cell: ({ row }) => <a href={row.original.href}>{row.original.siteId}</a>,
  },
  { accessorKey: "canonicalHost", header: "host" },
  { accessorKey: "lastCrawl", header: "last crawl" },
  { accessorKey: "crawlCount", header: "crawls" },
  { accessorKey: "nextCrawl", header: "next crawl" },
  { accessorKey: "status", header: "status" },
  { accessorKey: "broken", header: "broken links" },
  {
    accessorKey: "orphans",
    header: "orphans",
    cell: ({ getValue }) => getValue<number | null>() ?? "unknown",
  },
];

/**
 * Client-side table over all ~164 sites (docs/notes.md items 13, 17) — small enough
 * to fetch once per page load and let tanstack-table filter/sort in the browser,
 * rather than a server-side search endpoint.
 */
export function SitesTable({ rows }: { readonly rows: SiteTableRow[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [onlyBroken, setOnlyBroken] = useState(false);
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && row.status !== status) return false;
      if (onlyBroken && row.broken === 0) return false;
      if (onlyOrphans && !(row.orphans !== null && row.orphans > 0)) return false;
      if (needle === "") return true;
      return (
        row.siteId.toLowerCase().includes(needle) ||
        row.canonicalHost.toLowerCase().includes(needle)
      );
    });
  }, [rows, search, status, onlyBroken, onlyOrphans]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div>
      <p>
        <input
          type="search"
          placeholder="search site or host…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />{" "}
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="all">all statuses</option>
          <option value="enabled">enabled</option>
          <option value="disabled">disabled</option>
          <option value="alias">alias</option>
        </select>{" "}
        <label>
          <input
            type="checkbox"
            checked={onlyBroken}
            onChange={(e) => setOnlyBroken(e.target.checked)}
          />{" "}
          has broken links
        </label>{" "}
        <label>
          <input
            type="checkbox"
            checked={onlyOrphans}
            onChange={(e) => setOnlyOrphans(e.target.checked)}
          />{" "}
          has orphans
        </label>
      </p>
      <p>{filteredRows.length} of {rows.length} sites</p>
      <table>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  style={{ cursor: "pointer", userSelect: "none" }}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
