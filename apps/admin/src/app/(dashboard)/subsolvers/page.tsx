import { getSubsolvers, defaultDateRange } from "@/lib/api";
import { DateRangeForm } from "../date-range-form";

export default async function SubsolversPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromParam, to: toParam } = await searchParams;
  const defaults = defaultDateRange();
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;

  const subsolvers: {
    subSolver: string;
    proposalsReceived: number;
    settled: number;
    settleFailed: number;
    rejected: number;
    penalized: number;
  }[] = await getSubsolvers(from, to);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-[13px] font-semibold text-ink">Subsolvers</h1>
        <DateRangeForm from={from} to={to} resetHref="/subsolvers" />
      </div>

      <div className="bg-surface border border-line rounded overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-base border-b border-line">
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Subsolver</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Received</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Settled</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Reverted</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Rejected</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Penalized</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Win rate</th>
            </tr>
          </thead>
          <tbody>
            {subsolvers.map((s) => {
              const total = s.settled + s.settleFailed;
              const pct = total > 0 ? Math.round((s.settled / total) * 100) : 0;
              return (
                <tr key={s.subSolver} className="border-b border-line last:border-0 hover:bg-base transition-colors duration-100">
                  <td className="px-4 py-3 font-mono text-[12px]">
                    <a
                      href={`/proposals?subSolver=${s.subSolver}`}
                      className="text-accent hover:underline"
                    >
                      {s.subSolver.slice(0, 10)}…{s.subSolver.slice(-6)}
                    </a>
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] text-ink text-right">{s.proposalsReceived.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-ok text-right">{s.settled.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-fail text-right">{s.settleFailed.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-muted text-right">{s.rejected.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-warn text-right">{s.penalized.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-ink text-right font-medium">{pct}%</td>
                </tr>
              );
            })}
            {subsolvers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[12px] text-dim">
                  No data for this interval.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
