import type { Env } from "../types";
import type { ToolParameters } from "./types";
import { getSecret } from "../setup/config";
import { readActiveLocalRunnerConfig } from "../local-runner-config";

export interface ResponseToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ResponseTextContent {
  type: "output_text";
  text: string;
}

export interface ResponseMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: Array<
    | { type: "input_text"; text: string }
    | ResponseTextContent
    | { type: string; [key: string]: unknown }
  >;
}

export interface ResponseFunctionCallItem {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseOutputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | { type: string; [key: string]: unknown };

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponseOutputItem
  | ResponseFunctionCallOutputItem;

interface CodexRequestConfig {
  url: string;
  headers: Headers;
  body: string;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFunctionCallItem(item: ResponseOutputItem): item is ResponseFunctionCallItem {
  return item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string";
}

export function extractSseOutputItem(payload: unknown): ResponseOutputItem | null {
  if (!isRecord(payload) || !isRecord(payload.item) || typeof payload.item.type !== "string") {
    return null;
  }

  return payload.item as ResponseOutputItem;
}

export function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) yield parsed;
      }
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSseBlock(part);
      if (parsed) yield parsed;
    }
  }
}

export function parseCompletedOutput(payload: unknown): ResponseOutputItem[] | null {
  if (!isRecord(payload) || !isRecord(payload.response) || !Array.isArray(payload.response.output)) {
    return null;
  }

  return payload.response.output as ResponseOutputItem[];
}

export function parseErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;

  if (typeof payload.message === "string") return payload.message;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;

  const response = isRecord(payload.response) ? payload.response : null;
  if (response && isRecord(response.error) && typeof response.error.message === "string") {
    return response.error.message;
  }

  return fallback;
}

export function buildCodexRequestBody(
  model: string,
  input: ResponseInputItem[],
  systemPrompt: string,
  tools: ResponseToolDefinition[],
): string {
  return JSON.stringify({
    model,
    store: false,
    stream: true,
    parallel_tool_calls: false,
    instructions: systemPrompt,
    input,
    tools,
  });
}

export async function buildCodexRequestConfig(
  env: Env,
  accessToken: string,
  accountId: string | null,
  chatSessionId: string,
  body: string,
): Promise<CodexRequestConfig> {
  const configuredRelayUrl = await getSecret(env, "RESEARCH_RELAY_URL");
  const activeConfig = configuredRelayUrl ? null : await readActiveLocalRunnerConfig(env);
  const researchRelayUrl = configuredRelayUrl ?? activeConfig?.relayUrl ?? null;

  if (researchRelayUrl) {
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-OpenAI-Access-Token": accessToken,
      "X-Originator": "opencode",
      "X-User-Agent": "opencode/tiller-hub",
      "X-Session-Id": chatSessionId,
    });

    const relayToken = await getSecret(env, "RESEARCH_RELAY_TOKEN");
    if (relayToken) {
      headers.set("Authorization", `Bearer ${relayToken}`);
    }

    const cfClientId = await getSecret(env, "CF_ACCESS_CLIENT_ID");
    if (cfClientId) {
      headers.set("CF-Access-Client-Id", cfClientId);
    }

    const cfClientSecret = await getSecret(env, "CF_ACCESS_CLIENT_SECRET");
    if (cfClientSecret) {
      headers.set("CF-Access-Client-Secret", cfClientSecret);
    }

    if (accountId) {
      headers.set("X-ChatGPT-Account-Id", accountId);
    }

    return {
      url: researchRelayUrl,
      headers,
      body,
    };
  }

  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    originator: "opencode",
    "User-Agent": "opencode/tiller-hub",
    session_id: chatSessionId,
  });

  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  return {
    url: CODEX_RESPONSES_URL,
    headers,
    body,
  };
}
