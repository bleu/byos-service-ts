import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
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
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{session?.user?.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              className="text-sm text-gray-500 hover:text-gray-900 underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
