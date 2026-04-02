import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// Cloudflare Container DO for sandboxed Claude Code environments.
// Workspace state now lives in WorkspaceDO so this class only manages
// container lifecycle and terminal proxy behavior.

export class SandboxDO extends Container<Env> {
  defaultPort = 7681;

  async startSandbox(envVars: Record<string, string>): Promise<void> {
    this.start({ envVars, enableInternet: true }).catch((err) => {
      console.error("[sandbox] Container start failed:", err);
    });
  }

  async stopSandbox(): Promise<void> {
    await this.stop();
  }

  async destroySandbox(): Promise<void> {
    await this.ctx.container!.destroy();
  }

  async getStatus(): Promise<string> {
    return this.ctx.container!.running ? "started" : "stopped";
  }
}
