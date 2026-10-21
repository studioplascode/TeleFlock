#!/usr/bin/env python3
# Test double for `tf-hostd` used by tf-client's connection state-machine test.
# Speaks the tf-hostd attach protocol (JSON lines) with canned answers.
import json
import os
import sys

VERSION = "@VERSION@"
HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print(VERSION)
    sys.exit(0)
if args[:1] != ["attach"]:
    sys.exit(2)

marker = os.path.join(HOME, "attach.log")
second = os.path.exists(marker)
with open(marker, "a") as f:
    f.write(" ".join(args) + "\n")


def out(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


hello = json.loads(sys.stdin.readline())
if hello.get("t") != "hello":
    sys.exit(4)
sys.stderr.write("tf-hostd: attached session %s\n" % hello["herdrSession"])
sys.stderr.flush()
out({"t": "welcome", "protocol": 1, "hostdVersion": "fake", "clientId": "c%d" % (2 if second else 1)})
with open(os.path.join(HOME, "state.json")) as f:
    state = json.load(f)
out({"t": "snapshot", "rev": 1, "state": state})
out({"t": "notify", "notification": {
    "id": "n1", "at": 1, "kind": "needs", "agentId": "a1", "title": "Question", "body": "Proceed?",
    "requestId": "r1", "actions": [{"id": "yes", "label": "Yes", "answer": {"choices": ["Yes"]}}]}})

terms = 0
while True:
    line = sys.stdin.readline()
    if not line:
        break
    m = json.loads(line)
    t = m.get("t")
    if t == "ping":
        out({"t": "pong", "ts": m["ts"]})
    elif t == "req":
        method, rid = m["method"], m["id"]
        with open(os.path.join(HOME, "requests.log"), "a") as f:
            f.write(json.dumps({"method": method, "params": m["params"]}) + "\n")
        if method == "host.health":
            sys.stderr.write("tf-hostd: exiting on request\n")
            sys.stderr.flush()
            sys.exit(3)
        elif method == "fs.home":
            out({"t": "res", "id": rid, "result": {"path": "/fake"}})
        elif method == "term.open":
            terms += 1
            out({"t": "res", "id": rid, "result": {"termId": "t%d" % terms, "paneId": "w1:p1"}})
        elif method == "session.open" and second:
            out({"t": "res", "id": rid, "error": {"code": "not_found", "message": "agent gone"}})
        elif method == "agent.answer":
            out({"t": "res", "id": rid, "result": {}})
            out({"t": "patch", "rev": 2, "ops": [{"op": "agent", "id": "a1", "value": None}]})
        else:
            out({"t": "res", "id": rid, "result": {}})
    elif t == "bye":
        break
