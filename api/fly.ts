// Fly.io Machines API client
// Docs: https://fly.io/docs/machines/api/

const FLY_API_BASE = "https://api.machines.dev/v1";

interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  services?: Array<{
    ports: Array<{ port: number; handlers: string[] }>;
    protocol: string;
    internal_port: number;
  }>;
  guest?: { cpu_kind: string; cpus: number; memory_mb: number };
  auto_destroy?: boolean;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  instance_id: string;
  private_ip: string;
  config: FlyMachineConfig;
  created_at: string;
  updated_at: string;
}

export class FlyClient {
  constructor(
    private token: string,
    private app: string = "tiller-sandbox",
  ) {}

  private async request<T>(
    path: string,
    opts: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(`${FLY_API_BASE}/apps/${this.app}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Fly API ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async createMachine(opts: {
    name: string;
    region?: string;
    image: string;
    env: Record<string, string>;
  }): Promise<FlyMachine> {
    return this.request<FlyMachine>("/machines", {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        region: opts.region || "sjc",
        config: {
          image: opts.image,
          env: opts.env,
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
          auto_destroy: false,
          services: [
            {
              ports: [{ port: 443, handlers: ["tls", "http"] }],
              protocol: "tcp",
              internal_port: 7681,
              autostart: true,
              autostop: "off",
            },
          ],
        },
      }),
    });
  }

  async getMachine(machineId: string): Promise<FlyMachine> {
    return this.request<FlyMachine>(`/machines/${machineId}`);
  }

  async listMachines(): Promise<FlyMachine[]> {
    return this.request<FlyMachine[]>("/machines");
  }

  async startMachine(machineId: string): Promise<void> {
    await this.request(`/machines/${machineId}/start`, { method: "POST" });
  }

  async stopMachine(machineId: string): Promise<void> {
    await this.request(`/machines/${machineId}/stop`, { method: "POST" });
  }

  async waitForState(machineId: string, state: string, timeout = 60): Promise<void> {
    await this.request(`/machines/${machineId}/wait?state=${state}&timeout=${timeout}`);
  }

  async destroyMachine(machineId: string, force = false): Promise<void> {
    const qs = force ? "?force=true" : "";
    await this.request(`/machines/${machineId}${qs}`, { method: "DELETE" });
  }
}
