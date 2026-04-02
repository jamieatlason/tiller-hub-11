import { describe, expect, it } from "vitest";
import { reconcileWorkspaceTarballs } from "../reconcile";
import { buildTar, readTarEntries } from "../../workspace/tar";

describe("reconcileWorkspaceTarballs", () => {
  it("merges non-overlapping text changes", async () => {
    const baseTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("one\ntwo\n") },
    ]);
    const localTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("zero\none\ntwo\n") },
    ]);
    const remoteTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("one\ntwo\nthree\n") },
    ]);

    const result = await reconcileWorkspaceTarballs({
      baseTar,
      localTar,
      remoteTar,
      localLabel: "env demo",
      baseLabel: "repo v1",
      remoteLabel: "repo v2",
    });

    expect(result.unsupportedPaths).toEqual([]);
    expect(result.conflictPaths).toEqual([]);
    const mergedReadme = new TextDecoder().decode(readTarEntries(result.mergedTar).get("/README.md")!);
    expect(mergedReadme).toBe("zero\none\ntwo\nthree\n");
    expect(result.mergedEqualsRemote).toBe(false);
  });

  it("writes diff3 markers for overlapping text changes", async () => {
    const baseTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("one\ntwo\n") },
    ]);
    const localTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("one\nlocal\n") },
    ]);
    const remoteTar = await buildTar([
      { path: "/README.md", content: new TextEncoder().encode("one\nremote\n") },
    ]);

    const result = await reconcileWorkspaceTarballs({
      baseTar,
      localTar,
      remoteTar,
      localLabel: "env demo",
      baseLabel: "repo v1",
      remoteLabel: "repo v2",
    });

    expect(result.unsupportedPaths).toEqual([]);
    expect(result.conflictPaths).toEqual(["/README.md"]);
    const mergedReadme = new TextDecoder().decode(readTarEntries(result.mergedTar).get("/README.md")!);
    expect(mergedReadme).toContain("<<<<<<< env demo");
    expect(mergedReadme).toContain("||||||| repo v1");
    expect(mergedReadme).toContain(">>>>>>> repo v2");
  });
});
