#!/usr/bin/env bash
# Remote sign-in lab (architecture §3.14): a "host" that does not share this machine's loopback, so
# sign-ins that redirect to http://localhost:<port>/… on the device must come back through
# TeleFlock's same-port tunnel (or be pasted), exactly as with a real remote host.
#
#   sudo scripts/lab-remote-auth.sh up      # host namespace + sshd + lab user + fake OAuth/MCP server
#   sudo scripts/lab-remote-auth.sh status
#   sudo scripts/lab-remote-auth.sh down    # removes everything `up` created
#
# Layout (Linux, root):
# - network namespace $NS with a veth pair: this machine (the device) is $NET.1, the host is $NET.2;
#   NAT gives the host internet access (real provider logins), tagged iptables rules.
# - sshd inside the namespace on $NET.2:22, key sign-in for a throwaway user $LAB_USER (home under
#   $LAB_DIR, copies of omp and herdr in ~/.local/bin). Its sessions get their own TF_HOSTD_HOME and
#   PI_CODING_AGENT_DIR: nothing touches this machine's tf-hostd, ~/.teleflock or ~/.omp.
# - the fake OAuth authorization server + OAuth-protected MCP server
#   (crates/tf-hostd/src/ops/mcp/testdata/oauth_server.py) on $NET.1:$OAUTH_PORT, which the browser
#   and the host both reach.
# - a devserver data dir with the host profile (`hosts.json`), and the command line to start
#   tf-devserver against it (printed by `up`).
set -euo pipefail

LAB_DIR=${LAB_DIR:-/tmp/tf-lab-remote-auth}
NS=${NS:-tflab-auth}
VETH=${VETH:-tflabauth}
NET=${NET:-10.231.77}
LAB_USER=${LAB_USER:-tflabauth}
OAUTH_PORT=${OAUTH_PORT:-47681}
RELAY_PORT=${RELAY_PORT:-47671}
HERDR_SESSION=${HERDR_SESSION:-tf-lab-remote-auth}
TAG="tf-lab-remote-auth"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

die() { echo "lab: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is required"; }

nat_rules() {
	# One rule per line: table, chain, spec (deleted in reverse by `down`).
	cat <<EOF
nat POSTROUTING -s $NET.0/30 ! -o ${VETH}0 -m comment --comment $TAG -j MASQUERADE
filter FORWARD -i ${VETH}0 -m comment --comment $TAG -j ACCEPT
filter FORWARD -o ${VETH}0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment $TAG -j ACCEPT
EOF
}

