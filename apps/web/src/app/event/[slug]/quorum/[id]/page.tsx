"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  getQuorum,
  getRoles,
  getContributions,
  isDemoMode,
} from "@/lib/dataProvider";
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

  const quorumId = params.id;
  const slug = params.slug;

  const [quorumTitle, setQuorumTitle] = useState<string>("");
  const [quorumDescription, setQuorumDescription] = useState<string>("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [currentRole, setCurrentRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [quorum, qRoles, qContribs] = await Promise.all([
        getQuorum(quorumId),
        getRoles(quorumId),
        getContributions(quorumId),
      ]);
      if (cancelled) return;

      if (quorum) {
        setQuorumTitle(quorum.title);
        setQuorumDescription(quorum.description);
      }
      setRoles(qRoles as Role[]);
      setContributions(qContribs as Contribution[]);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [quorumId]);

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
      if (currentRole.prompt_template.length > 0) {
        const firstEmptyField = currentRole.prompt_template.find(
          (f) => !fieldValues[f.field_name]
        );
        if (firstEmptyField) {
          handleFieldChange(firstEmptyField.field_name, text);
        }
      } else {
        // Generic contribution field
        handleFieldChange("contribution", text);
      }
    },
    [currentRole, fieldValues]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRole) return;

    setSubmitting(true);
    setSubmitSuccess(false);

    const content = Object.values(fieldValues).filter(Boolean).join("\n\n");

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
        const newContrib: Contribution = {
          id: data.contribution_id,
          quorum_id: quorumId,
          role_id: currentRole.id,
          user_token: "anon-local",
          content,
          structured_fields: { ...fieldValues },
          tier_processed: 1,
          created_at: new Date().toISOString(),
        };
        setContributions((prev) => [...prev, newContrib]);
        setSubmitSuccess(true);
        setFieldValues({});
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      await enqueue(quorumId, payload);
      setSubmitSuccess(true);
      setFieldValues({});
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl mx-auto animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left panel: Avatar facilitator */}
      <div className="lg:w-1/3 lg:min-h-screen bg-slate-900 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <Link
            href={`/event/${slug}`}
            className="text-xs text-white/50 hover:text-white/80 transition-colors"
          >
            &larr; Back to {slug}
          </Link>
          {isDemoMode() && (
            <span className="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
              Demo Mode
            </span>
          )}
        </div>
        <div className="flex-1 min-h-[300px]">
          <AvatarPanel
            quorumId={quorumId}
            showDirectionIndicator
          />
        </div>
      </div>

      {/* Right panel: Quorum interaction */}
      <div className="flex-1 p-4 sm:p-6 max-w-2xl">
        <header className="mb-4">
          <h1 className="text-xl font-bold">
            {quorumTitle || `Quorum ${quorumId}`}
          </h1>
          {quorumDescription && (
            <p className="text-sm text-gray-500 mt-1">{quorumDescription}</p>
          )}
          {station && (
            <span className="mt-2 inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-indigo-700 text-xs font-medium">
              Station {station}
            </span>
          )}
        </header>

        {/* Role selection */}
        {roles.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              Select your role
            </h2>
            <div className="flex flex-col gap-2">
              {roles.map((role) => {
                const isSelected = currentRole?.id === role.id;

                return (
                  <button
                    key={role.id}
                    data-testid={`role-select-${role.id}`}
                    onClick={() => selectRole(role)}
                    className="w-full flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-medium transition-all"
                    style={{
                      backgroundColor: isSelected
                        ? `${role.color ?? "#6b7280"}20`
                        : `${role.color ?? "#6b7280"}08`,
                      color: role.color ?? "#6b7280",
                      ...(isSelected
                        ? { boxShadow: `0 0 0 2px ${role.color ?? "#6b7280"}` }
                        : {}),
                    }}
                  >
                    <span>{role.name}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

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
                {currentRole.prompt_template.length > 0 ? (
                  currentRole.prompt_template.map((field) => (
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
                  ))
                ) : (
                  <div>
                    <label
                      htmlFor="contribution"
                      className="block text-sm font-medium text-gray-700 mb-1"
                    >
                      Your contribution
                    </label>
                    <textarea
                      id="contribution"
                      data-testid="field-contribution"
                      value={fieldValues["contribution"] ?? ""}
                      onChange={(e) =>
                        handleFieldChange("contribution", e.target.value)
                      }
                      rows={4}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none resize-none"
                      placeholder={`Share your perspective as ${currentRole.name}...`}
                    />
                  </div>
                )}
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
        {contributions.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Recent Contributions ({contributions.length})
            </h2>
            <div className="space-y-2">
              {contributions.map((c) => {
                const role = roles.find((r) => r.id === c.role_id);
                return (
                  <div
                    key={c.id}
                    data-testid={`contribution-${c.id}`}
                    className="rounded-lg border border-gray-200 p-3 text-sm"
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
      </div>
    </div>
  );
}
