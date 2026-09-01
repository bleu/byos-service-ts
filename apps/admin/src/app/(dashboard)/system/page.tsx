import { getSystem } from "@/lib/api";

export default async function SystemPage() {
  const data = await getSystem();

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-[13px] font-semibold text-ink">System</h1>

      <Panel title="Memory">
        <div className="grid grid-cols-3 gap-x-8 gap-y-4">
          <Metric label="Heap used" value={`${data.memory.heapUsedMb} MB`} />
          <Metric label="Heap total" value={`${data.memory.heapTotalMb} MB`} />
          <Metric label="RSS" value={`${data.memory.rssMb} MB`} />
          <Metric label="System total" value={`${data.memory.systemTotalMb} MB`} />
          <Metric label="System free" value={`${data.memory.systemFreeMb} MB`} />
          <Metric label="System used" value={`${data.memory.systemUsedPct}%`} />
        </div>
      </Panel>

      <Panel title="CPU">
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          <Metric label="Cores" value={String(data.cpu.count)} />
          <Metric label="Model" value={data.cpu.model} />
        </div>
      </Panel>

      <Panel title="BullMQ queues">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line">
              <th className="pb-2 text-left text-[10px] uppercase tracking-widest text-dim font-medium">Queue</th>
              <th className="pb-2 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Waiting</th>
              <th className="pb-2 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Active</th>
              <th className="pb-2 text-right text-[10px] uppercase tracking-widest text-dim font-medium">Delayed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.queues as Record<string, { waiting: number; active: number; delayed: number }>).map(([name, counts]) => (
              <tr key={name} className="border-b border-line last:border-0">
                <td className="py-2.5 font-mono text-[12px] text-muted">{name}</td>
                <td className="py-2.5 font-mono text-[12px] text-ink text-right">{counts.waiting ?? 0}</td>
                <td className="py-2.5 font-mono text-[12px] text-ink text-right">{counts.active ?? 0}</td>
                <td className="py-2.5 font-mono text-[12px] text-ink text-right">{counts.delayed ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Pending penalties">
        <Metric label="Penalty tx not yet sent" value={String(data.pendingPenalties)} />
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
