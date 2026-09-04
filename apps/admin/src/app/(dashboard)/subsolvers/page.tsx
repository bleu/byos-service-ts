import { db } from "@/lib/db";
import { getEscrowBalances } from "@/lib/escrow";
import { formatNativeAmount } from "@/lib/formatters";
import { getSubsolverStats } from "@/lib/queries";
import type { Address } from "viem";
import { DateRangeForm } from "../date-range-form";

function defaultDateRange(): { from: string; to: string } {
	const to = new Date();
	const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
	return { from: from.toISOString(), to: to.toISOString() };
}

export default async function SubsolversPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromParam, to: toParam } = await searchParams;
  const defaults = defaultDateRange();
  const from = fromParam ?? defaults.from;
  const to = toParam ?? defaults.to;

  const range = { from: new Date(from), to: new Date(to) };

  const subsolvers = await getSubsolverStats(db, range);
  const addresses = subsolvers.map((s) => s.subSolver as Address);
  const escrowBalances = await getEscrowBalances(addresses).catch(() => new Map<Address, bigint | null>());

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
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Penalties</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Penalized (ETH)</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Buffer (ETH)</th>
              <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Escrow (ETH)</th>
            </tr>
          </thead>
          <tbody>
            {subsolvers.map((s) => {
              const total = s.settled + s.settleFailed;
              const pct = total > 0 ? Math.round((s.settled / total) * 100) : 0;
              const escrowRaw = escrowBalances.get(s.subSolver as Address);
              const escrowDisplay = escrowRaw === undefined || escrowRaw === null
                ? "—"
                : formatNativeAmount(escrowRaw.toString());
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
                  <td className="px-4 py-3 font-mono text-[12px] text-warn text-right">{s.penaltyCount.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-warn text-right">{formatNativeAmount(s.penalizedAmountWei)}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-ink text-right">{formatNativeAmount(s.bufferBalanceWei)}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-ink text-right">{escrowDisplay}</td>
                </tr>
              );
            })}
            {subsolvers.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-[12px] text-dim">
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
