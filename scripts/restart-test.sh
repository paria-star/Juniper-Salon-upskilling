#!/usr/bin/env bash
# Restart test: shows that an opening survives (A) a Worker that is killed hard and stays down while an offer
# timer runs out, and (B) a restart of the Temporal server, API and Worker together.
# Needs Docker running and ports 3000, 7233 and 8233 free. Takes about two minutes.   Run:  bash scripts/restart-test.sh
# It starts by putting every demo waitlist person back to "Waiting" (the same as the Reset button) and adds two test openings.
set -u
cd "$(dirname "$0")/.."
LOG="$(mktemp -d)"
J='content-type: application/json'
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
stop_apps() { pkill -9 -f scripts/dev.mjs 2>/dev/null; pkill -9 -f src/worker.ts 2>/dev/null; pkill -9 -f src/api.ts 2>/dev/null; true; }
start_worker() { (npm run dev:worker > "$LOG/worker.$1.log" 2>&1 &); for _ in $(seq 1 40); do grep -q polling "$LOG/worker.$1.log" 2>/dev/null && return; sleep 1; done; }
start_api() { (npm run dev:api > "$LOG/api.$1.log" 2>&1 &); for _ in $(seq 1 40); do curl -s localhost:3000/api/config >/dev/null && return; sleep 1; done; }
wait_temporal() { for _ in $(seq 1 60); do curl -s -o /dev/null localhost:8233 && return; sleep 1; done; }
# field <opening id> <javascript expression using s>   e.g. field $ID 's.phase'
field() { curl -s --max-time 10 "localhost:3000/api/openings/$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);console.log(eval(process.argv[1]))}catch(e){console.log("NO_ANSWER")}})' "$2"; }
trap 'stop_apps' EXIT

echo "Starting Temporal, Worker and API ..."
stop_apps; docker compose up -d temporal >/dev/null 2>&1; wait_temporal; start_worker 1; start_api 1
curl -s -XPOST localhost:3000/api/waitlist/reset >/dev/null

echo; echo "A) Kill the Worker (kill -9) in the middle of an offer, keep it down past the timer, then restart it"
A=$(curl -s -XPOST localhost:3000/api/openings -H "$J" -d '{"service":"Haircut","stylist":"Carla","date":"2026-10-09","time":"11:00","durationMinutes":60,"waitMinutes":20,"demoMode":true}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).openingId')
sleep 2; curl -s -XPOST localhost:3000/api/openings/$A/question -H "$J" -d '{"entryId":"w01","note":"Does this include a wash?"}' >/dev/null; sleep 1
[ "$(field $A 's.currentOffer.name')" = "Priya N." ] && ok "before the crash Priya holds the offer" || bad "before the crash Priya should hold the offer"
pkill -9 -f src/worker.ts; sleep 1
[ "$(field $A 's.phase')" = "NO_ANSWER" ] && ok "while the Worker is down nothing can answer (expected)" || bad "something answered with no Worker running"
echo "  ... waiting 30 s so Priya's 20 s timer runs out while no code is running"; sleep 30
start_worker 2; sleep 5
[ "$(field $A 's.currentOffer.name')" = "Marcus T." ] && ok "after restart the missed timer fired and the offer moved to Marcus" || bad "the offer did not move to Marcus"
[ "$(field $A 's.people[0].state')" = "timed_out" ] && ok "Priya is recorded as 'no reply'" || bad "Priya should be timed_out"
[ "$(field $A 's.people[0].flag.note')" = "Does this include a wash?" ] && ok "Priya's question flag survived the crash" || bad "the question flag was lost"

echo; echo "B) Restart the Temporal server together with the API and the Worker"
B=$(curl -s -XPOST localhost:3000/api/openings -H "$J" -d '{"service":"Color","stylist":"Lena","date":"2026-10-09","time":"13:00","durationMinutes":120,"waitMinutes":600,"demoMode":true}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).openingId')
sleep 2
BEFORE=$(field $B 's.messages.length + "|" + s.currentOffer.name')
stop_apps; docker compose restart temporal >/dev/null 2>&1; wait_temporal; start_worker 3; start_api 3; sleep 4
AFTER=$(field $B 's.messages.length + "|" + s.currentOffer.name')
[ "$BEFORE" = "$AFTER" ] && [ "$AFTER" != "NO_ANSWER" ] && ok "the opening and its messages came back unchanged ($AFTER)" || bad "the opening changed: before=$BEFORE after=$AFTER"
HOLDER=$(field $B 's.currentOffer.entryId')
curl -s -XPOST localhost:3000/api/openings/$B/reply -H "$J" -d "{\"entryId\":\"$HOLDER\",\"accept\":true}" >/dev/null; sleep 3
[ "$(field $B 's.phase')" = "filled" ] && ok "a yes after the restart fills the opening" || bad "a yes after the restart did not fill it"
[ "$(field $A 's.people[1].state')" != "NO_ANSWER" ] && ok "the opening from test A is still there too" || bad "the opening from test A is gone"

echo; echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
