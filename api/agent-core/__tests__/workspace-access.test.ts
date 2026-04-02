import { describe, expect, it } from "vitest";
import { createPlanWorkspaceAccess, type WorkspaceStub } from "../workspace-access";

function createStub() {
  const files = new Map<string, string>();

  const stub: WorkspaceStub = {
    async readWorkspaceFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeWorkspaceFile(path: string, content: string) {
      files.set(path, content);
    },
    readWorkspaceDir(path = "/") {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Array.from(files.entries())
        .filter(([filePath]) => filePath.startsWith(prefix))
        .map(([filePath, content]) => ({
          path: filePath,
          size: content.length,
          type: "file" as const,
          updatedAt: Date.now(),
        }));
    },
    globWorkspace() {
      return Array.from(files.entries()).map(([path, content]) => ({
        path,
        size: content.length,
        type: "file" as const,
        updatedAt: Date.now(),
      }));
    },
    getWorkspaceInfo() {
      return {
        fileCount: files.size,
        directoryCount: 1,
        totalBytes: Array.from(files.values()).reduce((sum, content) => sum + content.length, 0),
        r2FileCount: 0,
      };
    },
  };

  return { files, stub };
}

describe("createPlanWorkspaceAccess", () => {
  it("routes handoff files to the repo plan store and normal files to the env workspace", async () => {
    const fileWorkspace = createStub();
    const planWorkspace = createStub();
    const access = createPlanWorkspaceAccess(fileWorkspace.stub, planWorkspace.stub);

    await access.writeFile("/src/app.ts", "console.log('app')");
    await access.writeFile("/.tiller/handoffs/123.json", "{\"goal\":\"plan\"}");

    expect(fileWorkspace.files.get("/src/app.ts")).toBe("console.log('app')");
    expect(planWorkspace.files.get("/src/app.ts")).toBeUndefined();
    expect(planWorkspace.files.get("/.tiller/handoffs/123.json")).toBe("{\"goal\":\"plan\"}");
    expect(fileWorkspace.files.get("/.tiller/handoffs/123.json")).toBeUndefined();
  });
});
