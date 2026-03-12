import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

const app = new Hono<{ Bindings: Env }>();

// === Provider Interface ===

interface VMCreateRequest {
  duration_minutes: number;
  size: string;
  region: string;
}

interface VMCreateResult {
  machine_id: string;
  ip: string | null;
  host: string;
  region: string;
  size: string;
  duration_minutes: number;
  expires_at: string;
  ssh_command: string;
  ssh_password: string;
}

interface VMStatusResult {
  machine_id: string;
  state: string;
  region: string;
  created_at?: string;
  updated_at?: string;
  image?: string;
}

interface VMProvider {
  create(env: Env, req: VMCreateRequest): Promise<VMCreateResult>;
  status(env: Env, machineId: string): Promise<VMStatusResult>;
  destroy(env: Env, machineId: string): Promise<void>;
  sizes: Record<string, { cpu: number; memory: number }>;
}

// === Fly.io Provider ===

const FLY_API = "https://api.machines.dev/v1";

async function flyFetch(env: Env, path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${FLY_API}/apps/${env.FLY_APP_NAME}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.FLY_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

const flyProvider: VMProvider = {
  sizes: {
    "shared-cpu-1x": { cpu: 1, memory: 256 },
    "shared-cpu-2x": { cpu: 2, memory: 512 },
    "shared-cpu-4x": { cpu: 4, memory: 1024 },
  },

  async create(env, req) {
    const sizeSpec = this.sizes[req.size];
    const durationSeconds = req.duration_minutes * 60;
    const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();

    const machineConfig = {
      name: `x402-vps-${Date.now()}`,
      region: req.region,
      config: {
        image: "ubuntu:22.04",
        guest: {
          cpu_kind: "shared",
          cpus: sizeSpec.cpu,
          memory_mb: sizeSpec.memory,
        },
        auto_destroy: true,
        restart: { policy: "no" },
        stop_config: { timeout: `${durationSeconds}s`, signal: "SIGTERM" },
        services: [
          {
            protocol: "tcp",
            internal_port: 22,
            ports: [{ port: 22, handlers: [] }],
          },
        ],
        processes: [
          {
            name: "ssh",
            entrypoint: ["/bin/bash", "-c"],
            cmd: [
              `apt-get update -qq && apt-get install -y -qq openssh-server > /dev/null 2>&1 && mkdir -p /run/sshd && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && echo 'root:x402' | chpasswd && /usr/sbin/sshd -D`,
            ],
          },
        ],
      },
    };

    const createRes = await flyFetch(env, "/machines", {
      method: "POST",
      body: JSON.stringify(machineConfig),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Fly API error: ${errText}`);
    }

    const machine: any = await createRes.json();
    const machineId = machine.id;
    let ip = machine.private_ip || null;

    // Poll for started state (up to 30s)
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await flyFetch(env, `/machines/${machineId}`);
      if (statusRes.ok) {
        const data: any = await statusRes.json();
        if (data.private_ip) ip = data.private_ip;
        if (data.state === "started" || data.state === "running") break;
      }
    }

    const sshHost = `${env.FLY_APP_NAME}.fly.dev`;

    return {
      machine_id: machineId,
      ip,
      host: sshHost,
      region: req.region,
      size: req.size,
      duration_minutes: req.duration_minutes,
      expires_at: expiresAt,
      ssh_command: `ssh root@${sshHost}`,
      ssh_password: "x402",
    };
  },

  async status(env, machineId) {
    const res = await flyFetch(env, `/machines/${machineId}`);
    if (!res.ok) {
      if (res.status === 404) throw new Error("Machine not found (may have been destroyed)");
      throw new Error(`Fly API error: ${await res.text()}`);
    }
    const machine: any = await res.json();
    return {
      machine_id: machine.id,
      state: machine.state,
      region: machine.region,
      created_at: machine.created_at,
      updated_at: machine.updated_at,
      image: machine.config?.image,
    };
  },

  async destroy(env, machineId) {
    const stopRes = await flyFetch(env, `/machines/${machineId}/stop`, { method: "POST" });
    if (stopRes.ok) await new Promise((r) => setTimeout(r, 2000));
    const deleteRes = await flyFetch(env, `/machines/${machineId}`, { method: "DELETE" });
    if (!deleteRes.ok && deleteRes.status !== 404) {
      throw new Error(`Failed to destroy: ${await deleteRes.text()}`);
    }
  },
};

// === Provider Registry ===
// Add new providers here (e.g. hetznerProvider, linodeProvider)

const providers: Record<string, VMProvider> = {
  fly: flyProvider,
};

function getProvider(env: Env): VMProvider {
  const name = env.PROVIDER || "fly";
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

// === OpenAPI spec — must be before paymentMiddleware ===

app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 VPS Service",
      description: "Time-boxed Ubuntu VMs with SSH access. Pay via x402, auto-destructs when expired. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://vps.camelai.io" }],
  },
}));

// === x402 payment gates ===

app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /create": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.50",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description:
          "Spin up a time-boxed Ubuntu VM with SSH access. Machine auto-destructs when time expires.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                duration_minutes: {
                  type: "number",
                  description: "How long the VM stays alive in minutes (1-60, default 30)",
                  required: false,
                },
                size: {
                  type: "string",
                  description:
                    'VM size: "shared-cpu-1x" (256MB), "shared-cpu-2x" (512MB), "shared-cpu-4x" (1GB). Default: shared-cpu-1x',
                  required: false,
                },
                region: {
                  type: "string",
                  description: 'Region code (default "iad"). Examples: iad, ord, lax, fra, sin',
                  required: false,
                },
              },
            },
          },
        },
      },
      "GET /status/:machine_id": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Check the current status of a VM by machine ID.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              pathFields: {
                machine_id: {
                  type: "string",
                  description: "The machine ID returned from /create",
                  required: true,
                },
              },
            },
          },
        },
      },
    })
  )
);

// === POST /create ===

app.post("/create", describeRoute({
  description: "Spin up a time-boxed Ubuntu VM with SSH access. Requires x402 payment ($0.50).",
  requestBody: {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            duration_minutes: { type: "number", description: "How long the VM stays alive in minutes (1-60, default 30)" },
            size: { type: "string", description: "VM size: shared-cpu-1x, shared-cpu-2x, shared-cpu-4x" },
            region: { type: "string", description: "Region code (default: iad)" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "VM created with SSH details", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Invalid size" },
    402: { description: "Payment required" },
    502: { description: "Failed to create VM" },
  },
}), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = getProvider(c.env);

  let duration = Number(body.duration_minutes) || 30;
  if (duration < 1) duration = 1;
  if (duration > 60) duration = 60;

  const size: string = body.size || "shared-cpu-1x";
  if (!provider.sizes[size]) {
    return c.json(
      { error: `Invalid size "${size}". Must be one of: ${Object.keys(provider.sizes).join(", ")}` },
      400
    );
  }

  const region: string = body.region || "iad";

  try {
    const result = await provider.create(c.env, { duration_minutes: duration, size, region });
    return c.json({
      ...result,
      provider: c.env.PROVIDER || "fly",
      note: "Machine will auto-destroy after the requested duration.",
    });
  } catch (err: any) {
    return c.json({ error: "Failed to create VM", details: err.message }, 502);
  }
});

// === GET /status/:machine_id ===

app.get("/status/:machine_id", describeRoute({
  description: "Check the current status of a VM by machine ID. Requires x402 payment ($0.001).",
  responses: {
    200: { description: "VM status", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
    404: { description: "Machine not found" },
    502: { description: "Provider API error" },
  },
}), async (c) => {
  const provider = getProvider(c.env);
  try {
    const result = await provider.status(c.env, c.req.param("machine_id"));
    return c.json(result);
  } catch (err: any) {
    const status = err.message.includes("not found") ? 404 : 502;
    return c.json({ error: err.message }, status);
  }
});

// === DELETE /destroy/:machine_id (free) ===

app.delete("/destroy/:machine_id", describeRoute({
  description: "Destroy a VM by machine ID (free).",
  responses: {
    200: { description: "VM destroyed", content: { "application/json": { schema: { type: "object" } } } },
    502: { description: "Failed to destroy VM" },
  },
}), async (c) => {
  const provider = getProvider(c.env);
  try {
    await provider.destroy(c.env, c.req.param("machine_id"));
    return c.json({ destroyed: true, machine_id: c.req.param("machine_id") });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// === Health ===

app.get("/", describeRoute({
  description: "Health check and service info.",
  responses: {
    200: { description: "Service info", content: { "application/json": { schema: { type: "object" } } } },
  },
}), (c) => {
  return c.json({
    service: "x402-vps",
    description: "Time-boxed Ubuntu VMs with SSH. Pay via x402, auto-destructs when expired.",
    provider: c.env.PROVIDER || "fly",
    available_providers: Object.keys(providers),
    endpoints: {
      "POST /create": "$0.50",
      "GET /status/:machine_id": "$0.001",
      "DELETE /destroy/:machine_id": "free",
    },
  });
});

export default app;
