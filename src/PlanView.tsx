import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import {
  approveHandoff,
  discardHandoff,
  fetchRepo,
  fetchRepoHandoffs,
  integratePlanReviews,
  runPlanReviewRound,
} from "./api";
import { useToast } from "./Toast";
import type { HandoffArtifact } from "../api/agent-core/types";
import {
  listPlanDraftHandoffs,
  listReviewsForDraft,
  getDraftVersion,
} from "./plan-handoffs";
import {
  PLAN_DEFAULT_MODEL,
  PLAN_MODEL_OPTIONS,
  getPlanModelLabel,
  isPlanModelId,
  type PlanModelId,
} from "./plan-models";
import { getPlanChatName, getRepoLabel } from "./plan-repo";

interface ChatToolCall {
  id: string;
  name: string;
  result?: string;
  error?: string;
  pending: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
}

interface PlanViewProps {
  repoId: string;
  repoUrl: string;
  revisionEvent?: {
    repoId: string;
    repoUrl: string;
    previousVersion: number;
    currentVersion: number;
    previousRevisionId: string;
    currentRevisionId: string;
    sourceEnvSlug?: string | null;
  } | null;
}

const HUB_URL = window.location.origin;
const MODEL_STORAGE_KEY = "tiller-hub:selected-plan-model";

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function toChatMessage(message: UIMessage): ChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  const content = message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("");

  const toolCalls = message.parts
    .filter(isToolUIPart)
    .map((part) => {
      const state = part.state;

      return {
        id: part.toolCallId,
        name: getToolName(part),
        result:
          state === "output-available" ? serializeToolOutput(part.output) : undefined,
        error: state === "output-error" ? part.errorText : undefined,
        pending: state !== "output-available" && state !== "output-error",
      } satisfies ChatToolCall;
    });

  return {
    id: message.id,
    role: message.role,
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function PlanView({ repoId, repoUrl, revisionEvent }: PlanViewProps) {
  const [input, setInput] = useState("");
  const [handoffs, setHandoffs] = useState<HandoffArtifact[]>([]);
  const [handoffsLoading, setHandoffsLoading] = useState(true);
  const [repoRevisionId, setRepoRevisionId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [reviewingDraftId, setReviewingDraftId] = useState<string | null>(null);
  const [integratingDraftId, setIntegratingDraftId] = useState<string | null>(null);
  const [approvingDraftId, setApprovingDraftId] = useState<string | null>(null);
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null);
  const [expandedReviewIds, setExpandedReviewIds] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState<PlanModelId>(() => {
    if (typeof window === "undefined") return PLAN_DEFAULT_MODEL;
    const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
    return isPlanModelId(stored) ? stored : PLAN_DEFAULT_MODEL;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seenRevisionNoticeRef = useRef<string | null>(null);
  const addToast = useToast();

  const agent = useAgent({
    agent: "plan-chat",
    name: getPlanChatName(repoId),
  });

  const {
    messages,
    sendMessage,
    setMessages,
    clearHistory,
    status,
    error,
  } = useAgentChat({
    agent,
    body: () => ({ selectedModel, repoUrl }),
  });

  const renderedMessages = useMemo(
    () => messages.map(toChatMessage).filter((message): message is ChatMessage => message !== null),
    [messages],
  );
  const latestSavedHandoffKey = useMemo(
    () =>
      messages
        .flatMap((message) =>
          message.parts
            .filter(isToolUIPart)
            .filter(
              (part) => getToolName(part) === "save_handoff" && part.state === "output-available",
            )
            .map((part) => `${part.toolCallId}:${serializeToolOutput(part.output)}`),
        )
        .join("|"),
    [messages],
  );
  const planDrafts = useMemo(() => listPlanDraftHandoffs(handoffs), [handoffs]);
  const selectedDraft =
    planDrafts.find((handoff) => handoff.id === selectedDraftId) ?? planDrafts[0] ?? null;
  const reviewArtifacts = useMemo(
    () => listReviewsForDraft(handoffs, selectedDraft?.id ?? null),
    [handoffs, selectedDraft?.id],
  );
  const selectedDraftOutdated =
    !!selectedDraft &&
    (!selectedDraft.repoRevisionId ||
      selectedDraft.legacyRevision ||
      (!!repoRevisionId && selectedDraft.repoRevisionId !== repoRevisionId));

  const loading = !agent.identified && renderedMessages.length === 0;
  const streaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [renderedMessages, status]);

  useEffect(() => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
  }, [selectedModel]);

  const loadRepo = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      try {
        const repo = await fetchRepo(HUB_URL, repoId);
        setRepoRevisionId(repo.currentRevisionId);
      } catch (loadError) {
        if (!quiet) {
          addToast({
            title: "Failed to load repo state",
            body: loadError instanceof Error ? loadError.message : "Unknown error",
            variant: "error",
          });
        }
      }
    },
    [addToast, repoId],
  );

  const loadHandoffs = useCallback(
    async ({
      quiet = false,
      preferNewest = false,
    }: {
      quiet?: boolean;
      preferNewest?: boolean;
    } = {}) => {
      if (!quiet) setHandoffsLoading(true);

      try {
        const nextHandoffs = await fetchRepoHandoffs(HUB_URL, repoId);
        const nextDrafts = listPlanDraftHandoffs(nextHandoffs);
        setHandoffs(nextHandoffs);
        setSelectedDraftId((current) => {
          if (preferNewest) {
            return nextDrafts[0]?.id ?? null;
          }
          if (current && nextDrafts.some((handoff) => handoff.id === current)) {
            return current;
          }
          return nextDrafts[0]?.id ?? null;
        });
      } catch (loadError) {
        if (!quiet) {
          addToast({
            title: "Failed to load draft plans",
            body: loadError instanceof Error ? loadError.message : "Unknown error",
            variant: "error",
          });
        }
      } finally {
        if (!quiet) setHandoffsLoading(false);
      }
    },
    [addToast, repoId],
  );

  useEffect(() => {
    void loadRepo();
    void loadHandoffs();
  }, [loadHandoffs, loadRepo]);

  useEffect(() => {
    if (streaming) return;

    const timeout = window.setTimeout(() => {
      void loadHandoffs({ quiet: true });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [loadHandoffs, renderedMessages.length, streaming]);

  useEffect(() => {
    if (!latestSavedHandoffKey) return;
    void loadHandoffs({ quiet: true, preferNewest: true });
  }, [latestSavedHandoffKey, loadHandoffs]);

  useEffect(() => {
    if (!revisionEvent || revisionEvent.repoId !== repoId) return;
    const noticeKey = `${revisionEvent.repoId}:${revisionEvent.currentRevisionId}`;
    if (seenRevisionNoticeRef.current === noticeKey) return;
    seenRevisionNoticeRef.current = noticeKey;
    setRepoRevisionId(revisionEvent.currentRevisionId);
    setMessages((current) => [
      ...current,
      {
        id: `repo-revision-${noticeKey}`,
        role: "assistant",
        parts: [{
          type: "text",
          text: `Repo changed${revisionEvent.sourceEnvSlug ? ` from env ${revisionEvent.sourceEnvSlug}` : ""}. Drafts based on the previous repo state are now outdated.`,
        }],
      } as UIMessage,
    ]);
    void loadRepo({ quiet: true });
    void loadHandoffs({ quiet: true });
  }, [loadHandoffs, loadRepo, repoId, revisionEvent, setMessages]);

  const handleSend = useCallback(() => {
    const message = input.trim();
    if (!message || streaming) return;

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }],
    });
    setInput("");
    inputRef.current?.focus();
  }, [input, sendMessage, streaming]);

  const handleRunReviewRound = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "This draft was created against an older repo revision.",
        variant: "warning",
      });
      return;
    }

    setReviewingDraftId(selectedDraft.id);
    try {
      const result = await runPlanReviewRound(HUB_URL, repoId, selectedDraft.id);
      addToast({
        title: "Review round completed",
        body: `${result.reviews.length} model reviews saved for ${selectedDraft.goal}`,
        variant: "success",
      });
      setExpandedReviewIds(
        new Set(result.reviews.map((review) => review.id)),
      );
      await loadHandoffs({ quiet: true });
    } catch (reviewError) {
      addToast({
        title: "Failed to run review round",
        body: reviewError instanceof Error ? reviewError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setReviewingDraftId(null);
    }
  }, [addToast, loadHandoffs, repoId, selectedDraft, selectedDraftOutdated]);

  const handleIntegrateReviews = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "This draft was created against an older repo revision.",
        variant: "warning",
      });
      return;
    }
    if (reviewArtifacts.length === 0) {
      addToast({
        title: "No reviews yet",
        body: "Run a review round first so the planner has feedback to integrate.",
        variant: "warning",
      });
      return;
    }

    setIntegratingDraftId(selectedDraft.id);
    try {
      const result = await integratePlanReviews(HUB_URL, repoId, selectedDraft.id, {
        selectedModel,
      });

      setMessages((current) => [
        ...current,
        {
          id: `integration-${crypto.randomUUID()}`,
          role: "assistant",
          parts: [{ type: "text", text: result.reply }],
        } as UIMessage,
      ]);

      addToast({
        title: result.skipped ? "No grounded review issues" : "Reviews integrated",
        body: result.skipped
          ? "The draft stayed unchanged because the review feedback did not survive grounding checks."
          : `${result.groundedIssueCount} grounded review issue${result.groundedIssueCount === 1 ? "" : "s"} considered.`,
        variant: result.skipped ? "warning" : "success",
      });

      await loadHandoffs({ quiet: true, preferNewest: !result.skipped });
    } catch (integrationError) {
      addToast({
        title: "Failed to integrate reviews",
        body: integrationError instanceof Error ? integrationError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setIntegratingDraftId(null);
    }
  }, [addToast, loadHandoffs, repoId, reviewArtifacts.length, selectedDraft, selectedDraftOutdated, selectedModel, setMessages]);

  const handleApprove = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "Start a new draft on the current repo revision before approving.",
        variant: "warning",
      });
      return;
    }

    setApprovingDraftId(selectedDraft.id);
    try {
      await approveHandoff(HUB_URL, repoId, selectedDraft.id);
      addToast({
        title: "Plan approved",
        body: `${selectedDraft.goal} is now available when starting a container.`,
        variant: "success",
      });
      await loadHandoffs({ quiet: true });
    } catch (approveError) {
      addToast({
        title: "Failed to approve plan",
        body: approveError instanceof Error ? approveError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setApprovingDraftId(null);
    }
  }, [addToast, loadHandoffs, repoId, selectedDraft, selectedDraftOutdated]);

  const handleDiscard = useCallback(async () => {
    if (!selectedDraft) return;
    if (!window.confirm(`Discard "${selectedDraft.goal}" and hide this thread from Plan?`)) {
      return;
    }

    setDiscardingDraftId(selectedDraft.id);
    try {
      await discardHandoff(HUB_URL, repoId, selectedDraft.id);
      addToast({
        title: "Plan discarded",
        body: `${selectedDraft.goal} was removed from the active draft list.`,
        variant: "success",
      });
      await loadHandoffs({ quiet: true });
    } catch (discardError) {
      addToast({
        title: "Failed to discard plan",
        body: discardError instanceof Error ? discardError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setDiscardingDraftId(null);
    }
  }, [addToast, loadHandoffs, repoId, selectedDraft]);

  const toggleExpandedReview = useCallback((id: string) => {
    setExpandedReviewIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[#24292f]">{getRepoLabel(repoUrl)}</span>
            <span className="rounded border border-[#bbf7d0] bg-[#f0fdf4] px-1.5 py-0.5 text-xs text-[#15803d]">
              Plan
            </span>
            {repoRevisionId && (
              <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-xs text-[#57606a]">
                {repoRevisionId}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-[#57606a]">Starting model</label>
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value as PlanModelId)}
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#24292f]"
              disabled={streaming}
            >
              {PLAN_MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleRunReviewRound()}
              disabled={
                !selectedDraft ||
                streaming ||
                reviewingDraftId === selectedDraft?.id ||
                integratingDraftId === selectedDraft?.id
              }
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {reviewingDraftId === selectedDraft?.id ? "Reviewing..." : "Run review round"}
            </button>
            <button
              onClick={() => void handleIntegrateReviews()}
              disabled={
                !selectedDraft ||
                reviewArtifacts.length === 0 ||
                streaming ||
                integratingDraftId === selectedDraft?.id
              }
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {integratingDraftId === selectedDraft?.id ? "Integrating..." : "Integrate reviews"}
            </button>
            <button
              onClick={() => void clearHistory()}
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa]"
            >
              Reset chat
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="py-8 text-center text-sm text-[#57606a]">Loading...</div>
          )}

          {!loading && renderedMessages.length === 0 && !error && (
            <div className="py-8 text-center text-sm text-[#57606a]">
              Start planning here. Drafts, reviews, and approvals will stay scoped to this repo.
            </div>
          )}

          {renderedMessages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-[#0969da] text-white"
                    : "border border-[#d0d7de] bg-[#f6f8fa] text-[#24292f]"
                }`}
              >
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {message.toolCalls.map((toolCall) => (
                      <details key={toolCall.id} className="text-xs">
                        <summary className="cursor-pointer font-medium text-[#7c3aed]">
                          {toolCall.name}
                          {toolCall.pending ? " (running...)" : ""}
                          {toolCall.error ? " (failed)" : ""}
                        </summary>
                        {(toolCall.result || toolCall.error) && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-[#e1e4e8] bg-white p-1.5 text-[10px]">
                            {(toolCall.error ?? toolCall.result ?? "").slice(0, 2000)}
                            {(toolCall.error ?? toolCall.result ?? "").length > 2000 ? "..." : ""}
                          </pre>
                        )}
                      </details>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
              </div>
            </div>
          ))}

          {error && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error.message}
              </div>
            </div>
          )}

          {streaming &&
            renderedMessages[renderedMessages.length - 1]?.role !== "assistant" && (
              <div className="flex justify-start">
                <div className="animate-pulse rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-sm text-[#57606a]">
                  Thinking...
                </div>
              </div>
            )}
        </div>

        <div className="border-t border-[#d0d7de] bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs text-[#57606a]">
            <span>Planner model</span>
            <span>{getPlanModelLabel(selectedModel)}</span>
          </div>
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Describe the plan you want to build..."
              rows={1}
              className="flex-1 resize-none rounded-lg border border-[#d0d7de] px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#0969da]"
              disabled={streaming}
            />
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white hover:bg-[#0860c4] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <aside className="hidden w-[340px] flex-col border-l border-[#d0d7de] bg-[#fbfbfc] xl:flex">
        <div className="flex items-center justify-between border-b border-[#d0d7de] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-[#24292f]">Draft Plans</div>
            <div className="text-xs text-[#57606a]">
              Approved plans leave this view and become available when starting a container.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleApprove()}
              disabled={
                !selectedDraft ||
                streaming ||
                integratingDraftId === selectedDraft?.id ||
                approvingDraftId === selectedDraft?.id
              }
              className="rounded bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0860c4] disabled:opacity-40"
            >
              {approvingDraftId === selectedDraft?.id ? "Approving..." : "Approve"}
            </button>
            <button
              onClick={() => void handleDiscard()}
              disabled={
                !selectedDraft ||
                streaming ||
                integratingDraftId === selectedDraft?.id ||
                discardingDraftId === selectedDraft?.id
              }
              className="rounded border border-red-200 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
            >
              {discardingDraftId === selectedDraft?.id ? "Discarding..." : "Discard"}
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="min-h-0 overflow-y-auto border-b border-[#d0d7de]">
            {handoffsLoading && planDrafts.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[#57606a]">Loading draft plans...</div>
            ) : planDrafts.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[#57606a]">
                No draft plans yet. Start planning to create one.
              </div>
            ) : (
              planDrafts.map((draft) => {
                const selected = draft.id === selectedDraft?.id;
                const reviews = listReviewsForDraft(handoffs, draft.id);
                const draftOutdated =
                  !draft.repoRevisionId ||
                  !!draft.legacyRevision ||
                  (!!repoRevisionId && draft.repoRevisionId !== repoRevisionId);

                return (
                  <button
                    key={draft.id}
                    onClick={() => setSelectedDraftId(draft.id)}
                    className={`flex w-full flex-col gap-1 border-b border-[#eef1f4] px-4 py-3 text-left hover:bg-white ${
                      selected ? "bg-white" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-[#24292f]">
                        {draft.goal}
                      </span>
                      <span className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#57606a]">
                        {draftOutdated ? "outdated" : `v${getDraftVersion(handoffs, draft)}`}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-xs text-[#57606a]">{draft.summary}</div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#8c959f]">
                      <span>{getPlanModelLabel(draft.model)}</span>
                      <span>{draft.repoRevisionId ?? "legacy"} · {formatTimestamp(draft.createdAt)}</span>
                    </div>
                    {reviews.length > 0 && (
                      <div className="text-[11px] text-[#57606a]">
                        Reviewed by {reviews.map((review) => getPlanModelLabel(review.model)).join(", ")}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className="min-h-0 overflow-y-auto px-4 py-4">
            {selectedDraft ? (
              <div className="space-y-4">
                <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[#24292f]">
                      {selectedDraft.goal}
                    </div>
                    <div className="mt-1 text-xs text-[#57606a]">
                      {getPlanModelLabel(selectedDraft.model)} · {formatTimestamp(selectedDraft.createdAt)}
                    </div>
                  </div>
                  <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#57606a]">
                      {selectedDraftOutdated ? "Outdated" : "Draft"}
                  </span>
                </div>
                </div>

                <section>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                    Summary
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-[#24292f]">
                    {selectedDraft.summary}
                  </div>
                </section>

                <section>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                    Proposed Plan
                  </div>
                  <div className="whitespace-pre-wrap rounded border border-[#e1e4e8] bg-white p-2 text-sm text-[#24292f]">
                    {selectedDraft.proposedPlan}
                  </div>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                      Review Feedback
                    </div>
                    <div className="text-[11px] text-[#57606a]">
                      {reviewArtifacts.length} review{reviewArtifacts.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  {reviewArtifacts.length === 0 ? (
                    <div className="rounded border border-dashed border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#57606a]">
                      No review feedback yet. Run a review round to see which models disagree with this plan.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {reviewArtifacts.map((review) => {
                        const expanded = expandedReviewIds.has(review.id);
                        return (
                          <div key={review.id} className="rounded border border-[#d0d7de] bg-white">
                            <button
                              onClick={() => toggleExpandedReview(review.id)}
                              className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-[#24292f]">
                                  {getPlanModelLabel(review.model)}
                                </div>
                                <div className="mt-1 text-xs text-[#57606a]">{review.summary}</div>
                                {(review.reviewIssueStats || review.reviewMeta) && (
                                  <div className="mt-1 text-[11px] text-[#8c959f]">
                                    {review.reviewIssueStats
                                      ? `${review.reviewIssueStats.kept} grounded issue${review.reviewIssueStats.kept === 1 ? "" : "s"} kept`
                                      : "No grounded issues kept"}
                                    {review.reviewIssueStats && review.reviewIssueStats.dropped > 0
                                      ? `, ${review.reviewIssueStats.dropped} dropped`
                                      : ""}
                                    {review.reviewMeta?.toolCallCount
                                      ? `, ${review.reviewMeta.toolCallCount} code inspection step${review.reviewMeta.toolCallCount === 1 ? "" : "s"}`
                                      : ""}
                                    {review.reviewMeta?.retriedForToolUse
                                      ? ", retried for code inspection"
                                      : ""}
                                    {review.reviewMeta?.repaired ? ", repaired output" : ""}
                                    {review.reviewMeta?.truncated
                                      ? ", response truncated"
                                      : review.reviewMeta?.finishReason &&
                                          review.reviewMeta.finishReason !== "stop"
                                        ? `, finish: ${review.reviewMeta.finishReason}`
                                        : ""}
                                  </div>
                                )}
                              </div>
                              <span className="shrink-0 text-[11px] text-[#57606a]">
                                {expanded ? "Hide response" : "Show full response"}
                              </span>
                            </button>
                            {expanded && (
                              <div className="border-t border-[#e1e4e8] px-3 py-2">
                                {review.findings.length > 0 && (
                                  <div className="mb-3">
                                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                                      Key Findings
                                    </div>
                                    <ul className="list-disc space-y-1 pl-4 text-sm text-[#24292f]">
                                      {review.findings.map((finding) => (
                                        <li key={finding}>{finding}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#e1e4e8] bg-[#f6f8fa] p-2 text-xs text-[#24292f]">
                                  {review.proposedPlan}
                                </pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="text-sm text-[#57606a]">
                Select a draft plan to inspect its review feedback.
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
