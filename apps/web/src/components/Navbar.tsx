"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useShowAvatars } from "@/hooks/useShowAvatars";
import { useAvatarChoice, AVAILABLE_AVATARS } from "@/hooks/useAvatarChoice";

interface NavItem {
  href: string;
  label: string;
  children?: Array<{ href: string; label: string; description?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/events", label: "Events" },
  { href: "/architect", label: "Architect" },
  {
    href: "/about",
    label: "About",
    children: [
      {
        href: "/about",
        label: "Overview",
        description: "How a room of people and agents reaches one decision",
      },
      {
        href: "/about/data-flow",
        label: "Data Flow",
        description: "What happens when a contribution is submitted",
      },
    ],
  },
];

export function Navbar() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);
  const { showAvatars, toggleAvatars } = useShowAvatars();
  const { avatarChoice, setAvatarChoice } = useAvatarChoice();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  // Close the open dropdown when clicking outside or hitting Escape.
  useEffect(() => {
    if (!openMenu) return;
    function onClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  // Close the dropdown whenever the user navigates.
  useEffect(() => {
    setOpenMenu(null);
  }, [pathname]);

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
              className="text-[10px] font-mono font-normal text-gray-400 dark:text-gray-500 tracking-tight -ml-0.5"
              title="App version — bump confirms a fresh deploy is loaded"
            >
              v0.03
            </sub>
          </Link>
          <div className="flex items-center gap-1" ref={menuRef}>
            {NAV_ITEMS.map((item) => {
              const active = pathname.startsWith(item.href);
              const itemClass = `px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                active
                  ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
                  : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
              }`;

              if (!item.children) {
                return (
                  <Link key={item.href} href={item.href} className={itemClass}>
                    {item.label}
                  </Link>
                );
              }

              const isOpen = openMenu === item.label;
              return (
                <div key={item.href} className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setOpenMenu((cur) => (cur === item.label ? null : item.label))
                    }
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    className={`${itemClass} inline-flex items-center gap-1`}
                  >
                    {item.label}
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                      className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                    >
                      <path
                        d="M3 4.5 L6 7.5 L9 4.5"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {isOpen && (
                    <div
                      role="menu"
                      className="absolute left-0 top-full mt-1 min-w-[220px] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1.5 z-50"
                    >
                      {item.children.map((child) => {
                        const childActive =
                          child.href === "/about"
                            ? pathname === "/about"
                            : pathname.startsWith(child.href);
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            role="menuitem"
                            onClick={() => setOpenMenu(null)}
                            className={`block px-3 py-2 text-xs transition-colors ${
                              childActive
                                ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
                                : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                            }`}
                          >
                            <div className="font-medium">{child.label}</div>
                            {child.description && (
                              <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                                {child.description}
                              </div>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1">
        {!isDisplayRoute && (<>
        {/* Avatar choice dropdown — Random (default), Match role, or pick by name. */}
        {showAvatars && (
          <select
            value={avatarChoice}
            onChange={(e) => setAvatarChoice(e.target.value)}
            className="text-xs bg-transparent text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-md px-1.5 py-1 max-w-[140px] focus:outline-none focus:ring-1 focus:ring-indigo-400"
            title="Choose which avatar the facilitator uses"
            aria-label="Avatar choice"
            data-testid="navbar-avatar-choice"
          >
            <option value="random">Random</option>
            <option value="match_role">Match role</option>
            {AVAILABLE_AVATARS.map((a) => (
              <option key={a.url} value={a.url}>
                {a.label}
              </option>
            ))}
          </select>
        )}

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
