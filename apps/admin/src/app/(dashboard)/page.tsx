import { getOverview, type TimeRange } from "@/lib/api";

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
    </div>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rawRange } = await searchParams;
  const range = (rawRange === "7d" || rawRange === "30d" ? rawRange : "24h") as TimeRange;

  const stats = await getOverview(range);
  const settlementTotal = stats.settled + stats.settleFailed;
  const successRate = settlementTotal > 0 ? Math.round((stats.settled / settlementTotal) * 100) : 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Overview</h1>
        <RangeSelector current={range} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Proposals received" value={stats.proposalsReceived} />
        <StatCard label="Settled" value={stats.settled} />
        <StatCard label="Settle failed" value={stats.settleFailed} />
        <StatCard label="Success rate" value={successRate} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Penalized" value={stats.penalized} />
        <StatCard label="Non-settlement debited" value={stats.nonSettlementDebited} />
        <StatCard label="Buffer debited" value={stats.bufferDebited} />
      </div>

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
              {stats.rejectionBreakdown.map(
                (row: { reason: string; count: number }) => (
                  <tr key={row.reason} className="border-b border-gray-50">
                    <td className="py-2 font-mono text-xs">{row.reason}</td>
                    <td className="py-2 text-right">{row.count.toLocaleString()}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RangeSelector({ current }: { current: TimeRange }) {
  const options: { value: TimeRange; label: string }[] = [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
  ];
  return (
    <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
      {options.map((opt) => (
        <a
          key={opt.value}
          href={`/?range=${opt.value}`}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
            current === opt.value
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {opt.label}
        </a>
      ))}
    </div>
  );
}
