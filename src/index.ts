import { Hono } from "hono";
import { Container } from "@cloudflare/containers";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { openapiFromMiddleware } from "x402-openapi";

// === Container class (Durable Object) ===

export class VPSContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "60m"; // auto-sleep after 60 min of inactivity

  override onStart() {
    console.log("VPS container started");
  }

  override onStop() {
    console.log("VPS container stopped");
  }

  override onError(error: unknown) {
    console.error("VPS container error:", error);
  }
}

// === Worker ===

interface Env {
  SERVER_ADDRESS: string;
  VPS_CONTAINER: DurableObjectNamespace;
  API_KEYS: KVNamespace;
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;
  STRIPE_SECRET_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.50", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.50", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.50", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Create a time-boxed Ubuntu container with command execution access",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              duration_minutes: { type: "number", description: "How long the container stays alive (1-60, default 30)", required: false },
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

// POST / — create a container
app.post("/", async (c) => {
  const body = await c.req.json<{ duration_minutes?: number }>().catch(() => ({}));
  let duration = body.duration_minutes ?? 30;
  if (duration < 1) duration = 1;
  if (duration > 60) duration = 60;

  const containerId = `vps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString();

  // Get container stub and start it
  const id = c.env.VPS_CONTAINER.idFromName(containerId);
  const stub = c.env.VPS_CONTAINER.get(id);

  // Ping the container to start it (fetch proxies to container's port 8080)
  const startRes = await stub.fetch("https://container/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duration_minutes: duration }),
  });

  if (!startRes.ok) {
    return c.json({ error: "Failed to start container", details: await startRes.text() }, 502);
  }

  return c.json({
    container_id: containerId,
    status: "running",
    duration_minutes: duration,
    expires_at: expiresAt,
    endpoints: {
      exec: `https://vps.camelai.io/exec/${containerId}`,
      status: `https://vps.camelai.io/status/${containerId}`,
      destroy: `https://vps.camelai.io/destroy/${containerId}`,
    },
  });
});

// POST /exec/:id — execute a command (free, container already paid for)
app.post("/exec/:id", async (c) => {
  const body = await c.req.json<{ command: string; timeout?: number }>().catch(() => null);
  if (!body?.command) {
    return c.json({ error: "Missing 'command' field" }, 400);
  }

  const id = c.env.VPS_CONTAINER.idFromName(c.req.param("id"));
  const stub = c.env.VPS_CONTAINER.get(id);

  try {
    const res = await stub.fetch("https://container/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: body.command, timeout: body.timeout ?? 30 }),
    });
    return c.json(await res.json(), res.status as any);
  } catch {
    return c.json({ error: "Container not found or not running" }, 404);
  }
});

// GET /status/:id
app.get("/status/:id", async (c) => {
  const id = c.env.VPS_CONTAINER.idFromName(c.req.param("id"));
  const stub = c.env.VPS_CONTAINER.get(id);

  try {
    const res = await stub.fetch("https://container/status");
    return c.json(await res.json());
  } catch {
    return c.json({ error: "Container not found or not running" }, 404);
  }
});

// DELETE /destroy/:id (free)
app.delete("/destroy/:id", async (c) => {
  const id = c.env.VPS_CONTAINER.idFromName(c.req.param("id"));
  const stub = c.env.VPS_CONTAINER.get(id);

  try {
    await stub.fetch("https://container/destroy", { method: "POST" });
  } catch {
    // Already destroyed
  }

  return c.json({ destroyed: true, container_id: c.req.param("id") });
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 VPS", "vps.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-vps",
    description: "Time-boxed Ubuntu containers on Cloudflare. Pay once, exec commands for the duration.",
    provider: "cloudflare-containers",
    price: "$0.50 per container",
    endpoints: {
      "POST /": { price: "$0.50", body: { duration_minutes: "1-60, default 30" } },
      "POST /exec/:id": { price: "free", body: { command: "shell command", timeout: "optional seconds (default 30)" } },
      "GET /status/:id": "free",
      "DELETE /destroy/:id": "free",
    },
  });
});

export default app;
