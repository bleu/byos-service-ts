import { db } from "@/lib/db";
import { getPendingPenaltiesCount } from "@/lib/queries";

export default async function SystemPage() {
  const pendingPenalties = await getPendingPenaltiesCount(db);

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-[13px] font-semibold text-ink">System</h1>

      <Panel title="Pending penalties">
        <Metric label="Penalty tx not yet sent" value={String(pendingPenalties)} />
      </Panel>

      <p className="text-[11px] text-dim">Live at page load — refresh for updated values.</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-line rounded">
      <div className="px-5 py-3 border-b border-line">
        <span className="text-[10px] uppercase tracking-widest text-dim font-medium">{title}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-dim font-medium mb-1">{label}</div>
      <div className="font-mono text-sm font-medium text-ink">{value}</div>
    </div>
  );
}
