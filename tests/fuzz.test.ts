import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";
import {
  cancelBookingSignal,
  cancelOpeningSignal,
  getStatusQuery,
  markBookedSignal,
  openingWorkflow,
  questionSignal,
  replySignal,
  sendNowSignal,
  skipCurrentSignal,
} from "../src/workflows";
import type { OpeningInput, OpeningStatus, PersonRow, WaitlistEntry } from "../src/types";

// Randomized ("fuzz") test. Instead of hand-picked scenarios, it fires many random sequences of events at an opening:
// yes and no replies from the right and the wrong people, simultaneous yes replies, questions, staff skip / cancel /
// booked / client canceled / stylist unavailable, and jumps forward in time (so offers time out). After EVERY step it
// checks the rules Lena cares about. Each run is seeded, so a failure prints a seed that replays exactly.
//
// More runs:  FUZZ_RUNS=200 npm test        Replay one run:  FUZZ_SEED=17 npm test

const RUNS = Number(process.env.FUZZ_RUNS ?? 25);
const ONLY_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
const STEPS = 14;
const TASK_QUEUE = "juniper-fuzz";
const everyDay = { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00" };
const person = (id: string, joined: string, over: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  id, name: id.toUpperCase(), phone: `555-${id}`, service: "Haircut", availability: everyDay, joinedAt: `2026-09-${joined}T10:00:00Z`, ...over,
});
// Eligible for a Haircut with Carla: ann, bo, cy, dee, gus (in that order). eve wants Color. fay wants Lena.
const waitlist: WaitlistEntry[] = [
  person("bo", "02"), person("ann", "01"), person("dee", "04"), person("cy", "03"), person("gus", "05"),
  person("eve", "01", { service: "Color" }), person("fay", "01", { stylist: "Lena" }),
];
const ELIGIBLE_ORDER = ["ann", "bo", "cy", "dee", "gus"];
const EVERYONE = [...waitlist.map((w) => w.id), "ghost"]; // "ghost" is not on the list at all

// ---- tiny seeded random number generator (mulberry32) ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let environment: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let counter = 0;
// What the random runs actually exercised (printed at the end, so a pass cannot hide a test that never reached the hard cases).
const coverage = { runs: 0, steps: 0, fills: 0, burstsWithHolder: 0, burstsWithoutHolder: 0, nonHolderYes: 0, timeouts: 0, reopens: 0, questions: 0, endedFilledThenCanceled: 0, unfilled: 0, booked: 0, canceled: 0 };
const fulfilled = new Map<string, string>(); // stand-in for the shared store of fulfilled requests

before(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      sendText: async () => ({ delivered: true, simulated: true as const }),
      notifyFrontDesk: async () => ({ delivered: true, simulated: true as const }),
      isStillWaiting: async ({ entryId }: { entryId: string }) => !fulfilled.has(entryId),
      markFulfilled: async ({ entryId, openingId }: { entryId: string; openingId: string }) => {
        fulfilled.set(entryId, openingId);
      },
      releaseEntry: async ({ entryId, openingId }: { entryId: string; openingId: string }) => {
        if (fulfilled.get(entryId) === openingId) fulfilled.delete(entryId);
      },
    },
  });
  running = worker.run();
});

