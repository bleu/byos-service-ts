import { getSubsolvers, type TimeRange } from "@/lib/api";

export default async function SubsolversPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rawRange } = await searchParams;
  const range = (rawRange === "7d" || rawRange === "30d" ? rawRange : "24h") as TimeRange;

  const subsolvers: {
    subSolver: string;
    proposalsReceived: number;
    settled: number;
    settleFailed: number;
    rejected: number;
    penalized: number;
  }[] = await getSubsolvers(range);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Subsolvers</h1>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(["24h", "7d", "30d"] as TimeRange[]).map((r) => (
            <a
              key={r}
              href={`/subsolvers?range=${r}`}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                range === r
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {r}
            </a>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr className="text-left text-gray-500">
              <th className="px-4 py-3 font-medium">Subsolver</th>
              <th className="px-4 py-3 font-medium text-right">Received</th>
              <th className="px-4 py-3 font-medium text-right">Settled</th>
              <th className="px-4 py-3 font-medium text-right">Failed</th>
              <th className="px-4 py-3 font-medium text-right">Rejected</th>
              <th className="px-4 py-3 font-medium text-right">Penalized</th>
              <th className="px-4 py-3 font-medium text-right">Success %</th>
            </tr>
          </thead>
          <tbody>
            {subsolvers.map((s) => {
              const total = s.settled + s.settleFailed;
              const pct = total > 0 ? Math.round((s.settled / total) * 100) : 0;
              return (
                <tr key={s.subSolver} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">
                    <a
                      href={`/proposals?subSolver=${s.subSolver}`}
                      className="hover:underline text-blue-600"
                    >
                      {s.subSolver.slice(0, 10)}…{s.subSolver.slice(-6)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-right">{s.proposalsReceived.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-green-600">{s.settled.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-red-500">{s.settleFailed.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-yellow-600">{s.rejected.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-red-600">{s.penalized.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-medium">{pct}%</td>
                </tr>
              );
            })}
            {subsolvers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No data for this time range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
