import type { AgentSpec, WorkspaceContextAccess, WorkspaceEntry } from "./types";
import { listHandoffs } from "./handoffs";

const DEFAULT_CONTEXT_CHARS = 20_000;
const PROJECT_CONTEXT_PATHS = ["/.tiller/CLAUDE.md", "/CLAUDE.md"];
const MEMORY_DIR = "/.tiller/memory";

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...(truncated)` : text;
}

async function readOptionalFile(workspace: WorkspaceContextAccess, path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

async function readOptionalDir(workspace: WorkspaceContextAccess, path: string): Promise<WorkspaceEntry[]> {
  try {
    return await workspace.readDir(path);
  } catch {
    return [];
  }
}

async function buildWorkspaceSummary(workspace: WorkspaceContextAccess): Promise<string> {
  const info = await workspace.getWorkspaceInfo();
  const topLevel = (await readOptionalDir(workspace, "/"))
    .slice(0, 20)
    .map((entry) => `${entry.type === "directory" ? "d" : "f"} ${entry.path}`)
    .join("\n");

  return [
    `Files: ${info.fileCount}`,
    `Directories: ${info.directoryCount}`,
    `Bytes: ${info.totalBytes}`,
    topLevel ? `Top level:\n${topLevel}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildSystemPrompt(spec: AgentSpec, workspace: WorkspaceContextAccess): Promise<string> {
  const sections: string[] = [spec.baseInstructions];
  const maxChars = spec.maxContextChars ?? DEFAULT_CONTEXT_CHARS;

  if (spec.injectWorkspaceSummary) {
    sections.push(`<workspace-summary>\n${truncateText(await buildWorkspaceSummary(workspace), 2_000)}\n</workspace-summary>`);
  }

  if (spec.includeProjectContext) {
    for (const path of PROJECT_CONTEXT_PATHS) {
      const content = await readOptionalFile(workspace, path);
      if (content) {
        sections.push(`<project-context path="${path}">\n${truncateText(content, 8_000)}\n</project-context>`);
        break;
      }
    }
  }

  if (spec.includeMemories) {
    const memoryEntries = (await readOptionalDir(workspace, MEMORY_DIR))
      .filter((entry) => entry.type === "file" && entry.path.endsWith(".md"))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, spec.maxMemoryFiles ?? 6);

    if (memoryEntries.length > 0) {
      const memories: string[] = [];
      for (const entry of memoryEntries) {
        const content = await readOptionalFile(workspace, entry.path);
        if (!content) continue;
        memories.push(`<memory path="${entry.path}">\n${truncateText(content, 2_000)}\n</memory>`);
      }

      if (memories.length > 0) {
        sections.push(`<saved-memories>\n${memories.join("\n")}\n</saved-memories>`);
      }
    }
  }

  if (spec.includeHandoffs) {
    const handoffs = (await listHandoffs(workspace)).slice(0, spec.maxHandoffs ?? 3);

    if (handoffs.length > 0) {
      const rendered = handoffs.map((handoff) =>
        [
          `<handoff id="${handoff.id}" kind="${handoff.kind}" createdAt="${handoff.createdAt}">`,
          `Goal: ${handoff.goal}`,
          `Summary: ${handoff.summary}`,
          handoff.findings.length > 0 ? `Findings:\n- ${handoff.findings.join("\n- ")}` : "",
          handoff.relevantFiles.length > 0
            ? `Relevant files:\n- ${handoff.relevantFiles.join("\n- ")}`
            : "",
          handoff.openQuestions.length > 0
            ? `Open questions:\n- ${handoff.openQuestions.join("\n- ")}`
            : "",
          handoff.proposedPlan ? `Plan:\n${handoff.proposedPlan}` : "",
          `</handoff>`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      sections.push(
        `<recent-handoffs>\n${truncateText(rendered.join("\n\n"), 6_000)}\n</recent-handoffs>`,
      );
    }
  }

  return truncateText(sections.join("\n\n"), maxChars);
}
