# Working on TeleFlock with coding agents

TeleFlock runs omp agents inside herdr panes, and it is usually developed by such agents on a machine whose herdr server also runs other agents. Stopping that server ends every agent on the machine, including the one doing the work. These rules apply to every agent and script working on this repository.

## The real herdr server is off limits

- Never stop, kill, restart or reconfigure a herdr server you did not start in a lab. That rules out `herdr server stop`, `herdr session stop|delete`, `herdr server reload-config`, `herdr update --handoff`, `kill`/`pkill` on herdr processes, and edits under `~/.config/herdr/`.
- Inside a herdr pane every process inherits `HERDR_SOCKET_PATH` (and `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`). Without `--session`, herdr resolves its server from `HERDR_SOCKET_PATH` first, then `HERDR_SESSION`, then the default session. `HERDR_SESSION=x herdr server stop` therefore stops the server of the pane you are in, not session `x`.
- Read-only queries against the real server (`herdr status`, `herdr pane list|get`, `herdr agent list`) are fine.
- Unsure what a herdr command does? Read `herdr <command> --help` in full (do not filter it), and do not run it.

## Labs are always isolated

- Start every lab process (herdr, `tf-hostd`, `tf-devserver`, omp, mock servers) through `scripts/lab/run <name> -- <command>`. A lab gets its own HOME, XDG dirs, `TF_HOSTD_HOME` and omp agent dir under `/tmp/tf-lab-<name>`, and a clean environment, so nothing started in it can reach the real herdr, `tf-hostd` or omp state. Name its herdr sessions `tf-lab-<name>`.
- Stop a lab with `scripts/lab/stop <name>` (add `--purge` to delete its directory). It stops the processes started through `scripts/lab/run <name>` (and their children, and processes pointing into the lab's directory), removes systemd units the lab installed, and checks that your own herdr server still answers.
- A lab `tf-hostd` installs no boot-time systemd units: only the real home (`~/.teleflock`) does. A lab that tests that timer sets `TF_HOSTD_KEEPALIVE=1` and stops with `scripts/lab/stop`.
- Need real data, such as session files? Copy it into the lab. Never point a lab at real directories.
- Labs have no model credentials. Use a local mock provider (`models.yml` in the lab's omp agent dir).
- Build outside the lab (`cargo build`, `bun run build`), then run the built binaries inside it.

## Processes and files

- Signal only processes you started, by PID, and check `/proc/<pid>/cmdline` right before signalling: PIDs get reused.
- Never write the user's `~/.teleflock`, `~/.omp` (config, credentials, sessions) or `~/.config/herdr`.
- Use your own `CARGO_TARGET_DIR` under `target/` when several agents build at once.
