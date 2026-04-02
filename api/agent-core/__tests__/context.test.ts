import { describe, expect, it } from "vitest";
import type { Workspace, FileInfo } from "agents/experimental/workspace";
import { buildSystemPrompt } from "../context";
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

  readDir(path = "/"): FileInfo[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children = new Map<string, FileInfo>();

    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      children.set(filePath, {
        path: filePath,
        size: content.length,
        type: "file",
        updatedAt: Date.now(),
      } as FileInfo);
    }

    return Array.from(children.values());
  }

  getWorkspaceInfo() {
    return {
      fileCount: this.files.size,
      directoryCount: 1,
      totalBytes: Array.from(this.files.values()).reduce((sum, content) => sum + content.length, 0),
      r2FileCount: 0,
    };
  }
}

describe("buildSystemPrompt", () => {
  it("injects CLAUDE.md and saved memories into the research prompt", async () => {
    const workspace = new FakeWorkspace({
      "/.tiller/CLAUDE.md": "# Project rules\nUse pnpm only.",
      "/.tiller/memory/repo-note.md": "Remember that deploys happen on Fridays.",
      "/.tiller/handoffs/123.json": JSON.stringify({
        id: "123",
        kind: "research",
        goal: "Understand the build pipeline",
        summary: "Vite and Wrangler are both part of the deploy path.",
        findings: ["Worker and client bundles build separately."],
        relevantFiles: ["/packages/tiller-hub/vite.config.ts"],
        openQuestions: ["Should preview deploys be automatic?"],
        proposedPlan: "Keep the build split and improve preview deployments later.",
        memoryRefs: ["repo-note"],
        createdBy: "research",
        createdAt: "2026-03-27T00:00:00.000Z",
      }),
      "/README.md": "hello",
    }) as unknown as Workspace;

    const prompt = await buildSystemPrompt(RESEARCH_AGENT_SPEC, workspace);

    expect(prompt).toContain("You are a helpful coding assistant");
    expect(prompt).toContain("<project-context");
    expect(prompt).toContain("Use pnpm only.");
    expect(prompt).toContain("<saved-memories>");
    expect(prompt).toContain("deploys happen on Fridays");
    expect(prompt).toContain("<recent-handoffs>");
    expect(prompt).toContain("Understand the build pipeline");
  });
});
