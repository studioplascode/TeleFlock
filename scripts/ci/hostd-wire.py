#!/usr/bin/env python3
"""A small client of tf-hostd's wire protocol, for the CI checks of the login item (login-items.yml).

It talks to the daemon the way the TeleFlock app does: through `tf-hostd attach`, which bridges its
stdin and stdout to the daemon's client endpoint (a unix socket, a named pipe on Windows) and starts
the daemon first when none runs. The same code runs on Linux, macOS and Windows.

  hostd-wire.py <tf-hostd> [options] info
      Sends the control line {"ctl":"info"} and prints the reply: pid, version, home, startedAt…
  hostd-wire.py <tf-hostd> [options] call <method> [<params json> | @<file holding the params json>]
      hello → welcome, one request, bye. Prints the daemon's `res` message as one line
      (e.g. `call host.autoResumeSet '{"bringBack":false}'`; a Windows shell passes `@file`: its
      command lines cannot carry a quote safely).
  hostd-wire.py get <path>
      Reads one JSON document from stdin and prints the member at <path> (dotted; list items by
      number, `result.bootService.installed`) as JSON. For shell scripts without jq.

Options: --session NAME (herdr session of the hello, default "default"), --timeout SECONDS (per
step, default 90: a daemon that has to start is given 30 s by attach itself).

Exit status: 0 the daemon answered (or the member exists); 1 the answer is an error (printed all
the same) or the member is missing; 2 no answer, or tf-hostd could not be run.

Starting the daemon is what `attach` does, so `info` and `call` start one when none runs. Callers
that must not start it (is it down? did the login item bring it back?) look at processes first.
"""

import json
import queue
import subprocess
import sys
import threading
import time

PROTOCOL = 1


def die(code, message):
    print("hostd-wire: " + message, file=sys.stderr)
    sys.exit(code)


class Attach:
    """One `tf-hostd attach` process: JSON lines in, JSON lines out."""

    def __init__(self, hostd, session):
        try:
            self.proc = subprocess.Popen(
                [hostd, "attach", "--session", session],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )  # stderr stays ours: attach's own diagnostics ("tf-hostd: starting daemon") reach the log
        except OSError as e:
            die(2, "cannot run %s attach: %s" % (hostd, e))
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        # Never waits for the end of the stream: a daemon that attach started may keep the pipe
        # open after attach itself exited (Windows hands inheritable handles down).
        for raw in iter(self.proc.stdout.readline, b""):
            self.lines.put(raw.decode("utf-8", "replace"))
        self.lines.put(None)

    def send(self, message):
        data = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        except OSError as e:
            die(2, "tf-hostd attach went away while sending: %s" % e)

    def recv(self, wanted, timeout):
        """The first message `wanted(message)` accepts; others (the snapshot, pulses) are skipped."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                die(2, "no answer from tf-hostd within %ss" % timeout)
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                die(2, "no answer from tf-hostd within %ss" % timeout)
            if line is None:
                die(2, "tf-hostd attach closed its output (exit %s)" % self.proc.poll())
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and wanted(message):
                return message

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def version_line(hostd):
    try:
        out = subprocess.run([hostd, "--version"], stdout=subprocess.PIPE, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        die(2, "cannot run %s --version: %s" % (hostd, e))
    return out.stdout.decode("utf-8", "replace").strip()


def platform_name():
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


def info(hostd, session, timeout):
    a = Attach(hostd, session)
    try:
        # The very line `tf-hostd stop` sends, with `info` as the operation.
        a.send({"ctl": "info", "version": version_line(hostd), "force": False})
        return a.recv(lambda m: m.get("op") == "info", timeout)
    finally:
        a.close()


def call(hostd, session, timeout, method, params):
    a = Attach(hostd, session)
    try:
        a.send(
            {
                "t": "hello",
                "protocol": PROTOCOL,
                "client": {"app": "teleflock-ci", "version": "0", "platform": platform_name(), "device": "login-items-ci"},
                "herdrSession": session,
            }
        )
        first = a.recv(lambda m: m.get("t") in ("welcome", "error"), timeout)
        if first.get("t") == "error":
            return first
        a.send({"t": "req", "id": 1, "method": method, "params": params})
        res = a.recv(lambda m: m.get("t") == "res" and m.get("id") == 1, timeout)
        a.send({"t": "bye"})
        return res
    finally:
        a.close()


def member(document, path):
    here = document
    for key in path.split("."):
        if isinstance(here, list) and key.isdigit() and int(key) < len(here):
            here = here[int(key)]
        elif isinstance(here, dict) and key in here:
            here = here[key]
        else:
            return False, None
    return True, here


def main(argv):
    if argv[:1] == ["get"]:
        if len(argv) != 2:
            die(2, "usage: hostd-wire.py get <path>")
        try:
            document = json.load(sys.stdin)
        except ValueError as e:
            die(2, "stdin is not JSON: %s" % e)
        found, value = member(document, argv[1])
        if not found:
            return 1
        print(json.dumps(value, separators=(",", ":")))
        return 0

    args = list(argv)
    session, timeout = "default", 90.0
    rest = []
    while args:
        a = args.pop(0)
        if a == "--session" and args:
            session = args.pop(0)
        elif a == "--timeout" and args:
            timeout = float(args.pop(0))
        else:
            rest.append(a)
    if len(rest) < 2 or rest[1] not in ("info", "call") or (rest[1] == "info" and len(rest) != 2) or (rest[1] == "call" and not 3 <= len(rest) <= 4):
        die(2, "usage: hostd-wire.py <tf-hostd> [--session NAME] [--timeout SECONDS] info | call <method> [<params json>]")
    hostd, verb = rest[0], rest[1]
    if verb == "info":
        answer = info(hostd, session, timeout)
    else:
        try:
            text = rest[3] if len(rest) == 4 else "{}"
            if text.startswith("@"):
                with open(text[1:], encoding="utf-8-sig") as f:
                    text = f.read()
            params = json.loads(text)
        except (OSError, ValueError) as e:
            die(2, "the params are not JSON: %s" % e)
        answer = call(hostd, session, timeout, rest[2], params)
    print(json.dumps(answer, separators=(",", ":")))
    failed = answer.get("error") is not None or answer.get("t") == "error" or answer.get("ok") is False
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