after(async () => {
  worker.shutdown();
  await running;
  await environment.teardown();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Handle = WorkflowHandle<typeof openingWorkflow>;

/** Wait until the opening has stopped changing (three identical reads in a row). */
async function settle(handle: Handle): Promise<OpeningStatus> {
  let previous = "";
  let same = 0;
  for (let i = 0; i < 120; i++) {
    const status = await handle.query(getStatusQuery);
    const json = JSON.stringify(status);
    same = json === previous ? same + 1 : 0;
    if (same >= 2) return status;
    previous = json;
    await sleep(50);
  }
  throw new Error("The opening never settled");
}

const rowOf = (s: OpeningStatus, id: string): PersonRow | undefined => s.people.find((p) => p.entryId === id);
const holderOf = (s: OpeningStatus) => (s.phase === "offer_out" ? s.currentOffer?.entryId : undefined);
const acceptedIds = (s: OpeningStatus) => s.people.filter((p) => p.state === "accepted").map((p) => p.entryId).sort();
const TERMINAL = new Set(["booked", "canceled", "unfilled"]);

/** The rules that must hold after every single step, whatever happened before. */
function checkRules(s: OpeningStatus, openingId: string, ctx: string): void {
  const fail = (rule: string) => assert.fail(`${rule}\n  ${ctx}\n  status: ${JSON.stringify({ phase: s.phase, holder: s.currentOffer?.entryId, filledBy: s.filledBy?.entryId, people: s.people.map((p) => `${p.entryId}:${p.state}`) })}`);

  // Lena's non-negotiable: never two winners.
  if (s.people.filter((p) => p.state === "accepted").length > 1) fail("RULE 1: two people are 'accepted' at once");

  // Exactly one person holds the offer while an offer is out, and nobody otherwise.
  const offered = s.people.filter((p) => p.state === "offered");
  if (s.phase === "offer_out") {
    if (offered.length !== 1 || s.currentOffer?.entryId !== offered[0]?.entryId) fail("RULE 2: during an offer exactly one person must hold it");
  } else if (offered.length !== 0 || s.currentOffer) {
    fail("RULE 2: nobody may hold an offer when none is out");
  }

  // 'Filled' and 'booked' always point at exactly the one accepted person.
  if (s.phase === "filled" || s.phase === "booked") {
    if (!s.filledBy || rowOf(s, s.filledBy.entryId)?.state !== "accepted") fail("RULE 3: filled/booked must point at the accepted person");
  } else if (s.filledBy) {
    fail("RULE 3: filledBy must be empty unless the opening is filled or booked");
  }

  // A canceled or unfilled opening cannot leave anyone still confirmed, and whoever lost a booking was told.
  if ((s.phase === "canceled" || s.phase === "unfilled") && s.people.some((p) => p.state === "accepted")) fail("RULE 3b: a finished opening still has a confirmed person");
  for (const p of s.people.filter((q) => q.state === "booking_canceled")) {
    if (!s.messages.some((m) => m.kind === "client" && m.to.toLowerCase() === p.entryId && m.text.includes("no longer available"))) fail(`RULE 3b: ${p.entryId} lost their booking but was never told`);
  }

  // Nobody is offered the same opening twice, and offers go out in waitlist order.
  const offerRecipients = s.messages.filter((m) => m.kind === "client" && m.link).map((m) => m.to.toLowerCase());
  if (new Set(offerRecipients).size !== offerRecipients.length) fail("RULE 4: someone received two offers for one opening");
  const positions = offerRecipients.map((id) => ELIGIBLE_ORDER.indexOf(id));
  if (positions.some((p) => p < 0)) fail("RULE 4: an offer went to someone who is not eligible");
  if (positions.some((p, i) => i > 0 && p <= positions[i - 1])) fail("RULE 4: offers did not go out in waitlist order");

  // Every acceptance produced exactly one confirmation and one front-desk 'FILLED' message.
  const acceptances = s.people.filter((p) => p.state === "accepted" || p.state === "booking_canceled").length;
  const confirmations = s.messages.filter((m) => m.kind === "client" && m.text.includes("You're confirmed")).length;
  const filledNotices = s.messages.filter((m) => m.kind === "front_desk" && m.text.startsWith("FILLED")).length;
  if (confirmations !== acceptances) fail(`RULE 5: ${confirmations} confirmations for ${acceptances} acceptances`);
  if (filledNotices !== acceptances) fail(`RULE 5: ${filledNotices} FILLED notices for ${acceptances} acceptances`);

  // A request is marked fulfilled exactly while its person is accepted (and released when the booking is canceled).
  for (const p of s.people) {
    const isFulfilled = fulfilled.get(p.entryId) === openingId;
    if ((p.state === "accepted") !== isFulfilled) fail(`RULE 6: ${p.entryId} is ${p.state} but fulfilled=${isFulfilled}`);
  }

  // Finished openings have nobody still holding an offer, and always say what happened.
  if (TERMINAL.has(s.phase) && offered.length > 0) fail("RULE 7: a finished opening still has an offer out");
  if (!s.summary) fail("RULE 7: the summary is empty");
}

type Step = { label: string; run: (before: OpeningStatus) => Promise<void>; expect?: (before: OpeningStatus, after: OpeningStatus) => void };

function chooseStep(rand: () => number, handle: Handle): Step {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const roll = rand();
  const who = pick(EVERYONE);
  const send = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      /* the Workflow may already be finished; that is checked separately */
    }
  };

  if (roll < 0.2) {
    return {
      label: `${who} says YES`,
      run: () => send(() => handle.signal(replySignal, { entryId: who, accept: true })),
      expect: (b, a) => {
        const holder = holderOf(b);
        if (holder === who) {
          assert.equal(a.phase, "filled", "the holder's yes must fill the opening");
          assert.equal(a.filledBy?.entryId, who);
        } else {
          assert.deepEqual(acceptedIds(a), acceptedIds(b), "a yes from someone who does not hold the offer must never be accepted");
        }
      },
    };
  }
  if (roll < 0.4) {
    const group = EVERYONE.filter(() => rand() < 0.6).concat(who);
    const uniq = [...new Set(group)];
    return {
      label: `simultaneous YES from [${uniq.join(", ")}]`,
      run: () => send(async () => void (await Promise.all(uniq.map((id) => handle.signal(replySignal, { entryId: id, accept: true }))))),
      expect: (b, a) => {
        const holder = holderOf(b);
        if (holder && uniq.includes(holder)) {
          assert.equal(a.phase, "filled", "when the holder is among the simultaneous yes replies, the opening fills");
          assert.deepEqual(acceptedIds(a), [holder], "exactly the holder wins, nobody else");
        } else {
          assert.deepEqual(acceptedIds(a), acceptedIds(b), "simultaneous yes replies from non-holders must never win");
        }
      },
    };
  }
  if (roll < 0.5) {
    return {
      label: `${who} says NO`,
      run: () => send(() => handle.signal(replySignal, { entryId: who, accept: false })),
      expect: (b, a) => {
        if (holderOf(b) === who) assert.equal(rowOf(a, who)?.state, "declined", "the holder's no is a decline");
        else assert.deepEqual(acceptedIds(a), acceptedIds(b));
      },
    };
  }
  if (roll < 0.6) {
    return {
      label: `${who} asks a QUESTION`,
      run: () => send(() => handle.signal(questionSignal, { entryId: who, note: "Can I bring a friend?" })),
      expect: (b, a) => {
        if (TERMINAL.has(b.phase)) return;
        assert.equal(a.phase, b.phase, "a question must never change the phase");
        assert.equal(holderOf(a), holderOf(b), "a question must never change who holds the offer");
        assert.deepEqual(acceptedIds(a), acceptedIds(b), "a question is never an acceptance");
      },
    };
  }
  if (roll < 0.68) {
    return {
      label: "staff SKIP",
      run: () => send(() => handle.signal(skipCurrentSignal)),
      expect: (b, a) => {
        const holder = holderOf(b);
        if (holder) assert.equal(rowOf(a, holder)?.state, "skipped");
      },
    };
  }
  if (roll < 0.76) {
    const reason = pick(["client_canceled", "stylist_unavailable"] as const);
    return {
      label: `booking canceled (${reason})`,
      run: () => send(() => handle.signal(cancelBookingSignal, { reason })),
      expect: (b, a) => {
        if (b.phase === "filled") {
          assert.equal(rowOf(a, b.filledBy!.entryId)?.state, "booking_canceled");
          assert.equal(a.filledBy, undefined);
        }
      },
    };
  }
  if (roll < 0.82) {
    return {
      label: "front desk marks BOOKED",
      run: () => send(() => handle.signal(markBookedSignal)),
      expect: (b, a) => {
        if (b.phase === "filled") assert.equal(a.phase, "booked");
        else if (b.phase !== "booked") assert.equal(a.phase, b.phase, "mark-booked must do nothing unless the opening is filled");
      },
    };
  }
  if (roll < 0.85) {
    return {
      label: "staff CANCEL the opening",
      run: () => send(() => handle.signal(cancelOpeningSignal, {})),
      expect: (b, a) => {
        if (!TERMINAL.has(b.phase)) assert.equal(a.phase, "canceled");
      },
    };
  }
  if (roll < 0.88) {
    return { label: "staff press SEND NOW", run: () => send(() => handle.signal(sendNowSignal)) };
  }
  // Jump forward in time: whoever holds the offer runs out of time.
  return {
    label: "TIME PASSES (16 minutes)",
    run: () => send(() => environment.sleep(16 * 60 * 1000)),
    expect: (b, a) => {
      const holder = holderOf(b);
      if (holder) assert.equal(rowOf(a, holder)?.state, "timed_out", "an offer nobody answered must time out");
    },
  };
}

