#!/usr/bin/env python3
"""A tiny MCP server over stdio (newline-delimited JSON-RPC 2.0) for TeleFlock's MCP tests and labs.

Tools: `echo` (returns its text), `add` (sums two numbers), `env_check` (whether LAB_TOKEN is set,
never its value). Writes nothing but protocol messages to stdout.
"""
import json
import os
import sys

TOOLS = [
    {
        "name": "echo",
        "description": "Echo the given text back.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "add",
        "description": "Add two numbers.",
        "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]},
    },
    {
        "name": "env_check",
        "description": "Report whether LAB_TOKEN reached the server (never its value).",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def call(name, args):
    if name == "echo":
        return str(args.get("text", ""))
    if name == "add":
        return str(float(args.get("a", 0)) + float(args.get("b", 0)))
    if name == "env_check":
        return "LAB_TOKEN is set" if os.environ.get("LAB_TOKEN") else "LAB_TOKEN is missing"
    raise KeyError(name)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method = msg.get("method")
    msg_id = msg.get("id")
    if msg_id is None:
        continue  # notifications (initialized, cancelled, ...)
    if method == "initialize":
        version = (msg.get("params") or {}).get("protocolVersion") or "2025-06-18"
        reply(msg_id, {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "tf-lab", "version": "1.0.0"}})
    elif method == "tools/list":
        reply(msg_id, {"tools": TOOLS})
    elif method == "tools/call":
        params = msg.get("params") or {}
        try:
            text = call(params.get("name"), params.get("arguments") or {})
            reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
        except KeyError:
            reply(msg_id, error={"code": -32602, "message": "unknown tool"})
    elif method == "ping":
        reply(msg_id, {})
    else:
        reply(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
