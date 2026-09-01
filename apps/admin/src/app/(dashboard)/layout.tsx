import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">BYOS Admin</span>
        <Link href="/" className="text-sm text-gray-600 hover:text-gray-900">
          Overview
        </Link>
        <Link href="/subsolvers" className="text-sm text-gray-600 hover:text-gray-900">
          Subsolvers
        </Link>
        <Link href="/proposals" className="text-sm text-gray-600 hover:text-gray-900">
          Proposals
        </Link>
        <Link href="/system" className="text-sm text-gray-600 hover:text-gray-900">
          System
        </Link>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