async function oneRun(seed: number): Promise<void> {
  const rand = rng(seed);
  fulfilled.clear();
  const now = await environment.currentTimeMs();
  const input: OpeningInput = {
    openingId: `fuzz-${seed}-${++counter}`,
    service: "Haircut",
    stylist: "Carla",
    startsAt: new Date(now + 30 * 24 * 3_600_000).toISOString(), // far away, so only the 15-minute offer timers matter
    utcOffsetMinutes: 0,
    durationMinutes: 60,
    waitMinutes: 15,
    waitlist,
    speed: 1,
    enforceTextingHours: false,
    textingWindow: { startHour: 8, endHour: 20 },
    baseUrl: "http://localhost:3000",
  };
  const handle = await environment.client.workflow.start(openingWorkflow, { workflowId: input.openingId, taskQueue: TASK_QUEUE, args: [input] });
  const trail: string[] = [];
  let status = await settle(handle);
  checkRules(status, input.openingId, `seed ${seed}, at the start`);

  for (let i = 0; i < STEPS; i++) {
    const step = chooseStep(rand, handle);
    trail.push(step.label);
    const before = status;
    await step.run(before);
    status = await settle(handle);
    const ctx = `seed ${seed} (replay with FUZZ_SEED=${seed})\n  steps so far: ${trail.map((t, n) => `${n + 1}. ${t}`).join(" | ")}`;
    checkRules(status, input.openingId, ctx);
    coverage.steps++;
    if (before.phase !== "filled" && status.phase === "filled") coverage.fills++;
    if (before.phase === "filled" && before.filledBy && status.phase !== "filled" && status.phase !== "booked" && status.phase !== "canceled") coverage.reopens++;
    if (step.label.startsWith("simultaneous")) (holderOf(before) && step.label.includes(holderOf(before)!) ? coverage.burstsWithHolder++ : coverage.burstsWithoutHolder++);
    if (step.label.endsWith("says YES") && holderOf(before) && !step.label.startsWith(holderOf(before)!)) coverage.nonHolderYes++;
    if (step.label.startsWith("TIME") && holderOf(before)) coverage.timeouts++;
    if (step.label.includes("QUESTION") && !TERMINAL.has(before.phase)) coverage.questions++;
    try {
      step.expect?.(before, status);
    } catch (error) {
      assert.fail(`${(error as Error).message}\n  ${ctx}\n  before: ${JSON.stringify({ phase: before.phase, holder: holderOf(before) })}\n  after: ${JSON.stringify({ phase: status.phase, holder: holderOf(status), accepted: acceptedIds(status) })}`);
    }
    if (TERMINAL.has(status.phase)) break;
  }

  // End the opening cleanly, then make sure it really finishes.
  if (!TERMINAL.has(status.phase)) {
    try {
      await handle.signal(cancelOpeningSignal, {});
    } catch {
      /* already finished */
    }
  }
  const result = await handle.result();
  assert.ok(TERMINAL.has(result.phase) || result.phase === "filled", `seed ${seed}: the Workflow ended in an unexpected phase ${result.phase}`);
  const finalStatus = await handle.query(getStatusQuery);
  coverage.runs++;
  if (result.phase === "unfilled") coverage.unfilled++;
  if (result.phase === "booked") coverage.booked++;
  if (result.phase === "canceled") coverage.canceled++;
  if (result.phase === "canceled" && trail.some((s) => s.includes("YES"))) coverage.endedFilledThenCanceled++;
  checkRules(finalStatus, input.openingId, `seed ${seed}, at the end (steps: ${trail.join(" | ")})`);

  // Late replies to a finished opening change nothing.
  const frozen = JSON.stringify(finalStatus);
  for (const id of ELIGIBLE_ORDER) {
    try {
      await handle.signal(replySignal, { entryId: id, accept: true });
    } catch {
      /* finished Workflows refuse signals, which is the point */
    }
  }
  assert.equal(JSON.stringify(await handle.query(getStatusQuery)), frozen, `seed ${seed}: a late yes changed a finished opening`);
}

test(`randomized: ${ONLY_SEED !== undefined ? `seed ${ONLY_SEED}` : `${RUNS} seeded runs of up to ${STEPS} random events`}, rules checked after every step`, { timeout: 15 * 60 * 1000 }, async () => {
  const seeds = ONLY_SEED !== undefined ? [ONLY_SEED] : Array.from({ length: RUNS }, (_, i) => i + 1);
  for (const seed of seeds) await oneRun(seed);
  console.log(`fuzz coverage over ${coverage.runs} runs: ${JSON.stringify(coverage)}`);
});
