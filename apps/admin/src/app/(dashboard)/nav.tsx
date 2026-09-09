"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/subsolvers", label: "Subsolvers" },
  { href: "/proposals", label: "Proposals" },
  { href: "/system", label: "System" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col py-3">
      {links.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center h-8 pl-3 pr-4 text-[13px] border-l-2 ${
              active
                ? "border-accent bg-accent-tint text-accent font-medium"
                : "border-transparent text-muted hover:text-ink hover:bg-base"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
