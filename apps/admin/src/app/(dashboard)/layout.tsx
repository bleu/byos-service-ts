import { Nav } from "./nav";

export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[184px] shrink-0 bg-surface border-r border-line flex flex-col">
        <div className="px-4 pt-5 pb-4 border-b border-line">
          <div className="font-mono text-[13px] font-semibold text-ink tracking-tight">BYOS</div>
          <div className="font-mono text-[10px] text-dim uppercase tracking-widest mt-0.5">Admin Console</div>
        </div>
        <Nav />
      </aside>

      {/* Content */}
      <main className="flex-1 min-w-0 bg-base">
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
