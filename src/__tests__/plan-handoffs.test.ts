import { describe, expect, it } from "vitest";
import type { HandoffArtifact } from "../../api/agent-core/types";
import {
  listApprovedPlanHandoffs,
  listPlanDraftHandoffs,
  listReviewsForDraft,
} from "../plan-handoffs";

const BASE_HANDOFF: Omit<HandoffArtifact, "id" | "createdAt"> = {
  kind: "review",
  goal: "Review",
  summary: "Summary",
  findings: [],
  relevantFiles: [],
  openQuestions: [],
  proposedPlan: "{}",
  memoryRefs: [],
  createdBy: "test",
  artifactType: "review",
  model: "gpt-5.4",
};

describe("listReviewsForDraft", () => {
  it("ignores discarded and superseded review artifacts", () => {
    const handoffs: HandoffArtifact[] = [
      {
        ...BASE_HANDOFF,
        id: "review-active",
        createdAt: "2026-03-29T00:00:00.000Z",
        parentId: "draft-1",
        status: "draft",
      },
      {
        ...BASE_HANDOFF,
        id: "review-discarded",
        createdAt: "2026-03-29T00:01:00.000Z",
        parentId: "draft-1",
        status: "discarded",
      },
      {
        ...BASE_HANDOFF,
        id: "review-other",
        createdAt: "2026-03-29T00:02:00.000Z",
        parentId: "draft-2",
        status: "draft",
      },
    ];

    expect(listReviewsForDraft(handoffs, "draft-1").map((handoff) => handoff.id)).toEqual([
      "review-active",
    ]);
  });
});

describe("plan handoff revision filtering", () => {
  it("hides unrevisioned and legacy drafts from active draft lists", () => {
    const handoffs: HandoffArtifact[] = [
      {
        ...BASE_HANDOFF,
        id: "draft-current",
        kind: "plan",
        artifactType: "draft",
        createdAt: "2026-03-29T00:00:00.000Z",
        status: "draft",
        repoRevisionId: "r2",
      },
      {
        ...BASE_HANDOFF,
        id: "draft-legacy-flag",
        kind: "plan",
        artifactType: "draft",
        createdAt: "2026-03-29T00:01:00.000Z",
        status: "draft",
        legacyRevision: true,
      },
      {
        ...BASE_HANDOFF,
        id: "draft-missing-revision",
        kind: "plan",
        artifactType: "draft",
        createdAt: "2026-03-29T00:02:00.000Z",
        status: "draft",
      },
    ];

    expect(listPlanDraftHandoffs(handoffs).map((handoff) => handoff.id)).toEqual([
      "draft-current",
    ]);
  });

  it("hides unrevisioned approvals from the startup plan list", () => {
    const handoffs: HandoffArtifact[] = [
      {
        ...BASE_HANDOFF,
        id: "approved-current",
        kind: "plan",
        artifactType: "draft",
        createdAt: "2026-03-29T00:00:00.000Z",
        status: "approved",
        repoRevisionId: "r3",
      },
      {
        ...BASE_HANDOFF,
        id: "approved-legacy",
        kind: "plan",
        artifactType: "draft",
        createdAt: "2026-03-29T00:01:00.000Z",
        status: "approved",
      },
    ];

    expect(listApprovedPlanHandoffs(handoffs).map((handoff) => handoff.id)).toEqual([
      "approved-current",
    ]);
  });
});
