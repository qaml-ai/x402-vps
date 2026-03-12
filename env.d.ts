interface Env {
  SERVER_ADDRESS: string;

  // Provider: set PROVIDER to switch backends ("fly" | "hetzner" | etc.)
  PROVIDER: string;

  // Fly.io
  FLY_API_TOKEN: string;
  FLY_APP_NAME: string;

  // Hetzner (future)
  HETZNER_API_TOKEN: string;
}
