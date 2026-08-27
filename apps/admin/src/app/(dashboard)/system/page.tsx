import { auth } from "@/lib/auth";
import { getSystem } from "@/lib/api";

export default async function SystemPage() {
  const session = await auth();
  const idToken = (session as any)?.idToken as string;
  const data = await getSystem(idToken);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-xl font-bold">System</h1>

      {/* Memory */}
      <Section title="Memory">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Metric label="Heap used" value={`${data.memory.heapUsedMb} MB`} />
          <Metric label="Heap total" value={`${data.memory.heapTotalMb} MB`} />
          <Metric label="RSS" value={`${data.memory.rssMb} MB`} />
          <Metric label="System total" value={`${data.memory.systemTotalMb} MB`} />
          <Metric label="System free" value={`${data.memory.systemFreeMb} MB`} />
          <Metric label="System used" value={`${data.memory.systemUsedPct}%`} />
        </div>
      </Section>

      {/* CPU */}
      <Section title="CPU">
        <div className="grid grid-cols-2 gap-4">
          <Metric label="Cores" value={String(data.cpu.count)} />
          <Metric label="Model" value={data.cpu.model} />
        </div>
      </Section>

      {/* Queues */}
      <Section title="BullMQ Queue Depths">
        <div className="overflow-hidden rounded border border-gray-100">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-2 font-medium">Queue</th>
                <th className="px-4 py-2 font-medium text-right">Waiting</th>
                <th className="px-4 py-2 font-medium text-right">Active</th>
                <th className="px-4 py-2 font-medium text-right">Delayed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.queues).map(([name, counts]: [string, any]) => (
                <tr key={name} className="border-b border-gray-50">
                  <td className="px-4 py-2 font-mono text-xs">{name}</td>
                  <td className="px-4 py-2 text-right">{counts.waiting ?? 0}</td>
                  <td className="px-4 py-2 text-right">{counts.active ?? 0}</td>
                  <td className="px-4 py-2 text-right">{counts.delayed ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Pending penalties */}
      <Section title="Pending Penalties">
        <Metric label="Penalty tx not yet sent" value={String(data.pendingPenalties)} />
      </Section>

      <p className="text-xs text-gray-400">Values are live at page load time. Refresh for updated data.</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="font-mono font-semibold text-sm">{value}</div>
    </div>
  );
}
