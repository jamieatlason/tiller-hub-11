import { describe, expect, it } from "vitest";
import type { Workspace, FileInfo } from "agents/experimental/workspace";
import {
  createHostedToolRegistry,
  executeHostedTool,
  getHostedToolsForAgent,
  toResponseToolDefinitions,
} from "../tools";
import { RESEARCH_AGENT_SPEC } from "../specs";

class FakeWorkspace {
  private files = new Map<string, string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
    }
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  readDir(path = "/"): FileInfo[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: FileInfo[] = [];

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      entries.push({
        path: filePath,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      } as FileInfo);
    }

    return entries;
  }

  glob(pattern: string): FileInfo[] {
    if (pattern === "**/*") {
      return Array.from(this.files.entries()).map(([path, content]) => ({
        path,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      })) as FileInfo[];
    }

    return [];
  }
}

describe("hosted tools", () => {
  it("includes the research tools and can save memory plus handoffs", async () => {
    const workspace = new FakeWorkspace({
      "/package.json": '{"name":"tiller-hub"}',
    }) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace);
    const tools = getHostedToolsForAgent(registry, RESEARCH_AGENT_SPEC);

    expect(toResponseToolDefinitions(tools).map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "list_files",
      "glob",
      "save_memory",
      "recall_memory",
      "save_handoff",
      "read_handoff",
      "list_handoffs",
    ]);

    expect(
      await executeHostedTool(registry, "save_memory", {
        key: "release-notes",
        content: "Ship local runner changes carefully.",
      }),
    ).toContain("/.tiller/memory/release-notes.md");

    expect(await executeHostedTool(registry, "recall_memory", { key: "release-notes" })).toContain(
      "Ship local runner changes carefully.",
    );

    const saveResult = await executeHostedTool(registry, "save_handoff", {
      kind: "research",
      goal: "Understand the local runner setup",
      summary: "The runner is reachable through the named tunnel.",
      findings: ["The app uses a named tunnel for runner access."],
      relevantFiles: ["/packages/tiller-hub/docs/runner-backends.md"],
      openQuestions: ["Should the runner and relay be merged?"],
      proposedPlan: "Keep the current shape until codemode is integrated.",
      memoryRefs: ["release-notes"],
      createdBy: "research",
    });

    expect(saveResult).toContain("Saved handoff");

    const listResult = await executeHostedTool(registry, "list_handoffs", {});
    expect(listResult).toContain("Understand the local runner setup");

    const savedId = saveResult.match(/[0-9a-f-]{36}/)?.[0];
    expect(savedId).toBeTruthy();

    const readResult = await executeHostedTool(registry, "read_handoff", { id: savedId });
    expect(readResult).toContain("The runner is reachable through the named tunnel.");
  });

  it("applies default repoUrl when saving handoffs", async () => {
    const workspace = new FakeWorkspace({}) as unknown as Workspace;
    const registry = createHostedToolRegistry(workspace, {
      handoffDefaults: {
        repoUrl: "https://github.com/paperwing-dev/paperwing-infrastructure",
      },
    });

    const saveResult = await executeHostedTool(registry, "save_handoff", {
      kind: "plan",
      goal: "Review the monorepo",
      summary: "Saved a repo-scoped draft.",
      proposedPlan: "Inspect packages and propose changes.",
    });

    const savedId = saveResult.match(/[0-9a-f-]{36}/)?.[0];
    expect(savedId).toBeTruthy();

    const readResult = await executeHostedTool(registry, "read_handoff", { id: savedId });
    expect(readResult).toContain('"repoUrl": "https://github.com/paperwing-dev/paperwing-infrastructure"');
  });
});
