import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";

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

// === Route config ===

const SYSTEM_PROMPT = `You are a parameter extractor for a VPS provisioning service.
Extract the following from the user's message and return JSON:
- "action": either "create" (spin up a new VM) or "status" (check status of an existing VM). Default "create". (required)
- "duration_minutes": how long the VM stays alive in minutes, 1-60. Default 60. (optional)
- "size": VM size, one of "small" (shared-cpu-1x, 256MB), "medium" (shared-cpu-2x, 512MB), "large" (shared-cpu-4x, 1GB). (optional)
- "region": region code like "iad", "ord", "lax", "fra", "sin". (optional)
- "machine_id": the machine ID to check status for. Required if action is "status". (optional)

Map size names: "small" -> "shared-cpu-1x", "medium" -> "shared-cpu-2x", "large" -> "shared-cpu-4x".

Return ONLY valid JSON, no explanation.
Examples:
- {"action": "create", "duration_minutes": 30, "size": "shared-cpu-2x"}
- {"action": "status", "machine_id": "abc123"}
- {"action": "create", "region": "fra"}`;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.50", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.50", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.50", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Spin up a time-boxed Ubuntu VM with SSH access or check VM status. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe what you want: create a VPS or check status of an existing one", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "vps" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const action = ((params.action as string) || "create").toLowerCase();

  if (action === "status") {
    const machineId = params.machine_id as string;
    if (!machineId) {
      return c.json({ error: "Could not determine machine_id to check status" }, 400);
    }
    const provider = getProvider(c.env);
    try {
      const result = await provider.status(c.env, machineId);
      return c.json(result);
    } catch (err: any) {
      const status = err.message.includes("not found") ? 404 : 502;
      return c.json({ error: err.message }, status);
    }
  }

  // Default: create
  const provider = getProvider(c.env);

  let duration = Number(params.duration_minutes) || 60;
  if (duration < 1) duration = 1;
  if (duration > 60) duration = 60;

  // Map friendly size names to actual size keys
  let size: string = (params.size as string) || "shared-cpu-1x";
  const sizeMap: Record<string, string> = {
    small: "shared-cpu-1x",
    medium: "shared-cpu-2x",
    large: "shared-cpu-4x",
  };
  if (sizeMap[size.toLowerCase()]) {
    size = sizeMap[size.toLowerCase()];
  }

  if (!provider.sizes[size]) {
    return c.json(
      { error: `Invalid size "${size}". Must be one of: ${Object.keys(provider.sizes).join(", ")}` },
      400
    );
  }

  const region: string = (params.region as string) || "iad";

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

// === DELETE /destroy/:machine_id (free) ===

app.delete("/destroy/:machine_id", async (c) => {
  const provider = getProvider(c.env);
  try {
    await provider.destroy(c.env, c.req.param("machine_id"));
    return c.json({ destroyed: true, machine_id: c.req.param("machine_id") });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 VPS", "vps.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-vps",
    description: 'Time-boxed Ubuntu VMs with SSH. Send POST / with {"input": "create a medium VM for 30 minutes"}',
    provider: c.env.PROVIDER || "fly",
    available_providers: Object.keys(providers),
    price: "$0.50 per request (Base mainnet)",
    endpoints: {
      "POST /": "$0.50",
      "DELETE /destroy/:machine_id": "free",
    },
  });
});

export default app;
