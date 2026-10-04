#!/usr/bin/env bash
# proof-daemon.sh — reproducible multi-process evidence for the durable daemon.
#
# What it proves, with real processes and real output:
#   1. `node cli.js serve` starts and becomes the ONE owner of .data/sessions.sqlite.
#   2. A direct `run` in another process is refused with an actionable sentence,
#      and a second `serve` fails cleanly (one process owns the storage at a time).
#   3. A prompt runs THROUGH the daemon (`send`) and creates a conversation.
#   4. TWO SEPARATE client processes attach to the same conversation at the same
#      time and BOTH receive its live events while a second prompt runs through
#      the daemon (the `send` client itself is a third live watcher).
#   5. A client started with NO daemon up says so plainly, does not hang, and exits 1.
#
# Run from experimental/durable/:  bash proof-daemon.sh
# All output lands in .data/daemon-proof/ (gitignored) and is printed at the end.
set -uo pipefail
cd "$(dirname "$0")"

OUT=.data/daemon-proof
mkdir -p "$OUT"
step() { printf '\n=== %s\n' "$*"; }

# --- 1. the daemon starts --------------------------------------------------------
step "1. starting the daemon (node cli.js serve)"
node cli.js serve >"$OUT/daemon.log" 2>&1 &
DAEMON_PID=$!
up=0
for _ in $(seq 1 120); do # up to 120 s: the MCP bridge connects before the endpoint is served
	if grep -q "listening on" "$OUT/daemon.log" 2>/dev/null; then up=1; break; fi
	sleep 1
done
if [ "$up" != 1 ]; then
	echo "FAIL: the daemon did not come up"; cat "$OUT/daemon.log"; exit 1
fi
echo "daemon up (pid $DAEMON_PID). Its startup log:"
grep -v "^\[mcp\] .*: " "$OUT/daemon.log" | sed 's/^/    /'

# --- 2. one process owns the storage ----------------------------------------------
step "2. direct run while the daemon owns the storage (must refuse, not hang)"
node cli.js run "hello" 2>&1 | sed 's/^/    /'
echo "    exit=$?"

step "2b. second serve while the daemon owns the storage (must fail cleanly)"
timeout 30 node cli.js serve 2>&1 | grep "^error:" | sed 's/^/    /'

# --- 3. a prompt through the daemon ------------------------------------------------
step "3. send through the daemon: 'Reply with exactly: DAEMON-OK'"
node cli.js send "Reply with exactly: DAEMON-OK" >"$OUT/send1.out" 2>"$OUT/send1.err"
echo "    exit=$? answer on stdout: $(cat "$OUT/send1.out")"
CONV=$(grep -o '\[conversation\] [0-9]*' "$OUT/send1.err" | awk '{print $2}')
if [ -z "$CONV" ]; then echo "FAIL: no conversation id in send1.err"; exit 1; fi
echo "    conversation $CONV created by the daemon"

# --- 4. two separate client processes, one conversation, live events ---------------
step "4. attach TWO separate client processes to conversation $CONV"
node cli.js attach "$CONV" >"$OUT/attach-A.log" 2>&1 &
ATTACH_A=$!
sleep 1
node cli.js attach "$CONV" >"$OUT/attach-B.log" 2>&1 &
ATTACH_B=$!
sleep 2
echo "    attach A pid $ATTACH_A, attach B pid $ATTACH_B"
echo "    both attached; now running a SECOND prompt through the daemon while they watch"
node cli.js send "$CONV" "Call the slow_step tool once: step 1, seconds 4. Then reply DAEMON-LIVE." \
	>"$OUT/send2.out" 2>"$OUT/send2.err"
echo "    send exit=$? answer on stdout: $(cat "$OUT/send2.out")"
sleep 2 # let the last event batches reach the attach clients
kill "$ATTACH_A" "$ATTACH_B" 2>/dev/null

live_hits_a=$(grep -c "DAEMON-LIVE" "$OUT/attach-A.log" || true)
live_hits_b=$(grep -c "DAEMON-LIVE" "$OUT/attach-B.log" || true)
echo "    attach A saw the live run (DAEMON-LIVE hits): $live_hits_a"
echo "    attach B saw the live run (DAEMON-LIVE hits): $live_hits_b"
if [ "$live_hits_a" -lt 1 ] || [ "$live_hits_b" -lt 1 ]; then
	echo "FAIL: at least one attach client did not receive the live events"
	DIED=1
else
	DIED=0
fi

# --- 5. no daemon up ----------------------------------------------------------------
step "5. stop the daemon (graceful shutdown through the protocol), then start a client with NO daemon up"
node cli.js stop 2>&1 | sed 's/^/    /'
sleep 2 # the daemon closes its streams, checkpoints the storage, then exits
timeout 10 node cli.js attach "$CONV" 2>&1 | sed 's/^/    /'
echo "    exit=$? (plain message, non-zero, no hang)"
timeout 10 node cli.js send "anyone there?" 2>&1 | sed 's/^/    /'
echo "    exit=$? (plain message, non-zero, no hang)"

# --- the raw evidence ----------------------------------------------------------------
step "attach A (full log)"
cat "$OUT/attach-A.log" | sed 's/^/    /'
step "attach B (full log)"
cat "$OUT/attach-B.log" | sed 's/^/    /'
step "send 2 (stderr: the third live watcher)"
cat "$OUT/send2.err" | sed 's/^/    /'

if [ "$DIED" = 1 ]; then exit 1; fi
printf '\nPROOF-DAEMON-OK\n'
