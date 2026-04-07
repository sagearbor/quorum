"use client";

import { useState, useEffect } from "react";
import { useArchitectStore } from "@/store/architect";
import { CreateEventForm } from "./components/CreateEventForm";
import { CreateQuorumForm } from "./components/CreateQuorumForm";
import { LiveEventDashboard } from "./components/LiveEventDashboard";
import { AIArchitectPanel } from "./components/AIArchitectPanel";

const STEPS = [
  { number: 1, label: "Create Event" },
  { number: 2, label: "Define Quorums" },
  { number: 3, label: "Live Dashboard" },
];

const TABS = [
  { id: "manual", label: "Manual Setup" },
  { id: "ai", label: "AI Architect" },
] as const;

export default function ArchitectPage() {
  const { step, setStep, eventId, aiMode, setAIMode } = useArchitectStore();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <div className={`min-h-screen ${dark ? "bg-gray-900" : "bg-gray-50"}`}>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className={`text-2xl font-bold ${dark ? "text-white" : "text-gray-900"}`}>Architect</h1>
            <p className={`mt-1 ${dark ? "text-gray-400" : "text-gray-600"}`}>
              Create and manage events and quorums
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className={`p-2 rounded-lg transition-colors ${
              dark
                ? "bg-gray-700 text-yellow-400 hover:bg-gray-600"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
        </header>

        {/* Step indicator */}
        <nav className="mb-8" aria-label="Wizard steps">
          <ol className="flex items-center gap-2">
            {STEPS.map((s) => (
              <li key={s.number} className="flex items-center gap-2 flex-1">
                <button
                  onClick={() => {
                    if (s.number === 1 || (s.number >= 2 && eventId)) {
                      setStep(s.number);
                    }
                  }}
                  disabled={s.number > 1 && !eventId}
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    step === s.number
                      ? "bg-blue-600 text-white"
                      : step > s.number
                        ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                        : dark
                      ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                      : "bg-gray-100 text-gray-400 cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      step === s.number
                        ? "bg-white text-blue-600"
                        : step > s.number
                          ? "bg-blue-600 text-white"
                          : "bg-gray-300 text-white"
                    }`}
                  >
                    {step > s.number ? "✓" : s.number}
                  </span>
                  {s.label}
                </button>
                {s.number < STEPS.length && (
                  <div
                    className={`hidden sm:block w-8 h-0.5 ${
                      step > s.number ? "bg-blue-600" : "bg-gray-200"
                    }`}
                  />
                )}
              </li>
            ))}
          </ol>
        </nav>

        {/* Step content */}
        <main className={`rounded-xl shadow-sm border p-6 ${
          dark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"
        }`}>
          {step === 1 && <CreateEventForm />}
          {step === 2 && (
            <>
              {/* Tab toggle for step 2 */}
              <div className="flex border-b border-gray-200 mb-6">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setAIMode(tab.id === "ai")}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                      (tab.id === "ai") === aiMode
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {aiMode ? <AIArchitectPanel /> : <CreateQuorumForm />}
            </>
          )}
          {step === 3 && <LiveEventDashboard />}
        </main>
      </div>
    </div>
  );
}
