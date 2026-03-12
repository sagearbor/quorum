"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuorumStore } from "@/store/quorumStore";
import {
  mockQuorums,
  mockRolesByQuorum,
  mockActiveRoles,
  mockContributions,
  stationRoleMap,
} from "@/lib/mockData";
import { enqueue } from "@/lib/offlineQueue";
import type { Role, Contribution, ContributeRequest } from "@quorum/types";
import { AvatarPanel } from "@/components/avatar/AvatarPanel";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);

  const toggle = useCallback(() => {
    if (typeof window === "undefined") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser");
      return;
    }

    if (listening) {
      setListening(false);
      return;
    }

    const recognition: SpeechRecognitionLike = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      onTranscript(transcript);
      setListening(false);
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognition.start();
    setListening(true);
  }, [listening, onTranscript]);

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="voice-button"
      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        listening
          ? "bg-red-100 text-red-700 animate-pulse"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      {listening ? "Listening..." : "Voice"}
    </button>
  );
}

export default function QuorumPage() {
  const params = useParams<{ slug: string; id: string }>();
  const searchParams = useSearchParams();
  const station = searchParams.get("station");

  const {
    currentQuorum,
    currentRole,
    roles,
    activeRoles,
    contributions,
    pendingContributions,
    setCurrentQuorum,
    setCurrentRole,
    setRolesForQuorum,
    setActiveRoles,
    setContributions,
    setHealthScore,
    addOptimisticContribution,
    confirmContribution,
    removeOptimisticContribution,
    setStationDefault,
  } = useQuorumStore();

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const quorumId = params.id;
  const quorumRoles = roles[quorumId] ?? [];
  const stationNum = station ? parseInt(station, 10) : null;
  const defaultRoleId = stationNum ? stationRoleMap[stationNum] : null;

  useEffect(() => {
    const quorum = mockQuorums.find((q) => q.id === quorumId);
    if (quorum) {
      setCurrentQuorum(quorum);
      setHealthScore(quorum.heat_score);
    }

    const qRoles = mockRolesByQuorum[quorumId];
    if (qRoles) setRolesForQuorum(quorumId, qRoles);

    const ar = mockActiveRoles[quorumId];
    if (ar) setActiveRoles(ar);

    const contribs = mockContributions.filter((c) => c.quorum_id === quorumId);
    setContributions(contribs);

    if (stationNum) setStationDefault(stationNum);

    // Auto-select station default role if no role selected yet
    if (defaultRoleId && qRoles) {
      const defaultRole = qRoles.find((r) => r.id === defaultRoleId);
      if (defaultRole) {
        setCurrentRole(defaultRole);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quorumId, stationNum]);

  const selectRole = (role: Role) => {
    setCurrentRole(role);
    setFieldValues({});
    setSubmitSuccess(false);
  };

  const handleFieldChange = (fieldName: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldName]: value }));
  };

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (!currentRole) return;
      const firstEmptyField = currentRole.prompt_template.find(
        (f) => !fieldValues[f.field_name]
      );
      if (firstEmptyField) {
        handleFieldChange(firstEmptyField.field_name, text);
      }
    },
    [currentRole, fieldValues]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRole || !currentQuorum) return;

    setSubmitting(true);
    setSubmitSuccess(false);

    const content = Object.values(fieldValues).filter(Boolean).join("\n\n");
    const tempId = `temp-${Date.now()}`;

    const optimistic: Contribution = {
      id: tempId,
      quorum_id: quorumId,
      role_id: currentRole.id,
      user_token: "anon-local",
      content,
      structured_fields: { ...fieldValues },
      tier_processed: 1,
      created_at: new Date().toISOString(),
    };

    addOptimisticContribution(optimistic);

    const payload: ContributeRequest = {
      role_id: currentRole.id,
      user_token: "anon-local",
      content,
      structured_fields: { ...fieldValues },
    };

    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
      const res = await fetch(
        `${apiBase}/quorums/${quorumId}/contribute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (res.ok) {
        const data = await res.json();
        confirmContribution(tempId, data.contribution_id);
        setSubmitSuccess(true);
        setFieldValues({});
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      // Offline or error: queue for later replay
      removeOptimisticContribution(tempId);
      await enqueue(quorumId, payload);
      addOptimisticContribution({ ...optimistic, id: `queued-${tempId}` });
      setSubmitSuccess(true);
      setFieldValues({});
    } finally {
      setSubmitting(false);
    }
  };

  const quorumContributions = contributions.filter(
    (c) => c.quorum_id === quorumId
  );

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto">
      <header className="mb-4">
        <p className="text-sm text-gray-500">/{params.slug}</p>
        <h1 className="text-xl font-bold">
          {currentQuorum?.title ?? `Quorum ${quorumId}`}
        </h1>
        {currentQuorum?.description && (
          <p className="text-sm text-gray-500 mt-1">
            {currentQuorum.description}
          </p>
        )}
      </header>

      {/* Role pills — full-width buttons with participant count */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Select your role
        </h2>
        <div className="flex flex-col gap-2">
          {quorumRoles.map((role) => {
            const ar = activeRoles.find((a) => a.role_id === role.id);
            const count = ar?.participant_count ?? 0;
            const isSelected = currentRole?.id === role.id;
            const isDefault = role.id === defaultRoleId;

            return (
              <button
                key={role.id}
                data-testid={`role-select-${role.id}`}
                onClick={() => selectRole(role)}
                className={`w-full flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-medium transition-all ${
                  isDefault && !isSelected ? "ring-1 ring-indigo-300" : ""
                }`}
                style={{
                  backgroundColor: isSelected
                    ? `${role.color}20`
                    : `${role.color}08`,
                  color: role.color,
                  ...(isSelected
                    ? { boxShadow: `0 0 0 2px ${role.color}` }
                    : {}),
                }}
              >
                <span className="flex items-center gap-2">
                  {role.name}
                  {isDefault && (
                    <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-semibold">
                      Station default
                    </span>
                  )}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-bold"
                  style={{ backgroundColor: `${role.color}15` }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Contribution form */}
      {currentRole && (
        <section className="mb-6">
          <form onSubmit={handleSubmit} data-testid="contribution-form">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-700">
                Contributing as{" "}
                <span style={{ color: currentRole.color }}>
                  {currentRole.name}
                </span>
              </h2>
              <VoiceButton onTranscript={handleVoiceTranscript} />
            </div>

            <div className="space-y-4">
              {currentRole.prompt_template.map((field) => (
                <div key={field.field_name}>
                  <label
                    htmlFor={field.field_name}
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    {field.prompt}
                  </label>
                  <textarea
                    id={field.field_name}
                    data-testid={`field-${field.field_name}`}
                    value={fieldValues[field.field_name] ?? ""}
                    onChange={(e) =>
                      handleFieldChange(field.field_name, e.target.value)
                    }
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none"
                    placeholder={`Enter your ${field.field_name.replace(/_/g, " ")}...`}
                  />
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="submit"
                disabled={
                  submitting ||
                  Object.values(fieldValues).every((v) => !v.trim())
                }
                data-testid="submit-contribution"
                className="flex-1 rounded-xl bg-indigo-600 text-white py-3 px-4 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
              >
                {submitting ? "Submitting..." : "Submit Contribution"}
              </button>
            </div>

            {submitSuccess && (
              <p
                data-testid="submit-success"
                className="mt-2 text-sm text-green-600 font-medium"
              >
                Contribution submitted successfully
              </p>
            )}
          </form>
        </section>
      )}

      {/* Recent contributions */}
      {quorumContributions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            Recent Contributions ({quorumContributions.length})
          </h2>
          <div className="space-y-2">
            {quorumContributions.map((c) => {
              const role = quorumRoles.find((r) => r.id === c.role_id);
              const isPending = pendingContributions.some(
                (pc) => pc.id === c.id
              );
              return (
                <div
                  key={c.id}
                  data-testid={`contribution-${c.id}`}
                  className={`rounded-lg border p-3 text-sm ${
                    isPending
                      ? "border-dashed border-gray-300 opacity-70"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: role
                          ? `${role.color}15`
                          : "#f3f4f6",
                        color: role?.color ?? "#6b7280",
                      }}
                    >
                      {role?.name ?? "Unknown"}
                    </span>
                    {isPending && (
                      <span className="text-xs text-amber-600 font-medium">
                        Pending...
                      </span>
                    )}
                    <span className="text-xs text-gray-400 ml-auto">
                      {new Date(c.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-gray-700 line-clamp-2">{c.content}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Avatar presence indicator */}
      <div className="mt-4" style={{ height: 80 }}>
        <AvatarPanel
          quorumId={quorumId}
          providerType="mock"
          showDirectionIndicator={false}
        />
      </div>
    </div>
  );
}
