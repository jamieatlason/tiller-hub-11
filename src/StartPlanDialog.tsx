import { useEffect, useMemo, useState } from "react";
import type { EnvMeta } from "../api/types";
import type { HandoffArtifact } from "../api/agent-core/types";
import { fetchRepo, fetchRepoHandoffs, startEnv } from "./api";
import { listApprovedPlanHandoffs } from "./plan-handoffs";

interface StartPlanDialogProps {
  env: EnvMeta;
  hubUrl: string;
  onClose: () => void;
  onStarted: (status: string) => void;
}

type PlanChoice = "latest" | "specific" | "none";

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function StartPlanDialog({
  env,
  hubUrl,
  onClose,
  onStarted,
}: StartPlanDialogProps) {
  const [handoffs, setHandoffs] = useState<HandoffArtifact[]>([]);
  const [currentRevisionId, setCurrentRevisionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvedPlans = useMemo(
    () => listApprovedPlanHandoffs(handoffs),
    [handoffs],
  );
  const latestCurrentApprovedPlan = useMemo(
    () =>
      approvedPlans.find(
        (plan) => !plan.legacyRevision && plan.repoRevisionId === currentRevisionId,
      ) ?? null,
    [approvedPlans, currentRevisionId],
  );
  const latestApprovedPlan = approvedPlans[0] ?? null;
  const [choice, setChoice] = useState<PlanChoice>("latest");
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    const loadApprovedPlans = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!env.repoId) {
          setHandoffs([]);
          setError("This environment does not have a repo identity yet.");
          return;
        }
        const repo = await fetchRepo(hubUrl, env.repoId);
        const nextHandoffs = await fetchRepoHandoffs(hubUrl, env.repoId);
        if (cancelled) return;
        setCurrentRevisionId(repo.currentRevisionId);
        setHandoffs(nextHandoffs);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load plans");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadApprovedPlans();

    return () => {
      cancelled = true;
    };
  }, [env.repoId, env.slug, hubUrl]);

  useEffect(() => {
    if (approvedPlans.length === 0) {
      setChoice("none");
      setSelectedPlanId("");
      return;
    }

    setSelectedPlanId((current) => {
      if (current && approvedPlans.some((plan) => plan.id === current)) {
        return current;
      }
      return latestCurrentApprovedPlan?.id ?? latestApprovedPlan?.id ?? "";
    });

    setChoice((current) => {
      if (current !== "none") return current;
      return latestCurrentApprovedPlan ? "latest" : "none";
    });
  }, [approvedPlans, latestApprovedPlan, latestCurrentApprovedPlan]);

  const selectedPlan = useMemo(() => {
    if (choice === "specific") {
      return approvedPlans.find((plan) => plan.id === selectedPlanId) ?? latestApprovedPlan;
    }
    if (choice === "latest") {
      return latestCurrentApprovedPlan;
    }
    return null;
  }, [approvedPlans, choice, latestApprovedPlan, latestCurrentApprovedPlan, selectedPlanId]);

  const handleStart = async () => {
    setStarting(true);
    setError(null);

    try {
      const planId =
        choice === "none"
          ? null
          : choice === "specific"
            ? selectedPlan?.id ?? null
            : latestCurrentApprovedPlan?.id ?? null;
      const result = await startEnv(hubUrl, env.slug, { planId });
      onStarted(result.status);
      onClose();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start container");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="border-b border-[#d0d7de] px-5 py-4">
          <h3 className="text-sm font-semibold text-[#24292f]">Start Container</h3>
          <p className="mt-1 text-xs text-[#57606a]">
            Choose an approved plan or start without one. Latest approved is selected by default.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="text-xs font-medium text-[#57606a]">Repository</div>
            <div className="mt-1 text-sm text-[#24292f]">
              {env.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-[#57606a]">Plan</div>

            {loading ? (
              <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-sm text-[#57606a]">
                Loading approved plans...
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#d0d7de] px-3 py-2">
                  <input
                    type="radio"
                    name={`plan-choice-${env.slug}`}
                    checked={choice === "latest"}
                    onChange={() => setChoice("latest")}
                    disabled={!latestCurrentApprovedPlan || starting}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#24292f]">Latest approved plan</div>
                    <div className="text-xs text-[#57606a]">
                      {latestCurrentApprovedPlan
                        ? `${latestCurrentApprovedPlan.goal} · ${formatTimestamp(latestCurrentApprovedPlan.approvedAt ?? latestCurrentApprovedPlan.createdAt)}`
                        : latestApprovedPlan
                          ? `${latestApprovedPlan.goal} · ${formatTimestamp(latestApprovedPlan.approvedAt ?? latestApprovedPlan.createdAt)} (outdated)`
                        : "No approved plans available."}
                    </div>
                  </div>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#d0d7de] px-3 py-2">
                  <input
                    type="radio"
                    name={`plan-choice-${env.slug}`}
                    checked={choice === "specific"}
                    onChange={() => setChoice("specific")}
                    disabled={approvedPlans.length === 0 || starting}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[#24292f]">Choose approved plan</div>
                    <select
                      value={selectedPlanId}
                      onChange={(event) => setSelectedPlanId(event.target.value)}
                      disabled={choice !== "specific" || approvedPlans.length === 0 || starting}
                      className="mt-2 w-full rounded border border-[#d0d7de] bg-white px-2 py-1.5 text-sm text-[#24292f] disabled:opacity-50"
                    >
                      {approvedPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.goal}
                          {plan.legacyRevision
                            ? " (legacy)"
                            : currentRevisionId && plan.repoRevisionId !== currentRevisionId
                              ? " (outdated)"
                              : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded border border-[#d0d7de] px-3 py-2">
                  <input
                    type="radio"
                    name={`plan-choice-${env.slug}`}
                    checked={choice === "none"}
                    onChange={() => setChoice("none")}
                    disabled={starting}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#24292f]">No plan</div>
                    <div className="text-xs text-[#57606a]">
                      Start the container without writing `/.tiller/plan.md`.
                    </div>
                  </div>
                </label>
              </div>
            )}
          </div>

          {selectedPlan && choice !== "none" && !loading && (
            <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-3 py-3">
              <div className="text-xs font-medium text-[#57606a]">Selected plan</div>
              <div className="mt-1 text-sm font-medium text-[#24292f]">{selectedPlan.goal}</div>
              <div className="mt-1 text-xs text-[#57606a]">
                Approved {formatTimestamp(selectedPlan.approvedAt ?? selectedPlan.createdAt)}
                {selectedPlan.legacyRevision
                  ? " · Legacy revision"
                  : currentRevisionId && selectedPlan.repoRevisionId !== currentRevisionId
                    ? ` · Outdated for ${currentRevisionId}`
                    : ""}
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-[#24292f]">
                {selectedPlan.summary}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-[#d0d7de] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={starting}
            className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={loading || starting}
            className="rounded bg-[#0969da] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0a5bc4] disabled:opacity-40"
          >
            {starting ? "Starting..." : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
