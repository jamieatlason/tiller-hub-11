export type RuntimeKind = "direct-tools" | "codemode" | "container";

export type ModelProviderKind = "external-codex" | "workers-ai";

export type HostedToolName =
  | "read_file"
  | "write_file"
  | "list_files"
  | "glob"
  | "save_memory"
  | "recall_memory"
  | "save_handoff"
  | "read_handoff"
  | "list_handoffs";

export type ToolInputValue = string | number | boolean | null;

export type ToolParameterProperty =
  | { type: "string"; description: string }
  | { type: "array"; description: string; items: { type: "string" } };

export type ToolParameters = {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required: string[];
  additionalProperties: false;
};

export type Awaitable<T> = T | Promise<T>;

export interface WorkspaceEntry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt?: number;
}

export interface WorkspaceInfo {
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  r2FileCount?: number;
}

export interface WorkspaceToolAccess {
  readFile(path: string): Awaitable<string | null>;
  writeFile(path: string, content: string): Awaitable<void>;
  readDir(path?: string): Awaitable<WorkspaceEntry[]>;
  glob(pattern: string): Awaitable<WorkspaceEntry[]>;
}

export interface WorkspaceContextAccess extends WorkspaceToolAccess {
  getWorkspaceInfo(): Awaitable<WorkspaceInfo>;
}

export interface HostedToolDefinition {
  name: HostedToolName;
  description: string;
  parameters: ToolParameters;
}

export interface HostedTool {
  definition: HostedToolDefinition;
  execute(input: Record<string, unknown>): Promise<string>;
}

export interface ModelTarget {
  provider: ModelProviderKind;
  envModelKey?: "OPENAI_MODEL";
  defaultModel?: string;
}

export type HostedAgentId =
  | "plan-chat"
  | "research-chat"
  | "planner-chat"
  | "reviewer-chat"
  | "cartographer-chat";

export interface HostedAgentMetadata {
  id: HostedAgentId;
  name: string;
  label: string;
  runtime: RuntimeKind;
  provider: ModelProviderKind;
  model: string;
}

export interface AgentSpec {
  name: string;
  runtime: RuntimeKind;
  modelTarget: ModelTarget;
  toolNames: HostedToolName[];
  baseInstructions: string;
  maxSteps?: number;
  includeProjectContext?: boolean;
  includeMemories?: boolean;
  includeHandoffs?: boolean;
  injectWorkspaceSummary?: boolean;
  maxMemoryFiles?: number;
  maxHandoffs?: number;
  maxContextChars?: number;
}

export interface PlanReviewIssue {
  issue: string;
  evidenceQuote: string;
  recommendedChange: string;
}

export interface PlanReviewIssueStats {
  total: number;
  kept: number;
  dropped: number;
}

export interface PlanReviewMeta {
  toolCallCount: number;
  finishReason?: string;
  truncated?: boolean;
  warningCount?: number;
  repaired?: boolean;
  retriedForToolUse?: boolean;
}

export interface HandoffArtifact {
  id: string;
  kind: string;
  goal: string;
  summary: string;
  findings: string[];
  relevantFiles: string[];
  openQuestions: string[];
  proposedPlan: string;
  memoryRefs: string[];
  createdBy: string;
  createdAt: string;
  threadId?: string;
  parentId?: string;
  artifactType?: "draft" | "review";
  status?: "draft" | "approved" | "superseded" | "discarded";
  model?: string;
  repoId?: string;
  repoUrl?: string;
  repoRevisionId?: string | null;
  legacyRevision?: boolean;
  approvedAt?: string;
  reviewIssues?: PlanReviewIssue[];
  reviewIssueStats?: PlanReviewIssueStats;
  reviewMeta?: PlanReviewMeta;
}
