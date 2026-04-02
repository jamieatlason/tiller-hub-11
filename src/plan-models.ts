export const PLAN_DEFAULT_MODEL = "gpt-5.4";

export const PLAN_MODEL_OPTIONS = [
  { id: "gpt-5.4", label: "ChatGPT 5.4" },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 120B" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
] as const;

export type PlanModelId = (typeof PLAN_MODEL_OPTIONS)[number]["id"];

export function isPlanModelId(value: string | null): value is PlanModelId {
  return PLAN_MODEL_OPTIONS.some((option) => option.id === value);
}

export function getPlanModelLabel(id: string | undefined): string {
  return PLAN_MODEL_OPTIONS.find((option) => option.id === id)?.label ?? id ?? "Unknown model";
}
