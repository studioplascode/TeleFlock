#!/usr/bin/env python3
"""Probe herdr's events.subscribe stream on a (lab) session socket.

Usage: subscribe-probe.py <socket> <outfile> [pane_id ...]
Subscribes to every global lifecycle event plus per-pane
pane.agent_status_changed / pane.scroll_changed for the given panes, and
appends each received line, prefixed with a wall-clock timestamp, to outfile.
"""
import json
import socket
import sys
import time

GLOBAL = [
    "workspace.created", "workspace.updated", "workspace.metadata_updated",
    "workspace.renamed", "workspace.moved", "workspace.reordered",
    "workspace.closed", "workspace.focused", "worktree.created",
    "worktree.opened", "worktree.removed", "tab.created", "tab.closed",
    "tab.focused", "tab.renamed", "tab.moved", "pane.created", "pane.closed",
    "pane.updated", "pane.focused", "pane.moved", "pane.exited",
    "pane.agent_detected", "layout.updated",
]

sock_path, out_path, *panes = sys.argv[1:]
subs = [{"type": t} for t in GLOBAL]
for p in panes:
    subs.append({"type": "pane.agent_status_changed", "pane_id": p})
    subs.append({"type": "pane.scroll_changed", "pane_id": p})

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.sendall((json.dumps({"id": "probe", "method": "events.subscribe",
                       "params": {"subscriptions": subs}}) + "\n").encode())
buf = b""
with open(out_path, "a", buffering=1) as out:
    while True:
        chunk = s.recv(65536)
        if not chunk:
            out.write(f"{time.time():.3f} EOF\n")
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            out.write(f"{time.time():.3f} {line.decode()}\n")
