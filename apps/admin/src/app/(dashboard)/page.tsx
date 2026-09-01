import { getOverview, defaultDateRange } from "@/lib/api";
import { DateRangeForm } from "./date-range-form";

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[13px] font-semibold text-ink">Overview</h1>
        <DateRangeForm from={from} to={to} resetHref="/" />
      </div>

      {/* Funnel */}
      {stats.received > 0 && (
        <div className="bg-surface border border-line rounded p-5 space-y-4">
          <div className="text-[10px] uppercase tracking-widest text-dim font-medium">Proposal funnel</div>
          <FunnelBars stats={stats} />
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Received" value={stats.received} />
        <StatCard label="Sent to auction" value={stats.sentToAuction} />
        <StatCard label="Discarded" value={stats.discarded} sub={`${stats.simFailed} sim failed`} />
        <StatCard label="Won" value={stats.won} />
      </div>
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Settled" value={stats.settled} />
        <StatCard label="Reverted" value={stats.settleFailed} />
        <StatCard label="Penalized" value={stats.penalizedCount} sub={stats.penalizedAmountFormatted} />
        <StatCard label="Non-settlement debited" value={stats.nonSettlementDebitedCount} />
      </div>

      {/* Rejection breakdown */}
      {stats.rejectionBreakdown.length > 0 && (
        <div className="bg-surface border border-line rounded">
          <div className="px-5 py-3 border-b border-line">
            <span className="text-[10px] uppercase tracking-widest text-dim font-medium">Rejection breakdown</span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="bg-base border-b border-line">
                <th className="px-5 py-2.5 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Reason</th>
                <th className="px-5 py-2.5 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              {stats.rejectionBreakdown.map((row: { reason: string; count: number }) => (
                <tr key={row.reason} className="border-b border-line last:border-0 hover:bg-base transition-colors duration-100">
                  <td className="px-5 py-2.5 font-mono text-[12px] text-muted">{row.reason}</td>
                  <td className="px-5 py-2.5 font-mono text-[12px] text-ink text-right">{row.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Funnel ---

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
    <div className="space-y-4">
      {received > 0 && (
        <FunnelBar label="Received" widthPct={100} total={received} segments={[
          { label: "Sent to auction", count: sentToAuction, color: "bg-accent" },
          { label: "Discarded", count: discarded, color: "bg-warn" },
        ]} />
      )}
      {sentToAuction > 0 && (
        <FunnelBar label="Sent to auction" widthPct={bar2Pct} total={sentToAuction} segments={[
          { label: "Won", count: won, color: "bg-accent" },
          { label: "Lost", count: lost, color: "bg-muted" },
        ]} />
      )}
      {won > 0 && (
        <FunnelBar label="Won" widthPct={bar3Pct} total={won} segments={[
          { label: "Settled", count: settled, color: "bg-accent" },
          { label: "Reverted", count: settleFailed, color: "bg-warn" },
        ]} />
      )}
    </div>
  );
}

function FunnelBar({
  label, widthPct, total, segments,
}: {
  label: string;
  widthPct: number;
  total: number;
  segments: { label: string; count: number; color: string }[];
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="text-[10px] uppercase tracking-widest text-dim font-medium w-28 shrink-0 text-right pt-1">{label}</span>
      <div className="flex-1 min-w-0">
        <div style={{ width: `${widthPct}%` }} className="flex h-1.5 rounded-full overflow-hidden bg-line">
          {segments.map((seg) => {
            const pct = total > 0 ? (seg.count / total) * 100 : 0;
            if (pct === 0) return null;
            return (
              <div
                key={seg.label}
                style={{ width: `${pct}%` }}
                className={seg.color}
                title={`${seg.label}: ${seg.count.toLocaleString()} (${Math.round(pct)}%)`}
              />
            );
          })}
        </div>
        <div className="flex gap-4 mt-1.5">
          {segments.map((seg) => {
            const pct = total > 0 ? Math.round((seg.count / total) * 100) : 0;
            return (
              <span key={seg.label} className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${seg.color}`} />
                {seg.label}: <span className="font-mono text-ink">{seg.count.toLocaleString()}</span>
                <span className="text-dim">({pct}%)</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- Stat cards ---

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-surface border border-line rounded p-4">
      <div className="text-[10px] uppercase tracking-widest text-dim font-medium mb-2">{label}</div>
      <div className="font-mono text-2xl font-semibold text-ink">{value.toLocaleString()}</div>
      {sub && <div className="font-mono text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
