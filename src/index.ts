import { Hono } from "hono";
import { getSandbox, proxyToSandbox, Sandbox } from "@cloudflare/sandbox";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { openapiFromMiddleware } from "x402-openapi";

// 2 sandbox classes — same code, different instance types configured in wrangler
export class SandboxBasic extends Sandbox {}
export class SandboxStandard extends Sandbox {}

interface Env {
  SERVER_ADDRESS: string;
  SANDBOX_BASIC: DurableObjectNamespace;
  SANDBOX_STANDARD: DurableObjectNamespace;
  API_KEYS: KVNamespace;
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;
  STRIPE_SECRET_KEY: string;
}

// Pricing: Cloudflare cost rounded to nearest $0.001
// lite: $0.002/min, basic: $0.0005/min, standard-2: $0.002/min
interface Tier {
  size: string;
  duration: number;
  price: string;
  binding: "SANDBOX_LITE" | "SANDBOX_BASIC" | "SANDBOX_STANDARD";
  specs: string;
}

const TIERS: Record<string, Tier> = {
  // Basic: 1/4 vCPU, 1GB, 4GB disk
  "basic-10": { size: "basic", duration: 10, price: "$0.005", binding: "SANDBOX_BASIC",   specs: "1/4 vCPU, 1GB RAM, 4GB disk" },
  "basic-30": { size: "basic", duration: 30, price: "$0.014", binding: "SANDBOX_BASIC",   specs: "1/4 vCPU, 1GB RAM, 4GB disk" },
  "basic-60": { size: "basic", duration: 60, price: "$0.028", binding: "SANDBOX_BASIC",   specs: "1/4 vCPU, 1GB RAM, 4GB disk" },

  // Standard: 1 vCPU, 6GB, 12GB disk
  "standard-10": { size: "standard-2", duration: 10, price: "$0.022", binding: "SANDBOX_STANDARD", specs: "1 vCPU, 6GB RAM, 12GB disk" },
  "standard-30": { size: "standard-2", duration: 30, price: "$0.065", binding: "SANDBOX_STANDARD", specs: "1 vCPU, 6GB RAM, 12GB disk" },
  "standard-60": { size: "standard-2", duration: 60, price: "$0.129", binding: "SANDBOX_STANDARD", specs: "1 vCPU, 6GB RAM, 12GB disk" },
};

function makeAccepts(price: string) {
  return [
    { scheme: "exact" as const, price, network: "eip155:8453", payTo: "0x0" as `0x${string}` },
    { scheme: "exact" as const, price, network: "eip155:137", payTo: "0x0" as `0x${string}` },
    { scheme: "exact" as const, price, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
  ];
}

function overridePayTo(accepts: any[], env: Env) {
  return accepts.map((a: any) => ({
    ...a,
    payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}`,
  }));
}

// Build ROUTES for payment middleware — one per tier
const ROUTES: Record<string, any> = {};
for (const [name, tier] of Object.entries(TIERS)) {
  ROUTES[`POST /${name}`] = {
    accepts: makeAccepts(tier.price),
    description: `Create a ${tier.size} sandbox for ${tier.duration} min (${tier.specs})`,
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: {} },
          output: { type: "json" },
        },
        schema: {
          properties: { input: { properties: { method: { type: "string", enum: ["POST"] } }, required: ["method"] } },
        },
      },
    },
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use(stripeApiKeyMiddleware({ serviceName: "vps" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  const routeConfig: Record<string, any> = {};
  for (const [key, val] of Object.entries(ROUTES)) {
    routeConfig[key] = { ...val, accepts: overridePayTo(val.accepts, c.env) };
  }
  return cdpPaymentMiddleware((env) => routeConfig)(c, next);
});

// Helper to get sandbox and check expiry
async function getSandboxOrFail(env: Env, sandboxId: string) {
  const meta = await env.API_KEYS.get(`vps:${sandboxId}`);
  if (!meta) return { error: "Sandbox not found or expired" as const, status: 404 as const };
  const data = JSON.parse(meta);
  if (new Date(data.expires_at) < new Date()) {
    return { error: "Sandbox expired" as const, status: 410 as const };
  }
  const binding = env[data.binding as keyof Env] as DurableObjectNamespace;
  return { sandbox: getSandbox(binding, sandboxId), meta: data };
}

// POST /:tier — create a sandbox
for (const [name, tier] of Object.entries(TIERS)) {
  app.post(`/${name}`, async (c) => {
    const sandboxId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + tier.duration * 60 * 1000).toISOString();

    await c.env.API_KEYS.put(`vps:${sandboxId}`, JSON.stringify({
      expires_at: expiresAt,
      duration_minutes: tier.duration,
      size: tier.size,
      binding: tier.binding,
      specs: tier.specs,
      created_at: new Date().toISOString(),
    }), { expirationTtl: tier.duration * 60 + 300 });

    const binding = c.env[tier.binding] as DurableObjectNamespace;
    const sandbox = getSandbox(binding, sandboxId, { sleepAfter: `${tier.duration}m` });
    await sandbox.exec("echo ready");

    return c.json({
      sandbox_id: sandboxId,
      status: "running",
      tier: name,
      size: tier.size,
      specs: tier.specs,
      duration_minutes: tier.duration,
      expires_at: expiresAt,
      endpoints: {
        exec: `https://vps.camelai.io/exec/${sandboxId}`,
        write_file: `https://vps.camelai.io/file/${sandboxId}`,
        read_file: `https://vps.camelai.io/file/${sandboxId}?path=/workspace/file.txt`,
        start_process: `https://vps.camelai.io/start-process/${sandboxId}`,
        expose_port: `https://vps.camelai.io/expose/${sandboxId}`,
        status: `https://vps.camelai.io/status/${sandboxId}`,
        destroy: `https://vps.camelai.io/destroy/${sandboxId}`,
      },
    });
  });
}

