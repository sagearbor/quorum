"use client";

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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Architect</h1>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            Create and manage events and quorums
          </p>
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
                        ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60"
                        : "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      step === s.number
                        ? "bg-white text-blue-600"
                        : step > s.number
                          ? "bg-blue-600 text-white"
                          : "bg-gray-300 dark:bg-gray-600 text-white"
                    }`}
                  >
                    {step > s.number ? "\u2713" : s.number}
                  </span>
                  {s.label}
                </button>
                {s.number < STEPS.length && (
                  <div
                    className={`hidden sm:block w-8 h-0.5 ${
                      step > s.number ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"
                    }`}
                  />
                )}
              </li>
            ))}
          </ol>
        </nav>

        {/* Step content */}
        <main className="rounded-xl shadow-sm border p-6 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700">
          {step === 1 && <CreateEventForm />}
          {step === 2 && (
            <>
              {/* Tab toggle for step 2 */}
              <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setAIMode(tab.id === "ai")}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                      (tab.id === "ai") === aiMode
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300"
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
