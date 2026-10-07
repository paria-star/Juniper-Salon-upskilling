# How this prototype was tested

Run everything: `npm test` (35 tests, about 50 seconds, no Docker needed). Type check: `npm run typecheck`.

## What is covered

| Test file | What it checks |
|---|---|
| `tests/matching.test.ts` | Who is eligible (service, time they can make, stylist preference), waitlist order, texting hours, appointment length fitting someone's availability |
| `tests/workflow.test.ts` | The opening Workflow with a fast-forwarding clock: offers in order, timeouts, decline, skip, cancel, client canceled, stylist unavailable, fulfilled requests, questions flagged for staff, and "never two winners" |
| `tests/pages.test.ts` | Every `id` in the two web pages is unique, and every element the scripts look up exists (this caught a real bug, see below) |
| `tests/fuzz.test.ts` | Randomized: see next section |
| `scripts/restart-test.sh` | Crash and restart: see the section after next |

## Randomized test (`tests/fuzz.test.ts`)

Hand-picked scenarios only test what I thought of. This test fires random sequences of events at an opening and checks the same rules after every step:

- Events: yes and no from the person holding the offer and from people who do not, several simultaneous yes replies, questions, staff skip / cancel / mark booked, client canceled, stylist unavailable, "send now", and 16-minute jumps in time so offers time out.
- Rules checked after every step: never two accepted people; exactly one person holds an offer while one is out; "filled" always points at the one accepted person; nobody is offered the same opening twice, and offers go out in waitlist order; every acceptance has exactly one confirmation and one front-desk "FILLED" message; a request is marked fulfilled exactly while its person is accepted; a canceled opening never leaves anyone confirmed, and anyone who lost a booking was told; a finished opening has no offer out; late replies to a finished opening change nothing.
- Checks tied to the event: a yes from someone who does not hold the offer is never accepted; simultaneous yes replies produce exactly the holder as winner when the holder is among them; a question never changes the phase or who holds the offer; an unanswered offer times out.
- Every run is seeded. A failure prints the seed and the steps, and `FUZZ_SEED=<n> npm test` replays it. `FUZZ_RUNS=300 npm test` runs more.

Results on 2026-10-07:

- 300 seeded runs passed: 2,834 steps, 248 fills, 574 simultaneous-yes bursts (215 including the holder), 305 yes replies from people not holding the offer, 191 timeouts, 48 reopened slots after a cancellation, 294 questions.
- The default `npm test` run uses 25 seeds.

**Does it actually catch mistakes?** I broke the Workflow on purpose five ways and ran the test each time. All five were caught, with the seed printed:

1. Anyone, not just the person holding the offer, can win: caught (rule: exactly one holder).
2. The request is not marked fulfilled on acceptance: caught.
3. Staff cancel after a client was confirmed and the client is not told: caught once I added the "canceled opening leaves nobody confirmed" rule (the first version of the rules missed it, so I strengthened them).
4. A question is treated as a yes: caught.
5. A timed-out offer is not recorded as timed out: caught.

**Bugs the test found in the real code**

- Canceling an opening that was already filled left the confirmed client untold and still marked fulfilled. Fixed (Lena: the client "should be told it's no longer available").

## Crash and restart test (`scripts/restart-test.sh`)

The reason to use Temporal is that an opening keeps going when something crashes. The script checks that against the real local Temporal server (needs Docker, about two minutes).

- **A.** `kill -9` the Worker in the middle of an offer, keep it down past the 20-second timer, then start it again. Result: the missed timer fires on restart, the offer moves to the next person, the person who did not answer is recorded as "no reply", and the question flag raised before the crash is still there.
- **B.** Restart the Temporal server, the API and the Worker together. Result: the opening comes back with the same messages and the same person holding the offer, and a yes after the restart fills it.

Result on 2026-10-07: 8 of 8 checks passed. (An earlier run of the script failed one check because my own test data from a previous manual test had already marked someone fulfilled; the script now resets the demo waitlist first.)

## Other bugs found by testing by hand

Clicking an empty hour on the calendar picked the wrong hour under page zoom; the eligible list showed everyone twice; the page redrew its buttons every 2 seconds and could swallow a click; the question box never read what the client typed because two elements shared an id; and the Workflow tests would have failed for about one hour a day, because "all day" availability ended at 23:59 and the appointment length no longer fit after 22:59 UTC. All are fixed.

## What is NOT tested

- Two different openings offering the same person at the same moment (they can accept both). Known gap, listed in the README.
- Daylight-saving changes and appointments near midnight.
- A full real-time run (demo mode off) beyond the pause for texting hours and the "send now" override.
- Browsers other than Chrome, a real phone, and the staff page on a narrow screen.
- Killing the Temporal server with `kill -9` (the restart test uses a normal restart).
- Real text messages, Square, and the real Google Sheet (all simulated or left out on purpose).
