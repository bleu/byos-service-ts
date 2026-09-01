import Link from "next/link";
import { db } from "@/lib/db";
import { blockExplorerAddressUrl, cowExplorerOrderUrl, tenderlyTxUrl } from "@/lib/formatters";
import { listProposals } from "@/lib/queries";

const STATUSES = ["submitted", "active", "rejected", "simFailed", "executing", "settled", "settleFailed", "penalized", "cancelled", "expired"];

function isoZ(date: Date | string) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{ subSolver?: string; status?: string; page?: string }>;
}) {
  const { subSolver, status, page: pageStr } = await searchParams;
  const page = Math.max(1, Number(pageStr ?? "1"));

  const { items: rawItems, total } = await listProposals(db, { subSolver, status, page, limit: 50 });
  const items = rawItems.map((p) => ({
    ...p,
    subSolverUrl: blockExplorerAddressUrl(p.subSolver),
    orderUidUrl: cowExplorerOrderUrl(p.orderUid),
    tenderlyUrl: p.settlementTxHash ? tenderlyTxUrl(p.settlementTxHash) : null,
  }));
  const totalPages = Math.ceil(total / 50);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-[13px] font-semibold text-ink">
          Proposals
          <span className="font-mono font-normal text-dim ml-2">{total.toLocaleString()}</span>
        </h1>

        {/* Filters */}
        <form method="GET" className="flex gap-2 items-end">
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-dim font-medium mb-1">Subsolver</label>
            <input
              name="subSolver"
              defaultValue={subSolver ?? ""}
              placeholder="0x…"
              className="border border-line rounded bg-surface font-mono text-[12px] text-ink px-2 py-1.5 w-60 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent placeholder:text-dim"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-dim font-medium mb-1">Status</label>
            <select
              name="status"
              defaultValue={status ?? ""}
              className="border border-line rounded bg-surface text-[12px] text-ink px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="bg-accent text-white text-[12px] font-medium px-3 py-1.5 rounded hover:opacity-90">
            Filter
          </button>
          {(subSolver || status) && (
            <a href="/proposals" className="text-[12px] text-dim hover:text-muted underline pb-1.5">Clear</a>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="bg-surface border border-line rounded overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-base border-b border-line">
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">ID</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Subsolver</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Order UID</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Status</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Rejection reason</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-base transition-colors duration-100">
                <td className="px-4 py-3">
                  <Link href={`/proposals/${p.id}`} className="font-mono text-[12px] text-accent hover:underline">
                    #{p.id}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-muted">
                  {p.subSolverUrl
                    ? <a href={p.subSolverUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">{p.subSolver}</a>
                    : p.subSolver}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-muted">
                  {p.orderUidUrl
                    ? <a href={p.orderUidUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">{p.orderUid.slice(0, 10)}…</a>
                    : <>{p.orderUid.slice(0, 10)}…</>}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} tenderlyUrl={p.tenderlyUrl} />
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-muted">
                  {p.rejectionReason ?? <span className="text-dim">—</span>}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-muted">
                  {isoZ(p.createdAt)}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[12px] text-dim">
                  No proposals found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex gap-1.5 justify-center">
          {page > 1 && (
            <a href={buildPageUrl(subSolver, status, page - 1)} className="px-3 py-1.5 border border-line rounded text-[12px] text-muted hover:text-ink hover:bg-surface">
              ← Prev
            </a>
          )}
          <span className="px-3 py-1.5 font-mono text-[12px] text-dim">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a href={buildPageUrl(subSolver, status, page + 1)} className="px-3 py-1.5 border border-line rounded text-[12px] text-muted hover:text-ink hover:bg-surface">
              Next →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function buildPageUrl(subSolver?: string, status?: string, page?: number) {
  const qs = new URLSearchParams();
  if (subSolver) qs.set("subSolver", subSolver);
  if (status) qs.set("status", status);
  if (page) qs.set("page", String(page));
  return `/proposals?${qs}`;
}

const BADGE_STYLES: Record<string, string> = {
  settled:      "bg-ok-tint text-ok",
  active:       "bg-accent-tint text-accent",
  submitted:    "bg-base text-muted",
  executing:    "bg-warn-tint text-warn",
  rejected:     "bg-fail-tint text-fail",
  settleFailed: "bg-fail-tint text-fail",
  simFailed:    "bg-warn-tint text-warn",
  penalized:    "bg-fail-tint text-fail",
  expired:      "bg-base text-dim",
  cancelled:    "bg-base text-dim",
};

function StatusBadge({ status, tenderlyUrl }: { status: string; tenderlyUrl?: string | null }) {
  const cls = `inline-flex items-center px-1.5 py-0.5 rounded-sm font-mono text-[11px] tracking-wide ${BADGE_STYLES[status] ?? "bg-base text-muted"}`;
  if (tenderlyUrl) {
    return (
      <a href={tenderlyUrl} target="_blank" rel="noopener noreferrer" className={`${cls} hover:underline`}>
        {status}
      </a>
    );
  }
  return <span className={cls}>{status}</span>;
}
