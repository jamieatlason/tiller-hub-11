import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  AgentSpec,
  HostedTool,
  HostedToolDefinition,
  HostedToolName,
  WorkspaceContextAccess,
  WorkspaceEntry,
} from "./types";
import type { ResponseToolDefinition } from "./codex";
import { listHandoffs, readHandoff, saveHandoff } from "./handoffs";
import type { HandoffArtifact } from "./types";

const MEMORY_DIR = "/.tiller/memory";

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getInputString(input: Record<string, unknown>, key: string): string | undefined {
  return getString(input[key]);
}

function getInputStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function formatFileInfo(entry: WorkspaceEntry): string {
  return `${entry.type === "directory" ? "d" : "f"} ${entry.path} (${entry.size}b)`;
}

function normalizeMemoryKey(key: string): string {
  const cleaned = key.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  return cleaned || "note";
}

function formatHandoffSummary(id: string, goal: string, summary: string): string {
  return [id, goal, summary].filter(Boolean).join(" :: ");
}

async function listMemoryEntries(workspace: WorkspaceContextAccess): Promise<WorkspaceEntry[]> {
  try {
    return (await workspace
      .readDir(MEMORY_DIR))
      .filter((entry) => entry.type === "file" && entry.path.endsWith(".md"))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

function buildTool(
  definition: HostedToolDefinition,
  execute: HostedTool["execute"],
): HostedTool {
  return { definition, execute };
}

interface HostedToolRegistryOptions {
  handoffDefaults?: Partial<Pick<HandoffArtifact, "repoId" | "repoUrl" | "repoRevisionId">>;
}

export function createHostedToolRegistry(
  workspace: WorkspaceContextAccess,
  options: HostedToolRegistryOptions = {},
): Map<HostedToolName, HostedTool> {
  const handoffDefaults = options.handoffDefaults ?? {};
  return new Map<HostedToolName, HostedTool>([
    [
      "read_file",
      buildTool(
        {
          name: "read_file",
          description: "Read the contents of a file at the given path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path starting with /" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const path = getInputString(input, "path");
          if (!path) return "Error: path is required";
          const content = await workspace.readFile(path);
          return content ?? `Error: file not found at ${path}`;
        },
      ),
    ],
    [
      "write_file",
      buildTool(
        {
          name: "write_file",
          description: "Write content to a file, creating it if it doesn't exist.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path starting with /" },
              content: { type: "string", description: "The file content to write" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const path = getInputString(input, "path");
          const content = getInputString(input, "content");
          if (!path || content === undefined) return "Error: path and content are required";
          await workspace.writeFile(path, content);
          return `Written ${content.length} bytes to ${path}`;
        },
      ),
    ],
    [
      "list_files",
      buildTool(
        {
          name: "list_files",
          description: "List files and directories in the given directory.",
          parameters: {
            type: "object",
            properties: {
              directory: { type: "string", description: "Directory path (default: /)" },
            },
            required: [],
            additionalProperties: false,
          },
        },
        async (input) => {
          const dir = getInputString(input, "directory") || "/";
          const entries = await workspace.readDir(dir);
          return entries.map(formatFileInfo).join("\n") || "(empty directory)";
        },
      ),
    ],
    [
      "glob",
      buildTool(
        {
          name: "glob",
          description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.tsx).",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Glob pattern" },
            },
            required: ["pattern"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const pattern = getInputString(input, "pattern");
          if (!pattern) return "Error: pattern is required";
          const matches = await workspace.glob(pattern);
          return matches.map(formatFileInfo).join("\n") || "(no matches)";
        },
      ),
    ],
    [
      "save_memory",
      buildTool(
        {
          name: "save_memory",
          description: "Persist a short note for future hosted agents.",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Memory key, like feature-name or review-note" },
              content: { type: "string", description: "Markdown content to save" },
            },
            required: ["key", "content"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const key = getInputString(input, "key");
          const content = getInputString(input, "content");
          if (!key || content === undefined) return "Error: key and content are required";

          const normalized = normalizeMemoryKey(key);
          const path = `${MEMORY_DIR}/${normalized}.md`;
          await workspace.writeFile(path, content);
          return `Saved memory to ${path}`;
        },
      ),
    ],
    [
      "recall_memory",
      buildTool(
        {
          name: "recall_memory",
          description: "Read one saved memory or list available memories when no key is provided.",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "Optional memory key" },
            },
            required: [],
            additionalProperties: false,
          },
        },
        async (input) => {
          const key = getInputString(input, "key");
          if (key) {
            const path = `${MEMORY_DIR}/${normalizeMemoryKey(key)}.md`;
            const content = await workspace.readFile(path);
            return content ?? `Error: no memory found at ${path}`;
          }

          const entries = await listMemoryEntries(workspace);
          return entries.map((entry) => entry.path).join("\n") || "(no saved memories)";
        },
      ),
    ],
    [
      "save_handoff",
      buildTool(
        {
          name: "save_handoff",
          description: "Save a structured handoff artifact for later agents or container sessions.",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", description: "Handoff kind, such as research, plan, or review" },
              goal: { type: "string", description: "The main goal or task the handoff covers" },
              summary: { type: "string", description: "A concise summary of the work completed" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Key findings as an array of strings",
              },
              relevantFiles: {
                type: "array",
                items: { type: "string" },
                description: "Relevant file paths",
              },
              openQuestions: {
                type: "array",
                items: { type: "string" },
                description: "Open questions or uncertainties",
              },
              proposedPlan: { type: "string", description: "Suggested next-step plan" },
              memoryRefs: {
                type: "array",
                items: { type: "string" },
                description: "Related memory keys or references",
              },
              threadId: { type: "string", description: "Optional thread id for grouping related plan artifacts" },
              parentId: { type: "string", description: "Optional parent handoff id for reviews or revisions" },
              artifactType: { type: "string", description: "Optional artifact type, such as draft or review" },
              status: { type: "string", description: "Optional status, such as draft or approved" },
              model: { type: "string", description: "Optional model identifier used to produce this artifact" },
              repoId: { type: "string", description: "Optional repository id associated with this artifact" },
              repoUrl: { type: "string", description: "Optional repository URL associated with this artifact" },
              repoRevisionId: { type: "string", description: "Optional repository revision associated with this artifact" },
              createdBy: { type: "string", description: "Optional agent or author name" },
            },
            required: ["kind", "goal", "summary", "proposedPlan"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const kind = getInputString(input, "kind");
          const goal = getInputString(input, "goal");
          const summary = getInputString(input, "summary");
          const proposedPlan = getInputString(input, "proposedPlan");

          if (!kind || !goal || !summary || !proposedPlan) {
            return "Error: kind, goal, summary, and proposedPlan are required";
          }

          const artifact = await saveHandoff(workspace, {
            kind,
            goal,
            summary,
            findings: getInputStringArray(input, "findings") ?? [],
            relevantFiles: getInputStringArray(input, "relevantFiles") ?? [],
            openQuestions: getInputStringArray(input, "openQuestions") ?? [],
            proposedPlan,
            memoryRefs: getInputStringArray(input, "memoryRefs") ?? [],
            threadId: getInputString(input, "threadId"),
            parentId: getInputString(input, "parentId"),
            artifactType: getInputString(input, "artifactType") as "draft" | "review" | undefined,
            status: getInputString(input, "status") as "draft" | "approved" | "superseded" | "discarded" | undefined,
            model: getInputString(input, "model"),
            repoId: getInputString(input, "repoId") ?? handoffDefaults.repoId,
            repoUrl: getInputString(input, "repoUrl") ?? handoffDefaults.repoUrl,
            repoRevisionId: getInputString(input, "repoRevisionId") ?? handoffDefaults.repoRevisionId ?? null,
            createdBy: getInputString(input, "createdBy") ?? "research",
          });

          return `Saved handoff ${formatHandoffSummary(artifact.id, artifact.goal, artifact.summary)}`;
        },
      ),
    ],
    [
      "read_handoff",
      buildTool(
        {
          name: "read_handoff",
          description: "Read a previously saved handoff artifact by id.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Handoff id" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        async (input) => {
          const id = getInputString(input, "id");
          if (!id) return "Error: id is required";

          const artifact = await readHandoff(workspace, id);
          if (!artifact) return `Error: no handoff found with id ${id}`;
          return JSON.stringify(artifact, null, 2);
        },
      ),
    ],
    [
      "list_handoffs",
      buildTool(
        {
          name: "list_handoffs",
          description: "List recently saved handoff artifacts.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        async () => {
          const handoffs = await listHandoffs(workspace);
          return handoffs.map((artifact) => formatHandoffSummary(artifact.id, artifact.goal, artifact.summary)).join("\n")
            || "(no saved handoffs)";
        },
      ),
    ],
  ]);
}

export function getHostedToolsForAgent(
  registry: Map<HostedToolName, HostedTool>,
  spec: AgentSpec,
): HostedTool[] {
  return spec.toolNames.map((name) => {
    const tool = registry.get(name);
    if (!tool) {
      throw new Error(`Hosted tool is not registered: ${name}`);
    }
    return tool;
  });
}

export function toResponseToolDefinitions(tools: HostedTool[]): ResponseToolDefinition[] {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: tool.definition.parameters,
  }));
}

export function toAiSdkTools(tools: HostedTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((hostedTool) => [
      hostedTool.definition.name,
      tool({
        description: hostedTool.definition.description,
        inputSchema: jsonSchema(hostedTool.definition.parameters as any),
        execute: async (input) => hostedTool.execute((input ?? {}) as Record<string, unknown>),
      }),
    ]),
  );
}

export async function executeHostedTool(
  registry: Map<HostedToolName, HostedTool>,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = registry.get(name as HostedToolName);
  if (!tool) {
    return `Unknown tool: ${name}`;
  }

  return tool.execute(input);
}
