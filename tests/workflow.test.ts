import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";
import {
  cancelBookingSignal,
  cancelOpeningSignal,
  getOfferViewQuery,
  getStatusQuery,
  markBookedSignal,
  openingWorkflow,
  questionSignal,
  replySignal,
  sendNowSignal,
  skipCurrentSignal,
} from "../src/workflows";
import type { OpeningInput, OpeningStatus, WaitlistEntry } from "../src/types";

const TASK_QUEUE = "juniper-test";
const everyDay = { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:59" };
const person = (id: string, joined: string, over: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  id,
  name: id.toUpperCase(),
  phone: `555-01${id.length}${id.charCodeAt(0) % 10}`,
  service: "Haircut",
  availability: everyDay,
  joinedAt: `2026-09-${joined}T10:00:00Z`,
  ...over,
});
// Joined order: ann (earliest), bo, cy, dee. "eve" wants a different service; "fay" wants a different stylist.
const waitlist: WaitlistEntry[] = [
  person("bo", "02"),
  person("ann", "01"),
  person("dee", "04"),
  person("cy", "03"),
  person("eve", "01", { service: "Color" }),
  person("fay", "01", { stylist: "Lena" }),
];

let environment: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let counter = 0;
// Stand-in for the shared store of fulfilled requests (entry id -> opening id). Reset for every test.
const fulfilled = new Map<string, string>();

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

// Appointment times are based on the TEST SERVER's clock (which skips ahead during tests), not on real time.
async function serverNow(): Promise<number> {
  return environment.currentTimeMs();
}

function inputFor(nowMs: number, over: Partial<OpeningInput> = {}): OpeningInput {
  return {
    openingId: `t-${++counter}`,
    service: "Haircut",
    stylist: "Carla",
    startsAt: new Date(nowMs + 3 * 3_600_000).toISOString(),
    utcOffsetMinutes: 0,
    waitMinutes: 15,
    waitlist,
    speed: 1,
    enforceTextingHours: false,
    textingWindow: { startHour: 8, endHour: 20 },
    baseUrl: "http://localhost:3000",
    ...over,
  };
}