// POST /exec/:id
app.post("/exec/:id", async (c) => {
  const result = await getSandboxOrFail(c.env, c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);

  const body = await c.req.json<{ command: string; timeout?: number; cwd?: string }>().catch(() => null);
  if (!body?.command) return c.json({ error: "Missing 'command' field" }, 400);

  try {
    const execResult = await result.sandbox.exec(body.command, {
      timeout: (body.timeout ?? 30) * 1000,
      cwd: body.cwd,
    });
    return c.json({ stdout: execResult.stdout, stderr: execResult.stderr, exit_code: execResult.exitCode });
  } catch (err: any) {
    return c.json({ error: err.message || "Execution failed" }, 500);
  }
});

// PUT /file/:id — write file
app.put("/file/:id", async (c) => {
  const result = await getSandboxOrFail(c.env, c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);

  const body = await c.req.json<{ path: string; content: string; encoding?: string }>().catch(() => null);
  if (!body?.path || body.content === undefined) return c.json({ error: "Missing 'path' and/or 'content'" }, 400);

  try {
    await result.sandbox.writeFile(body.path, body.content, { encoding: body.encoding as any });
    return c.json({ written: true, path: body.path });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /file/:id?path=...
app.get("/file/:id", async (c) => {
  const result = await getSandboxOrFail(c.env, c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);

  const path = c.req.query("path");
  if (!path) return c.json({ error: "Missing 'path' query parameter" }, 400);

  try {
    const file = await result.sandbox.readFile(path);
    return c.json({ path, content: file.content });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /start-process/:id — start a background process
app.post("/start-process/:id", async (c) => {
  const result = await getSandboxOrFail(c.env, c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);

  const body = await c.req.json<{ command: string; cwd?: string; env?: Record<string, string> }>().catch(() => null);
  if (!body?.command) return c.json({ error: "Missing 'command' field" }, 400);

  try {
    const proc = await result.sandbox.startProcess(body.command, {
      cwd: body.cwd,
      env: body.env,
    });
    return c.json({ pid: proc.pid, command: body.command });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /expose/:id — expose a port
app.post("/expose/:id", async (c) => {
  const result = await getSandboxOrFail(c.env, c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);

  const body = await c.req.json<{ port: number; name?: string }>().catch(() => null);
  if (!body?.port) return c.json({ error: "Missing 'port' field" }, 400);

  try {
    const hostname = new URL(c.req.url).hostname;
    const exposed = await result.sandbox.exposePort(body.port, { hostname, name: body.name });
    return c.json({ port: body.port, url: exposed.url });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /status/:id
app.get("/status/:id", async (c) => {
  const meta = await c.env.API_KEYS.get(`vps:${c.req.param("id")}`);
  if (!meta) return c.json({ error: "Sandbox not found or expired" }, 404);
  const data = JSON.parse(meta);
  return c.json({ ...data, status: new Date(data.expires_at) < new Date() ? "expired" : "running" });
});

// DELETE /destroy/:id (free)
app.delete("/destroy/:id", async (c) => {
  const sandboxId = c.req.param("id");
  const meta = await c.env.API_KEYS.get(`vps:${sandboxId}`);
  if (meta) {
    try {
      const data = JSON.parse(meta);
      const binding = c.env[data.binding as keyof Env] as DurableObjectNamespace;
      const sandbox = getSandbox(binding, sandboxId);
      await sandbox.destroy();
    } catch {}
  }
  await c.env.API_KEYS.delete(`vps:${sandboxId}`);
  return c.json({ destroyed: true, sandbox_id: sandboxId });
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 VPS", "vps.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-vps",
    description: "Time-boxed Ubuntu sandboxes on Cloudflare. Exec commands, write files, expose ports. Priced at Cloudflare cost.",
    provider: "cloudflare-sandbox",
    tiers: Object.entries(TIERS).map(([name, t]) => ({
      endpoint: `POST /${name}`,
      price: t.price,
      size: t.size,
      specs: t.specs,
      duration: `${t.duration} minutes`,
    })),
    free_endpoints: {
      "POST /exec/:id": { body: { command: "string", timeout: "optional seconds", cwd: "optional" } },
      "PUT /file/:id": { body: { path: "string", content: "string" } },
      "GET /file/:id?path=...": "read a file",
      "POST /expose/:id": { body: { port: "number", name: "optional" } },
      "GET /status/:id": "check sandbox status",
      "DELETE /destroy/:id": "destroy sandbox early",
    },
  });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Custom proxy: route preview URLs to the correct sandbox binding
    const url = new URL(request.url);
    const host = url.hostname;
    // Preview URL format: {port}-{sandboxId}-{token}.vps.camelai.io
    if (host.endsWith(".vps.camelai.io") && host !== "vps.camelai.io") {
      // Look up which binding this sandbox uses
      const parts = host.replace(".vps.camelai.io", "").split("-");
      // sandboxId is a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (5 groups)
      // Format: {port}-{uuid parts}-{token}
      // Port is first, then 5 UUID segments, then token
      if (parts.length >= 7) {
        const sandboxId = parts.slice(1, 6).join("-");
        const meta = await env.API_KEYS.get(`vps:${sandboxId}`);
        if (meta) {
          const data = JSON.parse(meta);
          // Temporarily set env.Sandbox to the correct binding for proxyToSandbox
          (env as any).Sandbox = env[data.binding as keyof Env];
          const proxyResponse = await proxyToSandbox(request, env as any);
          if (proxyResponse) return proxyResponse;
        }
      }
    }

    return app.fetch(request, env, ctx);
  },
};
