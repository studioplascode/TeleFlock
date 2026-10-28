#!/usr/bin/env python3
"""A tiny OAuth 2.1 authorization server + OAuth-protected MCP server (Streamable HTTP) for
TeleFlock's MCP sign-in labs. Standard library only.

    oauth_server.py --host 127.0.0.1 --port 47681 [--auto-approve]

- MCP endpoint `POST /mcp`: 401 + `WWW-Authenticate: Bearer resource_metadata=…` without a valid
  token; with one, JSON-RPC answers (initialize, tools/list, tools/call, ping), notifications → 202.
- RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, RFC 7591 dynamic
  client registration (redirect URIs are matched exactly at /authorize, like strict providers).
- `/authorize` shows a consent page (Approve / Deny) unless --auto-approve; PKCE S256 is checked at
  `/token`; refresh tokens rotate.
"""
import argparse
import base64
import hashlib
import html
import json
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

CLIENTS = {}  # client_id -> {redirect_uris}
CODES = {}  # code -> {client_id, redirect_uri, challenge, scope}
TOKENS = {}  # access token -> expiry
REFRESH = {}  # refresh token -> client_id
TOOLS = [
    {"name": "whoami", "description": "Who the lab server thinks you are.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "lab_fact", "description": "A fact only signed-in clients get.", "inputSchema": {"type": "object", "properties": {}}},
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class Handler(BaseHTTPRequestHandler):
    server_version = "tf-lab-oauth/1.0"

    @property
    def base(self):
        return f"http://{self.server.public_host}:{self.server.server_port}"

    def log_message(self, fmt, *args):
        sys.stderr.write("[lab-oauth] " + (fmt % args) + "\n")

    def send_json(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, status, text):
        data = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, url):
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # ── discovery ──
    def resource_metadata(self):
        return {
            "resource": f"{self.base}/mcp",
            "authorization_servers": [self.base],
            "scopes_supported": ["mcp:tools"],
            "bearer_methods_supported": ["header"],
        }

    def as_metadata(self):
        return {
            "issuer": self.base,
            "authorization_endpoint": f"{self.base}/authorize",
            "token_endpoint": f"{self.base}/token",
            "registration_endpoint": f"{self.base}/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["mcp:tools"],
        }

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path.startswith("/.well-known/oauth-protected-resource"):
            return self.send_json(200, self.resource_metadata())
        if u.path in ("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"):
            return self.send_json(200, self.as_metadata())
        if u.path == "/authorize":
            return self.authorize(q)
        if u.path == "/mcp":
            return self.send_json(405, {"error": "use POST"}, {"Allow": "POST"})
        self.send_json(404, {"error": "not found"})

    def authorize(self, q):
        client = CLIENTS.get(q.get("client_id", ""))
        if not client:
            return self.send_html(400, "<h1>Unknown client</h1>")
        if q.get("redirect_uri") not in client["redirect_uris"]:
            return self.send_html(400, f"<h1>redirect_uri mismatch</h1><p>{html.escape(q.get('redirect_uri', ''))} is not registered</p>")
        if q.get("response_type") != "code" or q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
            return self.send_html(400, "<h1>PKCE S256 code flow required</h1>")
        if self.server.auto_approve:
            return self.complete(q, approve=True)
        fields = "".join(f'<input type="hidden" name="{html.escape(k)}" value="{html.escape(v)}">' for k, v in q.items())
        page = f"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Lab sign-in</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.3rem">TeleFlock lab OAuth</h1>
<p>Allow <b>{html.escape(q.get('client_id', ''))}</b> to use the lab MCP server?</p>
<form method=post action="/authorize/decide">{fields}
<button id=approve name=decision value=approve style="font-size:1rem;padding:.5rem 1rem">Approve</button>
<button id=deny name=decision value=deny style="font-size:1rem;padding:.5rem 1rem">Deny</button>
</form></body>"""
        self.send_html(200, page)

    def complete(self, q, approve):
        target = q["redirect_uri"]
        sep = "&" if "?" in target else "?"
        if not approve:
            return self.redirect(target + sep + urlencode({"error": "access_denied", "error_description": "The user denied the request", "state": q.get("state", "")}))
        code = secrets.token_urlsafe(24)
        CODES[code] = {"client_id": q["client_id"], "redirect_uri": target, "challenge": q["code_challenge"], "scope": q.get("scope", "mcp:tools")}
        self.redirect(target + sep + urlencode({"code": code, "state": q.get("state", "")}))

    def do_POST(self):
        u = urlparse(self.path)
        raw = self.body()
        if u.path == "/register":
            meta = json.loads(raw or b"{}")
            cid = "lab-client-" + secrets.token_hex(4)
            CLIENTS[cid] = {"redirect_uris": meta.get("redirect_uris", [])}
            return self.send_json(201, {"client_id": cid, "client_id_issued_at": int(time.time()), "redirect_uris": CLIENTS[cid]["redirect_uris"], "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]})
        if u.path == "/authorize/decide":
            form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            return self.complete(form, approve=form.pop("decision", "") == "approve")
        if u.path == "/token":
            return self.token({k: v[0] for k, v in parse_qs(raw.decode()).items()})
        if u.path == "/mcp":
            return self.mcp(raw)
        self.send_json(404, {"error": "not found"})

    def issue(self, client_id):
        access = "lab-at-" + secrets.token_urlsafe(18)
        refresh = "lab-rt-" + secrets.token_urlsafe(18)
        TOKENS[access] = time.time() + 3600
        REFRESH[refresh] = client_id
        return {"access_token": access, "token_type": "Bearer", "expires_in": 3600, "refresh_token": refresh, "scope": "mcp:tools"}

    def token(self, f):
        if f.get("grant_type") == "authorization_code":
            entry = CODES.pop(f.get("code", ""), None)
            if not entry:
                return self.send_json(400, {"error": "invalid_grant", "error_description": "unknown or used code"})
            if f.get("redirect_uri") != entry["redirect_uri"] or f.get("client_id", entry["client_id"]) != entry["client_id"]:
                return self.send_json(400, {"error": "invalid_grant", "error_description": "redirect_uri or client mismatch"})
            if b64url(hashlib.sha256(f.get("code_verifier", "").encode()).digest()) != entry["challenge"]:
                return self.send_json(400, {"error": "invalid_grant", "error_description": "PKCE verification failed"})
            return self.send_json(200, self.issue(entry["client_id"]))
        if f.get("grant_type") == "refresh_token":
            client = REFRESH.pop(f.get("refresh_token", ""), None)
            if not client:
                return self.send_json(400, {"error": "invalid_grant"})
            return self.send_json(200, self.issue(client))
        self.send_json(400, {"error": "unsupported_grant_type"})

    def mcp(self, raw):
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if TOKENS.get(token, 0) < time.time():
            meta = f"{self.base}/.well-known/oauth-protected-resource/mcp"
            return self.send_json(401, {"error": "invalid_token"}, {"WWW-Authenticate": f'Bearer error="invalid_token", resource_metadata="{meta}", scope="mcp:tools"'})
        msg = json.loads(raw or b"{}")
        if "id" not in msg:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        method, mid = msg.get("method"), msg.get("id")
        if method == "initialize":
            version = (msg.get("params") or {}).get("protocolVersion") or "2025-06-18"
            return self.send_json(200, {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "tf-lab-oauth", "version": "1.0.0"}}}, {"Mcp-Session-Id": "lab-" + secrets.token_hex(6)})
        if method == "tools/list":
            return self.send_json(200, {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        if method == "tools/call":
            name = (msg.get("params") or {}).get("name")
            text = {"whoami": "lab user (signed in through OAuth)", "lab_fact": "Penguins can't fly."}.get(name)
            if text is None:
                return self.send_json(200, {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool"}})
            return self.send_json(200, {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}})
        if method == "ping":
            return self.send_json(200, {"jsonrpc": "2.0", "id": mid, "result": {}})
        self.send_json(200, {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=47681)
    ap.add_argument("--public-host", help="host name in URLs (default: --host)")
    ap.add_argument("--auto-approve", action="store_true")
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.public_host = a.public_host or a.host
    srv.auto_approve = a.auto_approve
    sys.stderr.write(f"[lab-oauth] listening on http://{srv.public_host}:{a.port}/mcp\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
