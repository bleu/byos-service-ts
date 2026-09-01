import Link from "next/link";
import { getProposals } from "@/lib/api";

const STATUSES = ["submitted", "active", "rejected", "simFailed", "executing", "settled", "settleFailed", "penalized", "cancelled", "expired"];

function isoZ(dateStr: string) {
  return new Date(dateStr).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{ subSolver?: string; status?: string; page?: string }>;
}) {
  const { subSolver, status, page: pageStr } = await searchParams;
  const page = Math.max(1, Number(pageStr ?? "1"));

  const { items, total } = await getProposals({ subSolver, status, page, limit: 50 });
  const totalPages = Math.ceil(total / 50);

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Proposals</h1>
        <span className="text-sm text-gray-500">{total.toLocaleString()} total</span>
      </div>

      {/* Filters */}
      <form method="GET" className="flex gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Subsolver</label>
          <input
            name="subSolver"
            defaultValue={subSolver ?? ""}
            placeholder="0x..."
            className="border border-gray-200 rounded px-3 py-1.5 text-sm font-mono w-72"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Status</label>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="border border-gray-200 rounded px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded"
        >
          Filter
        </button>
        {(subSolver || status) && (
          <a href="/proposals" className="text-sm text-gray-500 hover:text-gray-900 underline">
            Clear
          </a>
        )}
      </form>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-500">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">Subsolver</th>
              <th className="px-4 py-3 font-medium">Order UID</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Rejection reason</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map(
              (p: {
                id: number;
                subSolver: string;
                subSolverUrl: string | null;
                orderUid: string;
                orderUidUrl: string | null;
                status: string;
                rejectionReason: string | null;
                tenderlyUrl: string | null;
                createdAt: string;
              }) => (
                <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/proposals/${p.id}`} className="text-blue-600 hover:underline font-mono text-xs">
                      #{p.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {p.subSolverUrl ? (
                      <a href={p.subSolverUrl} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">
                        {p.subSolver}
                      </a>
                    ) : (
                      p.subSolver
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {p.orderUidUrl ? (
                      <a href={p.orderUidUrl} target="_blank" rel="noopener noreferrer" className="hover:text-blue-600 hover:underline">
                        {p.orderUid.slice(0, 10)}…
                      </a>
                    ) : (
                      <>{p.orderUid.slice(0, 10)}…</>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} tenderlyUrl={p.tenderlyUrl} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {p.rejectionReason ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                    {isoZ(p.createdAt)}
                  </td>
                </tr>
              ),
            )}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No proposals found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex gap-2 justify-center text-sm">
          {page > 1 && (
            <a
              href={buildPageUrl(subSolver, status, page - 1)}
              className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50"
            >
              ← Prev
            </a>
          )}
          <span className="px-3 py-1 text-gray-500">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a
              href={buildPageUrl(subSolver, status, page + 1)}
              className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50"
            >
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

function StatusBadge({ status, tenderlyUrl }: { status: string; tenderlyUrl?: string | null }) {
  const colors: Record<string, string> = {
    settled: "bg-green-100 text-green-700",
    active: "bg-blue-100 text-blue-700",
    submitted: "bg-gray-100 text-gray-700",
    executing: "bg-yellow-100 text-yellow-700",
    rejected: "bg-red-100 text-red-700",
    settle_failed: "bg-red-200 text-red-800",
    penalized: "bg-red-300 text-red-900",
    expired: "bg-gray-200 text-gray-600",
    cancelled: "bg-gray-200 text-gray-600",
    simFailed: "bg-orange-100 text-orange-700",
  };
  const cls = `px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-600"}`;
  if (tenderlyUrl) {
    return (
      <a href={tenderlyUrl} target="_blank" rel="noopener noreferrer" className={`${cls} hover:underline`}>
        {status}
      </a>
    );
  }
  return <span className={cls}>{status}</span>;
}
