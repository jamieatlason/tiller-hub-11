import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { AgentContext } from "agents";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type StreamTextOnFinishCallback,
  type UIMessage,
} from "ai";
import {
  buildSystemPrompt,
  createHostedToolRegistry,
  createWorkspaceAccess,
  getAgentSpec,
  getHostedToolsForAgent,
  resolveAgentAuth,
  resolveAgentModel,
  runDirectToolsRuntime,
  toResponseToolDefinitions,
  type ResponseInputItem,
  type ResponseMessageItem,
} from "../agent-core";
import { ensureRepoWorkspaceFromRepoUrl } from "../plan/store";
import type { Env } from "../types";
import { resolvePlanModel } from "../plan/workflow";

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function buildUserInput(message: UIMessage): ResponseMessageItem | null {
  const text = message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("");

  if (!text) return null;

  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function buildAssistantInputs(message: UIMessage): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) return;
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: textBuffer }],
    });
    textBuffer = "";
  };

  for (const part of message.parts) {
    if (isTextUIPart(part)) {
      textBuffer += part.text;
      continue;
    }

    if (!isToolUIPart(part)) {
      continue;
    }

    flushText();

    const toolName = getToolName(part);
    items.push({
      type: "function_call",
      name: toolName,
      call_id: part.toolCallId,
      arguments: JSON.stringify(part.input ?? {}),
    });

    if (part.state === "output-available") {
      items.push({
        type: "function_call_output",
        call_id: part.toolCallId,
        output: serializeToolOutput(part.output),
      });
    } else if (part.state === "output-error") {
      items.push({
        type: "function_call_output",
        call_id: part.toolCallId,
        output: part.errorText,
      });
    }
  }

  flushText();
  return items;
}

function buildResponseInput(messages: UIMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const userInput = buildUserInput(message);
      if (userInput) input.push(userInput);
      continue;
    }

    if (message.role === "assistant") {
      input.push(...buildAssistantInputs(message));
    }
  }

  return input;
}

function getPlanRepoUrl(
  agentName: string,
  options?: OnChatMessageOptions,
): string {
  const body = (options?.body as { repoUrl?: unknown } | undefined) ?? {};
  if (typeof body.repoUrl === "string" && body.repoUrl.trim()) {
    return body.repoUrl.trim();
  }

  return agentName;
}

export class PlanChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  declare readonly name: string;
  private readonly appEnv: Env;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.appEnv = env;
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<any>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const spec = getAgentSpec("plan");
    const auth = await resolveAgentAuth(this.appEnv, spec);
    if (!auth.accessToken) {
      throw new Error("Plan agent requires OpenAI auth");
    }

    const repoUrl = getPlanRepoUrl(this.name, options);
    const repo = await ensureRepoWorkspaceFromRepoUrl(this.appEnv, repoUrl);
    const workspace = createWorkspaceAccess(repo.workspace);
    const toolRegistry = createHostedToolRegistry(workspace, {
      handoffDefaults: {
        repoId: repo.meta.repoId,
        repoUrl,
        repoRevisionId: repo.meta.currentRevisionId,
      },
    });
    const tools = getHostedToolsForAgent(toolRegistry, spec);
    const responseTools = toResponseToolDefinitions(tools);
    const selectedModel = resolvePlanModel((options?.body as { selectedModel?: unknown } | undefined)?.selectedModel);
    const baseSystemPrompt = await buildSystemPrompt(spec, workspace);
    const systemPrompt = `${baseSystemPrompt}\n\nRepository URL: ${repoUrl}\nRepository ID: ${repo.meta.repoId}\nRepository revision: ${repo.meta.currentRevisionId}\nSelected planner model: ${selectedModel}`;
    const requestId = crypto.randomUUID();

    const stream = createUIMessageStream({
      originalMessages: this.messages,
      execute: async ({ writer }) => {
        let activeTextId: string | null = null;

        const ensureTextStart = () => {
          if (!activeTextId) {
            activeTextId = `text-${crypto.randomUUID()}`;
            writer.write({ type: "text-start", id: activeTextId });
          }
        };

        const pushText = (delta: string) => {
          ensureTextStart();
          writer.write({ type: "text-delta", id: activeTextId!, delta });
        };

        const endText = () => {
          if (!activeTextId) return;
          writer.write({ type: "text-end", id: activeTextId });
          activeTextId = null;
        };

        try {
          await runDirectToolsRuntime({
            env: this.appEnv,
            spec,
            accessToken: auth.accessToken,
            accountId: auth.accountId,
            model: resolveAgentModel(this.appEnv, spec, selectedModel),
            systemPrompt,
            responseTools,
            toolRegistry,
            initialInput: buildResponseInput(this.messages),
            requestId,
            hooks: {
              onTextStart: ensureTextStart,
              onTextDelta: pushText,
              onToolExecuting: (call, input) => {
                writer.write({
                  type: "tool-input-available",
                  toolCallId: call.call_id,
                  toolName: call.name,
                  input,
                });
              },
              onToolResult: (call, _input, result) => {
                writer.write({
                  type: "tool-output-available",
                  toolCallId: call.call_id,
                  output: result,
                });
              },
            },
          });
        } finally {
          endText();
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  }
}

export const PLAN_CHAT_AGENT_PATH = "plan-chat";
