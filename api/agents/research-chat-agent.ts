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
  type WorkspaceStub,
} from "../agent-core";
import { getWorkspaceStub } from "../helpers";
import type { Env } from "../types";

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

export class ResearchChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  declare readonly name: string;
  private readonly appEnv: Env;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.appEnv = env;
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<any>,
    _options?: OnChatMessageOptions,
  ): Promise<Response> {
    const spec = getAgentSpec("research");
    const auth = await resolveAgentAuth(this.appEnv, spec);
    const accessToken = auth.accessToken;
    if (!accessToken) {
      throw new Error("Research agent requires OpenAI auth");
    }

    const workspaceStub = getWorkspaceStub(this.appEnv, this.name);
    const workspace = createWorkspaceAccess(workspaceStub);
    const toolRegistry = createHostedToolRegistry(workspace);
    const tools = getHostedToolsForAgent(toolRegistry, spec);
    const responseTools = toResponseToolDefinitions(tools);
    const systemPrompt = await buildSystemPrompt(spec, workspace);
    const model = resolveAgentModel(this.appEnv, spec);
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
            accessToken,
            accountId: auth.accountId,
            model,
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

export const RESEARCH_CHAT_AGENT_PATH = "research-chat";
