import type { EnvMeta } from "../api/types";

/**
 * Apply an env-status-changed WS message to the env list.
 * When message is present: only update bootMessage (don't override Fly status).
 * When message is absent: update status, clear bootMessage on terminal states.
 */
export function applyEnvStatusChange(
  envs: EnvMeta[],
  slug: string,
  status: string,
  message?: string,
): EnvMeta[] {
  if (status === "deleted") {
    return envs.filter((e) => e.slug !== slug);
  }
  return envs.map((e) => {
    if (e.slug !== slug) return e;
    if (message) {
      return { ...e, bootMessage: message };
    }
    const clearBoot = status === "stopped" || status === "destroyed" || status === "failed";
    return { ...e, status, bootMessage: clearBoot ? undefined : e.bootMessage };
  });
}

/**
 * Merge fresh env list from REST API with existing bootMessages.
 * REST API doesn't return bootMessage, so carry it over from previous state.
 */
export function mergeEnvsPreservingBootMessages(
  freshEnvs: EnvMeta[],
  prevEnvs: EnvMeta[],
): EnvMeta[] {
  const bootMessages = new Map(prevEnvs.map((e) => [e.slug, e.bootMessage]));
  return freshEnvs.map((e) => ({ ...e, bootMessage: bootMessages.get(e.slug) }));
}
