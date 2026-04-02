import type { Env } from "../../types";
import {
  buildCodexRequestBody,
  buildCodexRequestConfig,
  extractSseOutputItem,
  isFunctionCallItem,
  parseCompletedOutput,
  parseErrorMessage,
  parseToolInput,
  readSseEvents,
  type ResponseFunctionCallItem,
  type ResponseFunctionCallOutputItem,
  type ResponseInputItem,
  type ResponseOutputItem,
  type ResponseToolDefinition,
} from "../codex";
import { executeHostedTool } from "../tools";
import type { AgentSpec, HostedTool, HostedToolName } from "../types";

const MAX_TOOL_OUTPUT_CHARS = 50_000;

type DirectToolsEnv = Env;

export interface DirectToolRuntimeHooks {
  onTextStart?(): void | Promise<void>;
  onTextDelta?(delta: string): void | Promise<void>;
  onToolStart?(call: ResponseFunctionCallItem): void | Promise<void>;
  onToolExecuting?(call: ResponseFunctionCallItem, input: Record<string, unknown>): void | Promise<void>;
  onToolResult?(
    call: ResponseFunctionCallItem,
    input: Record<string, unknown>,
    result: string,
  ): void | Promise<void>;
  onAssistantTurn?(output: ResponseOutputItem[]): void | Promise<void>;
  onToolTurn?(toolOutputs: ResponseFunctionCallOutputItem[]): void | Promise<void>;
  onDone?(): void | Promise<void>;
}

export interface RunDirectToolsRuntimeParams {
  env: DirectToolsEnv;
  spec: AgentSpec;
  accessToken: string;
  accountId: string | null;
  model: string;
  systemPrompt: string;
  responseTools: ResponseToolDefinition[];
  toolRegistry: Map<HostedToolName, HostedTool>;
  initialInput: ResponseInputItem[];
  requestId?: string;
  hooks?: DirectToolRuntimeHooks;
}

function truncateToolResult(result: string): string {
  return result.length > MAX_TOOL_OUTPUT_CHARS
    ? `${result.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...(truncated)`
    : result;
}

export async function runDirectToolsRuntime({
  env,
  spec,
  accessToken,
  accountId,
  model,
  systemPrompt,
  responseTools,
  toolRegistry,
  initialInput,
  requestId = crypto.randomUUID(),
  hooks,
}: RunDirectToolsRuntimeParams): Promise<ResponseInputItem[]> {
  const input = [...initialInput];
  const maxSteps = spec.maxSteps ?? 25;

  for (let step = 0; step < maxSteps; step += 1) {
    const body = buildCodexRequestBody(model, input, systemPrompt, responseTools);
    const request = await buildCodexRequestConfig(env, accessToken, accountId, requestId, body);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    if (response.status === 401) {
      throw new Error("OpenAI auth expired — re-seed tokens");
    }

    if (!response.ok) {
      const text = (await response.text()).trim();
      const detail = text ? ` — ${text.slice(0, 500)}` : "";
      throw new Error(`Codex request failed: ${response.status}${detail}`);
    }

    if (!response.body) {
      throw new Error("Codex request failed: empty response body");
    }

    let completedOutput: ResponseOutputItem[] | null = null;
    let textStarted = false;
    const announcedToolIds = new Set<string>();

    for await (const event of readSseEvents(response.body)) {
      if (event.data === "[DONE]") continue;

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        throw new Error("Codex stream returned invalid JSON");
      }

      switch (event.event) {
        case "response.output_item.added":
        case "response.output_item.done": {
          const item = extractSseOutputItem(payload);
          if (!item) break;

          if (item.type === "message" && !textStarted) {
            textStarted = true;
            await hooks?.onTextStart?.();
          }

          if (isFunctionCallItem(item) && !announcedToolIds.has(item.call_id)) {
            announcedToolIds.add(item.call_id);
            await hooks?.onToolStart?.(item);
          }
          break;
        }
        case "response.output_text.delta":
          if (payload && typeof payload === "object" && "delta" in payload && typeof payload.delta === "string") {
            if (!textStarted) {
              textStarted = true;
              await hooks?.onTextStart?.();
            }

            await hooks?.onTextDelta?.(payload.delta);
          }
          break;
        case "response.completed":
          completedOutput = parseCompletedOutput(payload);
          break;
        case "response.failed":
        case "error":
          throw new Error(parseErrorMessage(payload, "Codex request failed"));
      }
    }

    if (!completedOutput) {
      throw new Error("Codex stream ended without response.completed");
    }

    input.push(...completedOutput);
    await hooks?.onAssistantTurn?.(completedOutput);

    const functionCalls = completedOutput.filter(isFunctionCallItem);
    if (functionCalls.length === 0) {
      await hooks?.onDone?.();
      return input;
    }

    const toolOutputs: ResponseFunctionCallOutputItem[] = [];
    for (const call of functionCalls) {
      const parsedInput = parseToolInput(call.arguments);
      await hooks?.onToolExecuting?.(call, parsedInput);
      const result = await executeHostedTool(toolRegistry, call.name, parsedInput);
      const truncated = truncateToolResult(result);
      await hooks?.onToolResult?.(call, parsedInput, truncated);
      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: truncated,
      });
    }

    input.push(...toolOutputs);
    await hooks?.onToolTurn?.(toolOutputs);
  }

  throw new Error(`Agent ${spec.name} exceeded maxSteps (${spec.maxSteps ?? 25})`);
}
