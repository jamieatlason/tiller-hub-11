import { describe, expect, it } from "vitest";
import type { WorkspaceEntry, WorkspaceContextAccess } from "../types";
import { approveHandoff, discardHandoff, listApprovedHandoffs, readHandoff, saveHandoff } from "../handoffs";

class FakeWorkspace implements WorkspaceContextAccess {
  private readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readDir(path = "/"): Promise<WorkspaceEntry[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: WorkspaceEntry[] = [];

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.push({
        path: filePath,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      });
    }

    return entries;
  }

  async glob(): Promise<WorkspaceEntry[]> {
    return [];
  }

  async getWorkspaceInfo() {
    return {
      fileCount: this.files.size,
      directoryCount: 1,
      totalBytes: Array.from(this.files.values()).reduce((sum, content) => sum + content.length, 0),
      r2FileCount: 0,
    };
  }
}

describe("handoffs", () => {
  it("marks a handoff as approved without changing its id", async () => {
    const workspace = new FakeWorkspace();
    const saved = await saveHandoff(workspace, {
      kind: "plan",
      goal: "Ship the feature",
      summary: "Implement the feature in stages.",
      findings: [],
      relevantFiles: ["/packages/tiller-hub/src/PlanView.tsx"],
      openQuestions: [],
      proposedPlan: "1. Build it\n2. Verify it",
      memoryRefs: [],
      createdBy: "plan",
      status: "draft",
      artifactType: "draft",
      model: "gpt-5.4",
    });

    const approved = await approveHandoff(workspace, saved.id);

    expect(approved).toMatchObject({
      id: saved.id,
      status: "approved",
      approvedAt: expect.any(String),
    });
    expect(await readHandoff(workspace, saved.id)).toMatchObject({
      id: saved.id,
      status: "approved",
    });
  });

  it("supersedes other artifacts in the same plan thread when a draft is approved", async () => {
    const workspace = new FakeWorkspace();
    const firstDraft = await saveHandoff(workspace, {
      kind: "plan",
      goal: "Ship the feature",
      summary: "First draft.",
      findings: [],
      relevantFiles: [],
      openQuestions: [],
      proposedPlan: "Draft one",
      memoryRefs: [],
      createdBy: "plan",
      status: "draft",
      artifactType: "draft",
      model: "gpt-5.4",
    });
    const secondDraft = await saveHandoff(workspace, {
      kind: "plan",
      goal: "Ship the feature",
      summary: "Second draft.",
      findings: [],
      relevantFiles: [],
      openQuestions: [],
      proposedPlan: "Draft two",
      memoryRefs: [],
      createdBy: "plan",
      threadId: firstDraft.id,
      parentId: firstDraft.id,
      status: "draft",
      artifactType: "draft",
      model: "gpt-5.4",
    });
    const review = await saveHandoff(workspace, {
      kind: "review",
      goal: "Review of Ship the feature",
      summary: "Found rollout issues.",
      findings: ["Need a rollback step."],
      relevantFiles: [],
      openQuestions: [],
      proposedPlan: "Add rollback coverage.",
      memoryRefs: [],
      createdBy: "plan-review",
      threadId: firstDraft.id,
      parentId: secondDraft.id,
      status: "draft",
      artifactType: "review",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });

    await approveHandoff(workspace, secondDraft.id);

    expect(await readHandoff(workspace, secondDraft.id)).toMatchObject({
      id: secondDraft.id,
      status: "approved",
    });
    expect(await readHandoff(workspace, firstDraft.id)).toMatchObject({
      id: firstDraft.id,
      status: "superseded",
    });
    expect(await readHandoff(workspace, review.id)).toMatchObject({
      id: review.id,
      status: "superseded",
    });
  });

  it("lists approved handoffs newest first", () => {
    const approved = listApprovedHandoffs([
      {
        id: "older",
        kind: "plan",
        goal: "Older",
        summary: "",
        findings: [],
        relevantFiles: [],
        openQuestions: [],
        proposedPlan: "",
        memoryRefs: [],
        createdBy: "plan",
        createdAt: "2026-03-20T00:00:00.000Z",
        status: "approved",
        approvedAt: "2026-03-20T01:00:00.000Z",
      },
      {
        id: "newer",
        kind: "plan",
        goal: "Newer",
        summary: "",
        findings: [],
        relevantFiles: [],
        openQuestions: [],
        proposedPlan: "",
        memoryRefs: [],
        createdBy: "plan",
        createdAt: "2026-03-21T00:00:00.000Z",
        status: "approved",
        approvedAt: "2026-03-21T01:00:00.000Z",
      },
      {
        id: "draft",
        kind: "plan",
        goal: "Draft",
        summary: "",
        findings: [],
        relevantFiles: [],
        openQuestions: [],
        proposedPlan: "",
        memoryRefs: [],
        createdBy: "plan",
        createdAt: "2026-03-22T00:00:00.000Z",
        status: "draft",
      },
    ]);

    expect(approved.map((handoff) => handoff.id)).toEqual(["newer", "older"]);
  });

  it("discards the whole thread when requested", async () => {
    const workspace = new FakeWorkspace();
    const firstDraft = await saveHandoff(workspace, {
      kind: "plan",
      goal: "Discard me",
      summary: "Old draft.",
      findings: [],
      relevantFiles: [],
      openQuestions: [],
      proposedPlan: "Draft one",
      memoryRefs: [],
      createdBy: "plan",
      status: "draft",
      artifactType: "draft",
      model: "gpt-5.4",
    });
    const secondDraft = await saveHandoff(workspace, {
      kind: "plan",
      goal: "Discard me",
      summary: "New draft.",
      findings: [],
      relevantFiles: [],
      openQuestions: [],
      proposedPlan: "Draft two",
      memoryRefs: [],
      createdBy: "plan",
      threadId: firstDraft.id,
      parentId: firstDraft.id,
      status: "draft",
      artifactType: "draft",
      model: "gpt-5.4",
    });

    await discardHandoff(workspace, secondDraft.id);

    expect(await readHandoff(workspace, firstDraft.id)).toMatchObject({
      id: firstDraft.id,
      status: "discarded",
    });
    expect(await readHandoff(workspace, secondDraft.id)).toMatchObject({
      id: secondDraft.id,
      status: "discarded",
    });
  });
});
