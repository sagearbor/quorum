"use client";

import { useArchitectStore } from "@/store/architect";
import { CreateEventForm } from "./components/CreateEventForm";
import { CreateQuorumForm } from "./components/CreateQuorumForm";
import { LiveEventDashboard } from "./components/LiveEventDashboard";

const STEPS = [
  { number: 1, label: "Create Event" },
  { number: 2, label: "Define Quorums" },
  { number: 3, label: "Live Dashboard" },
];

export default function ArchitectPage() {
  const { step, setStep, eventId } = useArchitectStore();

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Architect</h1>
          <p className="text-gray-500 mt-1">
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
                        ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
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
        <main className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          {step === 1 && <CreateEventForm />}
          {step === 2 && <CreateQuorumForm />}
          {step === 3 && <LiveEventDashboard />}
        </main>
      </div>
    </div>
  );
}
