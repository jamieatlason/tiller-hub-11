import type { WorkspaceDO } from "../workspace/do";
import type { WorkspaceContextAccess, WorkspaceEntry, WorkspaceInfo } from "./types";

export type WorkspaceStub = Pick<
  WorkspaceDO,
  | "readWorkspaceFile"
  | "writeWorkspaceFile"
  | "readWorkspaceDir"
  | "globWorkspace"
  | "getWorkspaceInfo"
>;

export function createWorkspaceAccess(stub: WorkspaceStub): WorkspaceContextAccess {
  return {
    readFile(path: string) {
      return stub.readWorkspaceFile(path);
    },
    writeFile(path: string, content: string) {
      return stub.writeWorkspaceFile(path, content);
    },
    readDir(path?: string): Promise<WorkspaceEntry[]> {
      return Promise.resolve(stub.readWorkspaceDir(path) as unknown as WorkspaceEntry[]);
    },
    glob(pattern: string): Promise<WorkspaceEntry[]> {
      return Promise.resolve(stub.globWorkspace(pattern) as unknown as WorkspaceEntry[]);
    },
    getWorkspaceInfo(): Promise<WorkspaceInfo> {
      return Promise.resolve(stub.getWorkspaceInfo() as unknown as WorkspaceInfo);
    },
  };
}

function usesPlanStore(pathOrPattern: string | undefined): boolean {
  if (!pathOrPattern) return false;
  return pathOrPattern === "/.tiller/handoffs"
    || pathOrPattern.startsWith("/.tiller/handoffs/")
    || pathOrPattern.includes(".tiller/handoffs");
}

export function createPlanWorkspaceAccess(
  fileStub: WorkspaceStub,
  planStub: WorkspaceStub,
): WorkspaceContextAccess {
  return {
    readFile(path: string) {
      return usesPlanStore(path)
        ? planStub.readWorkspaceFile(path)
        : fileStub.readWorkspaceFile(path);
    },
    writeFile(path: string, content: string) {
      return usesPlanStore(path)
        ? planStub.writeWorkspaceFile(path, content)
        : fileStub.writeWorkspaceFile(path, content);
    },
    readDir(path?: string): Promise<WorkspaceEntry[]> {
      const stub = usesPlanStore(path) ? planStub : fileStub;
      return Promise.resolve(stub.readWorkspaceDir(path) as unknown as WorkspaceEntry[]);
    },
    glob(pattern: string): Promise<WorkspaceEntry[]> {
      const stub = usesPlanStore(pattern) ? planStub : fileStub;
      return Promise.resolve(stub.globWorkspace(pattern) as unknown as WorkspaceEntry[]);
    },
    getWorkspaceInfo(): Promise<WorkspaceInfo> {
      return Promise.resolve(fileStub.getWorkspaceInfo() as unknown as WorkspaceInfo);
    },
  };
}
