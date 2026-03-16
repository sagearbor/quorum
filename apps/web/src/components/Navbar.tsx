"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Fixed top navigation bar displayed on all pages.
 *
 * The version badge in the top-right corner is intentionally low-key — clicking
 * it navigates to /admin without advertising that endpoint to end users.
 */
export function Navbar() {
  const router = useRouter();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-12 bg-slate-900 border-b border-slate-800 flex items-center px-4 sm:px-6">
      {/* Brand */}
      <Link
        href="/"
        className="text-white font-semibold text-sm tracking-tight mr-8 hover:text-white/80 transition-colors"
      >
        Quorum
      </Link>

      {/* Primary nav links */}
      <div className="flex items-center gap-1 flex-1">
        <NavLink href="/">Home</NavLink>
        <NavLink href="/events">Events</NavLink>
        <NavLink href="/architect">Architect</NavLink>
      </div>

      {/* Version badge — subtle admin entry point */}
      <button
        type="button"
        onClick={() => router.push("/admin")}
        title="Admin"
        className="text-slate-500 hover:text-slate-400 text-[11px] font-mono transition-colors px-2 py-1 rounded hover:bg-slate-800"
      >
        v0.1.0
      </button>
    </nav>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="text-slate-300 hover:text-white text-sm px-3 py-1.5 rounded transition-colors hover:bg-slate-800"
    >
      {children}
    </Link>
  );
}