async function start(over: Partial<OpeningInput> = {}, alreadyFulfilled: string[] = []) {
  fulfilled.clear();
  for (const id of alreadyFulfilled) fulfilled.set(id, "some-other-opening");
  const input = inputFor(await serverNow(), over);
  const handle = await environment.client.workflow.start(openingWorkflow, {
    workflowId: input.openingId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  return handle;
}

async function until(handle: WorkflowHandle<typeof openingWorkflow>, check: (s: OpeningStatus) => boolean, label: string) {
  let last: OpeningStatus | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      last = await handle.query(getStatusQuery);
      if (check(last)) return last;
    } catch {
      /* the Workflow may not have started its first task yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for: ${label}. Last status: ${JSON.stringify(last && { phase: last.phase, summary: last.summary })}`);
}
const holder = (s: OpeningStatus) => s.currentOffer?.entryId;
const states = (s: OpeningStatus) => Object.fromEntries(s.people.map((p) => [p.entryId, p.state]));

test("only people who match the service and stylist are eligible, earliest on the waitlist first", async () => {
  const handle = await start({ stylist: "Carla" });
  const status = await until(handle, (s) => s.phase === "offer_out", "first offer");
  assert.deepEqual(status.people.map((p) => p.entryId), ["ann", "bo", "cy", "dee"]); // no eve (Color), no fay (wants Lena)
  assert.equal(holder(status), "ann");
  await handle.signal(cancelOpeningSignal, { reason: "test over" });
  await handle.result();
});

test("a stylist preference is respected: fay is eligible only when the slot is with Lena", async () => {
  const handle = await start({ stylist: "Lena" });
  const status = await until(handle, (s) => s.phase === "offer_out", "first offer");
  assert.ok(status.people.some((p) => p.entryId === "fay"));
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("the first person to accept gets the slot; the front desk and the client are told", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  const status = await until(handle, (s) => s.phase === "filled" && s.messages.some((m) => m.kind === "front_desk"), "filled and front desk told");
  assert.equal(status.filledBy?.entryId, "ann");
  assert.equal(states(status).bo, "eligible"); // nobody else was bothered
  assert.ok(status.messages.some((m) => m.kind === "front_desk" && m.text.startsWith("FILLED") && m.text.includes("ANN")));
  assert.ok(status.messages.some((m) => m.kind === "client" && m.to === "ANN" && m.text.includes("confirmed")));
  await handle.signal(markBookedSignal);
  const final = await handle.result();
  assert.equal(final.phase, "booked");
});

test("a decline moves straight to the next person, and the decliner stays on the waitlist", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: false });
  const status = await until(handle, (s) => holder(s) === "bo", "offer to bo");
  assert.equal(states(status).ann, "declined");
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("if nobody answers, it moves to the next person by itself after the wait", async () => {
  const handle = await start({ waitMinutes: 15 });
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await environment.sleep(16 * 60_000); // skip 16 minutes without waiting
  const status = await until(handle, (s) => holder(s) === "bo", "automatic move to bo");
  assert.equal(states(status).ann, "timed_out");
  assert.ok(status.messages.some((m) => m.to === "ANN" && m.text.includes("expired")));
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("NEVER two winners: replies that arrive at the same moment produce exactly one confirmed client", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  // Ann (the holder) and Bo and Cy (not holders) all say yes at once, and Bo's arrives first.
  await Promise.all([
    handle.signal(replySignal, { entryId: "bo", accept: true }),
    handle.signal(replySignal, { entryId: "ann", accept: true }),
    handle.signal(replySignal, { entryId: "cy", accept: true }),
  ]);
  await until(handle, (s) => s.phase === "filled" && s.messages.some((m) => m.kind === "front_desk"), "filled and front desk told");
  await handle.signal(markBookedSignal);
  const final = await handle.result(); // check the settled end state, after every reply has been handled
  const accepted = final.people.filter((p) => p.state === "accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].entryId, "ann");
  assert.equal(final.messages.filter((m) => m.kind === "front_desk" && m.text.startsWith("FILLED")).length, 1);
  // the two who were not holding the offer were told it was taken, and neither was confirmed
  for (const id of ["BO", "CY"]) assert.ok(final.messages.some((m) => m.to === id && m.text.includes("no longer available")) || final.messages.some((m) => m.to === id && m.text.includes("just taken")));
  assert.equal(final.messages.filter((m) => m.text.includes("confirmed")).length, 1); // exactly one confirmation went out
});

test("the winner tapping yes twice is not told the slot was taken", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await until(handle, (s) => s.phase === "filled" && s.messages.some((m) => m.kind === "front_desk"), "filled and front desk told");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await handle.signal(markBookedSignal);
  const final = await handle.result();
  assert.equal(final.messages.filter((m) => m.to === "ANN" && m.text.includes("just taken")).length, 0);
  assert.equal(final.messages.filter((m) => m.text.includes("confirmed")).length, 1);
});

test("someone whose request is already fulfilled is not offered another slot for it", async () => {
  const handle = await start({}, ["ann"]); // ann was booked by another opening
  const status = await until(handle, (s) => s.phase === "offer_out", "first offer");
  assert.equal(holder(status), "bo"); // ann is skipped even though she joined first
  assert.equal(states(status).ann, "already_booked");
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("accepting marks the request fulfilled, and a client who cancels goes back on the waiting list", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  const filled = await until(handle, (s) => s.phase === "filled" && s.messages.some((m) => m.kind === "front_desk"), "filled");
  assert.equal(fulfilled.get("ann"), filled.openingId); // marked fulfilled by this opening
  await handle.signal(cancelBookingSignal, { reason: "client_canceled" });
  await until(handle, (s) => holder(s) === "bo", "reopened for bo");
  assert.equal(fulfilled.has("ann"), false); // her request is unmet again
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("a question is flagged for staff and is never treated as acceptance", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(questionSignal, { entryId: "ann", note: "Can I bring my daughter?" });
  const flagged = await until(handle, (s) => s.messages.some((m) => m.text.startsWith("NEEDS STAFF")), "staff flagged");
  assert.equal(flagged.phase, "offer_out"); // not filled
  assert.equal(holder(flagged), "ann"); // still her offer, timer still running
  assert.equal(flagged.people.find((p) => p.entryId === "ann")?.flag?.note, "Can I bring my daughter?");
  assert.ok(flagged.messages.some((m) => m.kind === "front_desk" && m.text.includes("NOT treated as a yes")));
  assert.equal(flagged.messages.filter((m) => m.text.includes("confirmed")).length, 0);
  assert.equal(fulfilled.has("ann"), false);
  // a question from someone who does not hold the offer changes nothing about who holds it
  await handle.signal(questionSignal, { entryId: "bo", note: "Is the slot still open?" });
  const both = await until(handle, (s) => s.people.find((p) => p.entryId === "bo")?.flag !== undefined, "bo flagged");
  assert.equal(holder(both), "ann");
  // she can still give a clear answer afterwards
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await until(handle, (s) => s.phase === "filled" && s.filledBy?.entryId === "ann", "ann accepted after her question");
  await handle.signal(markBookedSignal);
  await handle.result();
});

test("a late yes after the slot is taken gets a quick 'already taken' message and stays on the waitlist", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await until(handle, (s) => s.phase === "filled", "filled");
  await handle.signal(replySignal, { entryId: "bo", accept: true });
  const status = await until(handle, (s) => s.messages.some((m) => m.to === "BO" && m.text.includes("just taken")), "taken message to bo");
  assert.equal(status.filledBy?.entryId, "ann");
  assert.equal(states(status).bo, "eligible"); // still on the waitlist for another opening
  const view = await handle.query(getOfferViewQuery, "bo");
  assert.equal(view.status, "taken");
  await handle.signal(markBookedSignal);
  await handle.result();
});

test("a yes after the offer expired is not accepted", async () => {
  const handle = await start({ waitMinutes: 15 });
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await environment.sleep(16 * 60_000);
  await until(handle, (s) => holder(s) === "bo", "moved to bo");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  const status = await until(handle, (s) => s.messages.filter((m) => m.to === "ANN").length >= 3, "expired message");
  assert.equal(status.filledBy, undefined);
  assert.equal(states(status).ann, "timed_out");
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("when everyone has declined or timed out, it ends as unfilled and tells the front desk (never loops forever)", async () => {
  const handle = await start();
  for (const id of ["ann", "bo", "cy", "dee"]) {
    await until(handle, (s) => holder(s) === id, `offer to ${id}`);
    await handle.signal(replySignal, { entryId: id, accept: false });
  }
  const final = await handle.result();
  assert.equal(final.phase, "unfilled");
  assert.ok(final.messages.some((m) => m.kind === "front_desk" && m.text.startsWith("NOT FILLED")));
});

test("with nobody eligible it ends right away as unfilled", async () => {
  const handle = await start({ service: "Blowout" });
  const final = await handle.result();
  assert.equal(final.phase, "unfilled");
  assert.equal(final.people.length, 0);
});

test("staff can cancel: the person holding the offer is told it is no longer available", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(cancelOpeningSignal, { reason: "Stylist called in sick" });
  const final = await handle.result();
  assert.equal(final.phase, "canceled");
  assert.ok(final.messages.some((m) => m.to === "ANN" && m.text.includes("no longer available")));
});

test("staff can skip the person holding the offer", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(skipCurrentSignal);
  const status = await until(handle, (s) => holder(s) === "bo", "offer to bo");
  assert.equal(states(status).ann, "skipped");
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("if the client who accepted cancels, the slot reopens and goes to the next person", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await until(handle, (s) => s.phase === "filled", "filled");
  await handle.signal(cancelBookingSignal, { reason: "client_canceled" });
  const status = await until(handle, (s) => holder(s) === "bo", "offer to bo after reopen");
  assert.equal(states(status).ann, "booking_canceled");
  assert.ok(status.messages.some((m) => m.to === "ANN" && m.text.includes("no longer available")));
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("if the stylist becomes unavailable, the booking is canceled and the client is told", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  await handle.signal(replySignal, { entryId: "ann", accept: true });
  await until(handle, (s) => s.phase === "filled", "filled");
  await handle.signal(cancelBookingSignal, { reason: "stylist_unavailable" });
  const final = await handle.result();
  assert.equal(final.phase, "canceled");
  assert.ok(final.messages.some((m) => m.kind === "front_desk" && m.text.startsWith("CANCELED")));
});

test("outside texting hours it pauses, and staff can override with 'Send now'", async () => {
  const hour = new Date(await serverNow()).getUTCHours();
  const window = { startHour: (hour + 3) % 24, endHour: (hour + 4) % 24 }; // a window that is not open right now
  const handle = await start({ enforceTextingHours: true, textingWindow: window });
  const paused = await until(handle, (s) => s.phase === "waiting_for_texting_hours", "paused for texting hours");
  assert.ok(paused.summary.includes("Send now"));
  assert.equal(paused.messages.length, 0); // nothing was texted
  await handle.signal(sendNowSignal);
  await until(handle, (s) => holder(s) === "ann", "offer after override");
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});

test("a client's own view shows only their offer, with a reply deadline", async () => {
  const handle = await start();
  await until(handle, (s) => holder(s) === "ann", "offer to ann");
  const mine = await handle.query(getOfferViewQuery, "ann");
  assert.equal(mine.status, "open");
  assert.ok(mine.expiresAt);
  assert.equal(mine.opening?.service, "Haircut");
  const other = await handle.query(getOfferViewQuery, "bo");
  assert.equal(other.status, "waiting");
  assert.equal(JSON.stringify(other).includes("ANN"), false); // no other client's information
  await handle.signal(cancelOpeningSignal, {});
  await handle.result();
});
