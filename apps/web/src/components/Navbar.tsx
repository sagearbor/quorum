"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShowAvatars } from "@/hooks/useShowAvatars";

const NAV_ITEMS = [
  { href: "/events", label: "Events" },
  { href: "/architect", label: "Architect" },
  { href: "/about", label: "About" },
];

export function Navbar() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);
  const { showAvatars, toggleAvatars } = useShowAvatars();

  // /display is the projector view — always dark by design, avatars and
  // dark-mode toggles would be confusing there because the page bg ignores
  // them.  Hide both controls on display routes.
  const isDisplayRoute = pathname?.startsWith("/display") ?? false;

  // Initialize from <html> class or localStorage
  useEffect(() => {
    const stored = localStorage.getItem("quorum-dark");
    if (stored === "true" || (!stored && document.documentElement.classList.contains("dark"))) {
      setDark(true);
      document.documentElement.classList.add("dark");
    }
  }, []);

  const toggleDark = () => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("quorum-dark", String(next));
      return next;
    });
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 h-12 flex items-center justify-between">
        {/* Logo / Home */}
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-sm font-bold tracking-tight text-gray-900 dark:text-white inline-flex items-baseline gap-1"
          >
            Quorum
            <sub
              className="text-[9px] font-mono font-normal text-gray-400 dark:text-gray-500 tracking-tighter -ml-0.5"
              title="Live deploy commit — changes confirm new code is loaded"
            >
              {(process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 7)}
            </sub>
          </Link>
          <div className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    active
                      ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
                      : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1">
        {!isDisplayRoute && (<>
        {/* Avatar visibility toggle */}
        <button
          type="button"
          onClick={toggleAvatars}
          className="p-1.5 rounded-lg transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 relative"
          title={showAvatars ? "Hide avatars" : "Show avatars"}
          aria-label="Toggle avatar visibility"
          aria-pressed={showAvatars}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
            {!showAvatars && <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.2" />}
          </svg>
        </button>

        {/* Dark mode toggle */}
        <button
          type="button"
          onClick={toggleDark}
          className="p-1.5 rounded-lg transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle dark mode"
        >
          {dark ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </button>
        </>)}
        </div>
      </div>
    </nav>
  );
}
