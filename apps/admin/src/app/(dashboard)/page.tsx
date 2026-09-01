import { getOverview, defaultDateRange } from "@/lib/api";

// Format ISO string to "YYYY-MM-DDTHH:MM" for datetime-local input (UTC)
function toDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromParam, to: toParam } = await searchParams;
  const defaults = defaultDateRange();
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;

  const stats = await getOverview(from, to);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Overview</h1>
        <DateRangeForm from={from} to={to} />
      </div>

      {/* Funnel bars */}
      {stats.received > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-sm text-gray-700">Proposal funnel</h2>
          <FunnelBars stats={stats} />
        </div>
      )}

      {/* Numeric stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Received" value={stats.received} />
        <StatCard label="Sent to auction" value={stats.sentToAuction} />
        <StatCard label="Discarded" value={stats.discarded} sub={`${stats.simFailed} sim failed`} />
        <StatCard label="Won" value={stats.won} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Settled" value={stats.settled} />
        <StatCard label="Reverted" value={stats.settleFailed} />
        <StatCard
          label="Penalized"
          value={stats.penalizedCount}
          sub={stats.penalizedAmountFormatted}
        />
        <StatCard label="Non-settlement debited" value={stats.nonSettlementDebitedCount} />
      </div>

      {/* Rejection breakdown */}
      {stats.rejectionBreakdown.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-4">Rejection breakdown</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="pb-2 font-medium">Reason</th>
                <th className="pb-2 font-medium text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {stats.rejectionBreakdown.map((row: { reason: string; count: number }) => (
                <tr key={row.reason} className="border-b border-gray-50">
                  <td className="py-2 font-mono text-xs">{row.reason}</td>
                  <td className="py-2 text-right">{row.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Funnel visualisation ---

interface FunnelStats {
  received: number;
  sentToAuction: number;
  discarded: number;
  won: number;
  lost: number;
  settled: number;
  settleFailed: number;
}

function FunnelBars({ stats }: { stats: FunnelStats }) {
  const { received, sentToAuction, discarded, won, lost, settled, settleFailed } = stats;
  const bar2Pct = received > 0 ? (sentToAuction / received) * 100 : 0;
  const bar3Pct = received > 0 ? (won / received) * 100 : 0;

  return (
    <div className="space-y-3">
      {received > 0 && (
        <FunnelBar
          label="Received"
          widthPct={100}
          total={received}
          segments={[
            { label: "Sent to auction", count: sentToAuction, color: "bg-blue-500" },
            { label: "Discarded", count: discarded, color: "bg-red-300" },
          ]}
        />
      )}
      {sentToAuction > 0 && (
        <FunnelBar
          label="Sent to auction"
          widthPct={bar2Pct}
          total={sentToAuction}
          segments={[
            { label: "Won", count: won, color: "bg-green-500" },
            { label: "Lost", count: lost, color: "bg-gray-300" },
          ]}
        />
      )}
      {won > 0 && (
        <FunnelBar
          label="Won"
          widthPct={bar3Pct}
          total={won}
          segments={[
            { label: "Settled", count: settled, color: "bg-green-600" },
            { label: "Reverted", count: settleFailed, color: "bg-orange-400" },
          ]}
        />
      )}
    </div>
  );
}

function FunnelBar({
  label,
  widthPct,
  total,
  segments,
}: {
  label: string;
  widthPct: number;
  total: number;
  segments: { label: string; count: number; color: string }[];
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-gray-400 w-28 shrink-0 text-right pt-1.5">{label}</span>
      <div className="flex-1 min-w-0">
        <div style={{ width: `${widthPct}%` }} className="flex h-6 rounded overflow-hidden">
          {segments.map((seg) => {
            const pct = total > 0 ? (seg.count / total) * 100 : 0;
            if (pct === 0) return null;
            return (
              <div
                key={seg.label}
                style={{ width: `${pct}%` }}
                className={`${seg.color}`}
                title={`${seg.label}: ${seg.count.toLocaleString()} (${Math.round(pct)}%)`}
              />
            );
          })}
        </div>
        <div className="flex gap-4 mt-1">
          {segments.map((seg) => {
            const pct = total > 0 ? Math.round((seg.count / total) * 100) : 0;
            return (
              <span key={seg.label} className="flex items-center gap-1 text-xs text-gray-500">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${seg.color}`} />
                {seg.label}: {seg.count.toLocaleString()} ({pct}%)
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- Date range form ---

function DateRangeForm({ from, to }: { from: string; to: string }) {
  return (
    <form method="GET" className="flex items-end gap-2">
      <div>
        <label className="block text-xs text-gray-400 mb-1">From (UTC)</label>
        <input
          type="datetime-local"
          name="from"
          defaultValue={toDatetimeLocal(from)}
          className="border border-gray-200 rounded px-2 py-1 text-xs"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">To (UTC)</label>
        <input
          type="datetime-local"
          name="to"
          defaultValue={toDatetimeLocal(to)}
          className="border border-gray-200 rounded px-2 py-1 text-xs"
        />
      </div>
      <button
        type="submit"
        className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded"
      >
        Apply
      </button>
      <a href="/" className="text-xs text-gray-400 hover:text-gray-700 underline pb-1.5">
        Reset
      </a>
    </form>
  );
}

// --- Stat cards ---

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
