#!/usr/bin/env python3
"""Minimal HTTP server for command execution inside a Cloudflare Container."""

import json
import subprocess
import os
from http.server import HTTPServer, BaseHTTPRequestHandler


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/status":
            uptime = open("/proc/uptime").read().split()[0]
            self.send_json(200, {"status": "running", "uptime_seconds": float(uptime)})
        elif self.path == "/start":
            self.send_json(200, {"status": "running"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        if self.path == "/start":
            self.send_json(200, {"status": "running"})
        elif self.path == "/exec":
            command = body.get("command")
            if not command:
                self.send_json(400, {"error": "Missing 'command' field"})
                return
            timeout = body.get("timeout", 30)
            try:
                result = subprocess.run(
                    command, shell=True, capture_output=True, text=True,
                    timeout=timeout, cwd="/workspace"
                )
                self.send_json(200, {
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "exit_code": result.returncode,
                })
            except subprocess.TimeoutExpired:
                self.send_json(408, {"error": f"Command timed out after {timeout}s"})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif self.path == "/destroy":
            self.send_json(200, {"destroyed": True})
            os._exit(0)
        else:
            self.send_json(404, {"error": "not found"})

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # Suppress request logging


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8080), Handler)
    print("VPS server listening on :8080", flush=True)
    server.serve_forever()
