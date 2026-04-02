import type { HandoffArtifact } from "../api/agent-core/types";

export function isReviewHandoff(handoff: HandoffArtifact): boolean {
  return handoff.artifactType === "review" || handoff.kind === "review";
}

export function isPlanDraftHandoff(handoff: HandoffArtifact): boolean {
  if (isReviewHandoff(handoff)) return false;
  return handoff.artifactType === "draft" || handoff.kind === "plan";
}

function isRevisionedPlanHandoff(handoff: HandoffArtifact): boolean {
  return !!handoff.repoRevisionId && !handoff.legacyRevision;
}

export function listPlanDraftHandoffs(handoffs: HandoffArtifact[]): HandoffArtifact[] {
  return handoffs.filter(
    (handoff) =>
      isPlanDraftHandoff(handoff) &&
      isRevisionedPlanHandoff(handoff) &&
      handoff.status !== "approved" &&
      handoff.status !== "superseded" &&
      handoff.status !== "discarded",
  );
}

export function listApprovedPlanHandoffs(handoffs: HandoffArtifact[]): HandoffArtifact[] {
  return handoffs.filter(
    (handoff) =>
      isPlanDraftHandoff(handoff) &&
      isRevisionedPlanHandoff(handoff) &&
      handoff.status === "approved",
  );
}

export function listReviewsForDraft(
  handoffs: HandoffArtifact[],
  draftId: string | null,
): HandoffArtifact[] {
  if (!draftId) return [];
  return handoffs.filter(
    (handoff) =>
      isReviewHandoff(handoff) &&
      handoff.parentId === draftId &&
      handoff.status !== "discarded" &&
      handoff.status !== "superseded" &&
      handoff.status !== "approved",
  );
}

export function getDraftVersion(
  handoffs: HandoffArtifact[],
  draft: HandoffArtifact,
): number {
  const threadId = draft.threadId ?? draft.id;
  const draftsInThread = handoffs
    .filter(
      (handoff) =>
        isPlanDraftHandoff(handoff) &&
        (handoff.threadId ?? handoff.id) === threadId,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const index = draftsInThread.findIndex((handoff) => handoff.id === draft.id);
  return index >= 0 ? index + 1 : 1;
}
