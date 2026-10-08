#!/usr/bin/env bash
# proof-acp.sh — reproducible evidence that the durable agent speaks ACP.
#
# What it proves, with real processes and real model runs:
#   1. `node cli.js acp` answers the ACP handshake, creates a session, streams a
#      prompt's updates live, and returns the final answer (stopReason end_turn).
#   2. `session/cancel` aborts a run in flight; the protocol answers with
#      stopReason "cancelled".
#   3. The permission path: a guarded command reaches the client as a real
#      `session/request_permission`; reject_once blocks the call, allow_once
#      executes it — before the tool ever runs.
#
# Run from experimental/durable/:  bash proof-acp.sh
# All output lands in .data/acp-proof/ (gitignored) and is printed at the end.
set -uo pipefail
cd "$(dirname "$0")"

OUT=.data/acp-proof
CLIENT=../acp-client/client.js
mkdir -p "$OUT"
step() { printf '\n=== %s\n' "$*"; }
FAIL=0

# --- the daemon the ACP endpoint is a client of -----------------------------------
step "starting the daemon (node cli.js serve)"
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
echo "daemon up (pid $DAEMON_PID)"

cleanup() {
	node cli.js stop >/dev/null 2>&1
	wait "$DAEMON_PID" 2>/dev/null
}
trap cleanup EXIT

# --- 1. handshake, session, streaming prompt ---------------------------------------
step "1. ACP flow: initialize → session/new → prompt (streamed updates + final answer)"
node "$CLIENT" flow "Reply with exactly: ACP-OK" >"$OUT/flow.out" 2>"$OUT/flow.err"
echo "    exit=$?"
grep -E "^\[(initialize|session/new|prompt|stopReason)\]" "$OUT/flow.err" | sed 's/^/    /'
echo "    streamed answer: $(tail -2 "$OUT/flow.out" | head -1)"
grep -q "ACP-OK" "$OUT/flow.out" && grep -q "stopReason. end_turn" "$OUT/flow.out" \
	&& echo "    OK — handshake, session creation, live streaming and the final answer all over the wire" \
	|| { echo "FAIL: flow proof did not produce ACP-OK with stopReason end_turn"; FAIL=1; }

# --- 2. cancel a run in flight ------------------------------------------------------
step "2. ACP cancel: a 20 s tool call is aborted mid-flight"
node "$CLIENT" cancel >"$OUT/cancel.out" 2>"$OUT/cancel.err"
echo "    exit=$?"
grep -E "^\[(cancel|tool_call|stopReason)\]" "$OUT/cancel.err" | sed 's/^/    /'
grep -q "stopReason. cancelled" "$OUT/cancel.out" \
	&& echo "    OK — session/cancel aborted the run; the protocol answered stopReason cancelled" \
	|| { echo "FAIL: the cancel proof did not end cancelled"; FAIL=1; }

# --- 3. the permission path ----------------------------------------------------------
step "3. ACP permission: the guard asks the client (reject_once, then allow_once)"
node "$CLIENT" permission >"$OUT/permission.out" 2>"$OUT/permission.err"
echo "    exit=$?"
grep -E "^\[(request_permission|tool_call|tool_call_update|round|===)" "$OUT/permission.err" | sed 's/^/    /'
grep -q "Blocked by the client's decision" "$OUT/permission.err" \
	&& echo "    OK — reject_once: the call was blocked by the client's decision, before the tool ran" \
	|| { echo "FAIL: the reject_once round did not block"; FAIL=1; }
grep -q "1+0 records in" "$OUT/permission.err" \
	&& echo "    OK — allow_once: the guard passed the call to the client's decision and it executed" \
	|| { echo "FAIL: the allow_once round did not execute the command"; FAIL=1; }

if [ "$FAIL" = 1 ]; then exit 1; fi
printf '\nPROOF-ACP-OK\n'
