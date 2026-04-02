import type { HandoffArtifact, WorkspaceContextAccess, WorkspaceEntry } from "./types";

const HANDOFF_DIR = "/.tiller/handoffs";

async function readOptionalDir(workspace: WorkspaceContextAccess, path: string): Promise<WorkspaceEntry[]> {
  try {
    return await workspace.readDir(path);
  } catch {
    return [];
  }
}

export async function saveHandoff(
  workspace: WorkspaceContextAccess,
  handoff: Omit<HandoffArtifact, "id" | "createdAt"> & { id?: string; createdAt?: string },
): Promise<HandoffArtifact> {
  const artifact: HandoffArtifact = {
    ...handoff,
    id: handoff.id ?? crypto.randomUUID(),
    createdAt: handoff.createdAt ?? new Date().toISOString(),
  };

  const path = `${HANDOFF_DIR}/${artifact.id}.json`;
  await workspace.writeFile(path, JSON.stringify(artifact, null, 2));
  return artifact;
}

export async function approveHandoff(
  workspace: WorkspaceContextAccess,
  id: string,
): Promise<HandoffArtifact | null> {
  return markThreadStatus(workspace, id, "approved");
}

export async function discardHandoff(
  workspace: WorkspaceContextAccess,
  id: string,
): Promise<HandoffArtifact | null> {
  return markThreadStatus(workspace, id, "discarded");
}

async function markThreadStatus(
  workspace: WorkspaceContextAccess,
  id: string,
  targetStatus: "approved" | "discarded",
): Promise<HandoffArtifact | null> {
  const artifact = await readHandoff(workspace, id);
  if (!artifact) return null;

  const threadId = artifact.threadId ?? artifact.id;
  const now = new Date().toISOString();
  const handoffs = await listHandoffs(workspace);
  const threadArtifacts = handoffs.filter(
    (handoff) => (handoff.threadId ?? handoff.id) === threadId,
  );

  for (const handoff of threadArtifacts) {
    await saveHandoff(workspace, {
      ...handoff,
      id: handoff.id,
      createdAt: handoff.createdAt,
      status: handoff.id === artifact.id ? targetStatus : targetStatus === "approved" ? "superseded" : "discarded",
      approvedAt: handoff.id === artifact.id && targetStatus === "approved" ? now : undefined,
    });
  }

  return readHandoff(workspace, artifact.id);
}

export async function readHandoff(
  workspace: WorkspaceContextAccess,
  id: string,
): Promise<HandoffArtifact | null> {
  const content = await workspace.readFile(`${HANDOFF_DIR}/${id}.json`);
  if (!content) return null;

  try {
    return JSON.parse(content) as HandoffArtifact;
  } catch {
    return null;
  }
}

export async function listHandoffs(workspace: WorkspaceContextAccess): Promise<HandoffArtifact[]> {
  const entries = (await readOptionalDir(workspace, HANDOFF_DIR))
    .filter((entry) => entry.type === "file" && entry.path.endsWith(".json"))
    .sort((a, b) => a.path.localeCompare(b.path));

  const handoffs: HandoffArtifact[] = [];
  for (const entry of entries) {
    const artifact = await readHandoff(workspace, entry.path.split("/").pop()!.replace(/\.json$/, ""));
    if (artifact) {
      handoffs.push(artifact);
    }
  }

  return handoffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listApprovedHandoffs(handoffs: HandoffArtifact[]): HandoffArtifact[] {
  return handoffs
    .filter((handoff) => handoff.status === "approved")
    .sort((a, b) => {
      const aDate = a.approvedAt ?? a.createdAt;
      const bDate = b.approvedAt ?? b.createdAt;
      return bDate.localeCompare(aDate);
    });
}

export function renderHandoffPlanMarkdown(handoff: HandoffArtifact): string {
  return [
    `# ${handoff.goal}`,
    "",
    `Kind: ${handoff.kind}`,
    `Created by: ${handoff.createdBy}`,
    `Created at: ${handoff.createdAt}`,
    ...(handoff.repoUrl ? [`Repo URL: ${handoff.repoUrl}`] : []),
    "",
    "## Summary",
    handoff.summary,
    "",
    "## Findings",
    ...(handoff.findings.length > 0 ? handoff.findings.map((finding) => `- ${finding}`) : ["- None recorded"]),
    "",
    "## Relevant Files",
    ...(handoff.relevantFiles.length > 0 ? handoff.relevantFiles.map((file) => `- ${file}`) : ["- None recorded"]),
    "",
    "## Open Questions",
    ...(handoff.openQuestions.length > 0
      ? handoff.openQuestions.map((question) => `- ${question}`)
      : ["- None recorded"]),
    "",
    "## Proposed Plan",
    handoff.proposedPlan,
    "",
    "## Memory References",
    ...(handoff.memoryRefs.length > 0 ? handoff.memoryRefs.map((ref) => `- ${ref}`) : ["- None recorded"]),
    "",
  ].join("\n");
}
