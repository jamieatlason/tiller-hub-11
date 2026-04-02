import { mergeDiff3 } from "node-diff3";
import { buildTar, readTarEntries, type TarEntry } from "../workspace/tar";

export const RECONCILE_REPORT_PATH = "/.tiller/reconcile.json";

export interface ReconcileReport {
  baseVersion: number;
  currentVersion: number;
  conflictPaths: string[];
  createdAt: string;
}

export interface ReconcileTarResult {
  conflictPaths: string[];
  mergedEqualsRemote: boolean;
  mergedTar: Uint8Array;
  unsupportedPaths: string[];
}

function buffersEqual(left?: Uint8Array | null, right?: Uint8Array | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hasUnresolvedMarkers(content: string): boolean {
  return /^<{7}(?: |$)|^\|{7}(?: |$)|^={7}$|^>{7}(?: |$)/m.test(content);
}

export function contentHasConflictMarkers(content: string): boolean {
  return hasUnresolvedMarkers(content);
}

function mergeTextContents(args: {
  base: string;
  local: string;
  remote: string;
  localLabel: string;
  baseLabel: string;
  remoteLabel: string;
}): { conflict: boolean; content: Uint8Array } {
  const result = mergeDiff3(
    splitLines(args.local),
    splitLines(args.base),
    splitLines(args.remote),
    {
      excludeFalseConflicts: true,
      label: {
        a: args.localLabel,
        o: args.baseLabel,
        b: args.remoteLabel,
      },
    },
  );

  return {
    conflict: result.conflict,
    content: encodeText(result.result.join("")),
  };
}

export async function reconcileWorkspaceTarballs(args: {
  baseTar: Uint8Array;
  localTar: Uint8Array;
  remoteTar: Uint8Array;
  localLabel: string;
  baseLabel: string;
  remoteLabel: string;
}): Promise<ReconcileTarResult> {
  const baseEntries = readTarEntries(args.baseTar);
  const localEntries = readTarEntries(args.localTar);
  const remoteEntries = readTarEntries(args.remoteTar);
  const paths = new Set<string>([
    ...baseEntries.keys(),
    ...localEntries.keys(),
    ...remoteEntries.keys(),
  ]);

  const mergedEntries = new Map<string, Uint8Array>();
  const conflictPaths: string[] = [];
  const unsupportedPaths: string[] = [];
  let mergedEqualsRemote = true;

  for (const path of Array.from(paths).sort((left, right) => left.localeCompare(right))) {
    const base = baseEntries.get(path);
    const local = localEntries.get(path);
    const remote = remoteEntries.get(path);

    if (buffersEqual(local, remote)) {
      if (local) mergedEntries.set(path, local);
      continue;
    }

    if (buffersEqual(base, local)) {
      if (remote) mergedEntries.set(path, remote);
      else mergedEntries.delete(path);
      continue;
    }

    if (buffersEqual(base, remote)) {
      if (local) {
        mergedEntries.set(path, local);
        mergedEqualsRemote = false;
      } else {
        mergedEntries.delete(path);
        mergedEqualsRemote = false;
      }
      continue;
    }

    const baseText = base ? decodeText(base) : "";
    const localText = local ? decodeText(local) : "";
    const remoteText = remote ? decodeText(remote) : "";
    if (baseText === null || localText === null || remoteText === null) {
      unsupportedPaths.push(path);
      mergedEqualsRemote = false;
      continue;
    }

    const merged = mergeTextContents({
      base: baseText,
      local: localText,
      remote: remoteText,
      localLabel: args.localLabel,
      baseLabel: args.baseLabel,
      remoteLabel: args.remoteLabel,
    });
    if (merged.content.length > 0) {
      mergedEntries.set(path, merged.content);
    } else {
      mergedEntries.delete(path);
    }
    if (merged.conflict) {
      conflictPaths.push(path);
    }
    if (!buffersEqual(merged.content, remote ?? null) || (remote === undefined && merged.content.length > 0)) {
      mergedEqualsRemote = false;
    }
  }

  const mergedTar = await buildTar(
    Array.from(mergedEntries.entries()).map(([path, content]): TarEntry => ({ path, content })),
  );

  return {
    conflictPaths,
    mergedEqualsRemote,
    mergedTar,
    unsupportedPaths,
  };
}

export async function readReconcileReport(
  workspace: {
    readWorkspaceFile(path: string): Promise<string | null>;
  },
): Promise<ReconcileReport | null> {
  const raw = await workspace.readWorkspaceFile(RECONCILE_REPORT_PATH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReconcileReport;
    return Array.isArray(parsed.conflictPaths) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeReconcileReport(
  workspace: {
    writeWorkspaceFile(path: string, content: string): Promise<void>;
  },
  report: ReconcileReport,
): Promise<void> {
  await workspace.writeWorkspaceFile(RECONCILE_REPORT_PATH, JSON.stringify(report, null, 2));
}

export async function clearReconcileReport(
  workspace: {
    deleteWorkspaceFile(path: string): Promise<boolean>;
  },
): Promise<void> {
  await workspace.deleteWorkspaceFile(RECONCILE_REPORT_PATH);
}

export async function countUnresolvedReconcileConflicts(
  workspace: {
    batchReadWorkspaceFiles(paths: string[]): Promise<{ path: string; content: string | null }[]>;
    readWorkspaceFile(path: string): Promise<string | null>;
  },
): Promise<number> {
  const report = await readReconcileReport(workspace);
  if (!report || report.conflictPaths.length === 0) return 0;

  const files = await workspace.batchReadWorkspaceFiles(report.conflictPaths);
  return files.reduce((count, file) => (
    file.content && hasUnresolvedMarkers(file.content) ? count + 1 : count
  ), 0);
}