up() {
	[ "$(id -u)" = 0 ] || die "run as root"
	for t in ip sshd ssh-keygen useradd python3 iptables; do need "$t"; done
	local omp herdr
	omp=${OMP_BIN:-$(command -v omp || true)}
	herdr=${HERDR_BIN:-$(command -v herdr || true)}
	[ -x "$omp" ] || die "omp not found (set OMP_BIN)"
	[ -e "$LAB_DIR" ] && die "$LAB_DIR exists: run \`$0 down\` first"
	ip netns list | grep -qw "$NS" && die "namespace $NS exists: run \`$0 down\` first"

	mkdir -p "$LAB_DIR"/{user/.local/bin,hostd-home,omp-agent,sshd,client,devserver}
	chmod 755 "$LAB_DIR"
	useradd -M -U -d "$LAB_DIR/user" -s /bin/bash -c "TeleFlock remote sign-in lab" "$LAB_USER"
	usermod -p '*' "$LAB_USER" # no password, but not locked (sshd refuses locked accounts)
	cp "$omp" "$LAB_DIR/user/.local/bin/omp"
	[ -x "$herdr" ] && cp "$herdr" "$LAB_DIR/user/.local/bin/herdr"
	printf 'export PATH="$HOME/.local/bin:$PATH"\n' >"$LAB_DIR/user/.profile"
	chown -R "$LAB_USER:$LAB_USER" "$LAB_DIR/user" "$LAB_DIR/hostd-home" "$LAB_DIR/omp-agent"
	chmod 700 "$LAB_DIR/hostd-home" "$LAB_DIR/omp-agent"

	ssh-keygen -q -t ed25519 -N '' -C "$TAG host" -f "$LAB_DIR/sshd/host_ed25519"
	ssh-keygen -q -t ed25519 -N '' -C "$TAG device" -f "$LAB_DIR/client/id_ed25519"
	cp "$LAB_DIR/client/id_ed25519.pub" "$LAB_DIR/sshd/authorized_keys"
	chmod 644 "$LAB_DIR/sshd/authorized_keys"
	cat >"$LAB_DIR/sshd/sshd_config" <<EOF
ListenAddress $NET.2
Port 22
HostKey $LAB_DIR/sshd/host_ed25519
PidFile $LAB_DIR/sshd/sshd.pid
AuthorizedKeysFile $LAB_DIR/sshd/authorized_keys
AllowUsers $LAB_USER
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
X11Forwarding no
SetEnv TF_HOSTD_HOME=$LAB_DIR/hostd-home PI_CODING_AGENT_DIR=$LAB_DIR/omp-agent
EOF

	ip netns add "$NS"
	ip link add "${VETH}0" type veth peer name "${VETH}1"
	ip link set "${VETH}1" netns "$NS"
	ip addr add "$NET.1/30" dev "${VETH}0"
	ip link set "${VETH}0" up
	ip -n "$NS" link set lo up
	ip -n "$NS" addr add "$NET.2/30" dev "${VETH}1"
	ip -n "$NS" link set "${VETH}1" up
	ip -n "$NS" route add default via "$NET.1"
	while read -r table chain spec; do
		# shellcheck disable=SC2086
		iptables -t "$table" -I "$chain" 1 $spec
	done < <(nat_rules)

	ip netns exec "$NS" /usr/sbin/sshd -f "$LAB_DIR/sshd/sshd_config" -E "$LAB_DIR/sshd/sshd.log"
	setsid python3 "$ROOT/crates/tf-hostd/src/ops/mcp/testdata/oauth_server.py" --host "$NET.1" --port "$OAUTH_PORT" \
		>"$LAB_DIR/oauth.log" 2>&1 </dev/null &
	echo $! >"$LAB_DIR/oauth.pid"

	cat >"$LAB_DIR/devserver/hosts.json" <<EOF
{"profiles":[{"id":"remote-auth-lab","name":"authlab","kind":"tailscaleSsh","address":"$NET.2","user":"$LAB_USER","port":22,
"auth":"key","keyPath":"$LAB_DIR/client/id_ed25519","herdrSession":"$HERDR_SESSION","autoConnect":true,"relayPort":$RELAY_PORT}]}
EOF
	echo "lab: host $LAB_USER@$NET.2 (namespace $NS), OAuth/MCP server http://$NET.1:$OAUTH_PORT/mcp"
	echo "lab: start the device side with:"
	echo "  CARGO_TARGET_DIR=... cargo run -p tf-devserver -- --data-dir $LAB_DIR/devserver \\"
	echo "    --hostd-bin <target>/debug/tf-hostd [--static dist | --allow-origin http://127.0.0.1:<vite port>]"
}

status() {
	ip netns list | grep -w "$NS" || echo "no namespace $NS"
	[ -d "$LAB_DIR" ] && echo "lab dir $LAB_DIR" || echo "no lab dir"
	getent passwd "$LAB_USER" >/dev/null && echo "user $LAB_USER: $(pgrep -u "$LAB_USER" -c || true) processes" || echo "no user $LAB_USER"
	ip netns pids "$NS" 2>/dev/null | xargs -r ps -o pid=,user=,args= -p || true
}

down() {
	[ "$(id -u)" = 0 ] || die "run as root"
	if getent passwd "$LAB_USER" >/dev/null; then
		pkill -KILL -u "$LAB_USER" || true
	fi
	[ -f "$LAB_DIR/oauth.pid" ] && kill "$(cat "$LAB_DIR/oauth.pid")" 2>/dev/null || true
	if ip netns list | grep -qw "$NS"; then
		ip netns pids "$NS" | xargs -r kill -KILL || true
		ip netns del "$NS"
	fi
	ip link del "${VETH}0" 2>/dev/null || true
	while read -r table chain spec; do
		# shellcheck disable=SC2086
		while iptables -t "$table" -C "$chain" $spec 2>/dev/null; do iptables -t "$table" -D "$chain" $spec; done
	done < <(nat_rules)
	for _ in 1 2 3 4 5; do pgrep -u "$LAB_USER" >/dev/null 2>&1 || break; sleep 0.2; done
	getent passwd "$LAB_USER" >/dev/null && userdel "$LAB_USER"
	getent group "$LAB_USER" >/dev/null && groupdel "$LAB_USER"
	rm -rf "$LAB_DIR"
	echo "lab: down"
}

case "${1:-}" in
up) up ;;
down) down ;;
status) status ;;
*) die "usage: $0 up|status|down" ;;
esac
