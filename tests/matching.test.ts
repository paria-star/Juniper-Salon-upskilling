import assert from "node:assert/strict";
import { test } from "node:test";
import { canMakeIt, eligibleOrdered, formatClock, formatDuration, formatWhen, insideTextingWindow, nextWindowOpen } from "../src/matching";
import type { WaitlistEntry } from "../src/types";

const sat2pm = Date.parse("2026-10-10T14:00:00Z"); // a Saturday, with offset 0
const entry = (over: Partial<WaitlistEntry>): WaitlistEntry => ({
  id: "x", name: "X", phone: "555", service: "Haircut",
  availability: { days: [6], from: "09:00", to: "17:00" }, joinedAt: "2026-09-01T00:00:00Z", ...over,
});

test("availability: the right weekday and time-of-day range", () => {
  assert.equal(canMakeIt({ days: [6], from: "09:00", to: "17:00" }, sat2pm, 0), true);
  assert.equal(canMakeIt({ days: [1, 2], from: "09:00", to: "17:00" }, sat2pm, 0), false); // wrong weekday
  assert.equal(canMakeIt({ days: [6], from: "15:00", to: "18:00" }, sat2pm, 0), false); // too early for them
});

test("availability uses the salon's local clock, not UTC", () => {
  // 14:00 UTC is 07:00 in a UTC-7 salon, which is before this client's 09:00 start
  assert.equal(canMakeIt({ days: [6], from: "09:00", to: "17:00" }, sat2pm, -420), false);
});

test("ordering is by who joined the waitlist first, then by id", () => {
  const list = [entry({ id: "b", joinedAt: "2026-09-03T00:00:00Z" }), entry({ id: "a", joinedAt: "2026-09-02T00:00:00Z" }), entry({ id: "c", joinedAt: "2026-09-02T00:00:00Z" })];
  const out = eligibleOrdered(list, { service: "Haircut", stylist: "Carla", startsAt: new Date(sat2pm).toISOString(), utcOffsetMinutes: 0 });
  assert.deepEqual(out.map((e) => e.id), ["a", "c", "b"]);
});

test("texting window, including one that wraps past midnight", () => {
  const at = (h: number) => Date.parse(`2026-10-10T${String(h).padStart(2, "0")}:30:00Z`);
  const day = { startHour: 8, endHour: 20 };
  assert.equal(insideTextingWindow(at(7), 0, day), false);
  assert.equal(insideTextingWindow(at(8), 0, day), true);
  assert.equal(insideTextingWindow(at(19), 0, day), true);
  assert.equal(insideTextingWindow(at(20), 0, day), false);
  const wrap = { startHour: 22, endHour: 6 };
  assert.equal(insideTextingWindow(at(23), 0, wrap), true);
  assert.equal(insideTextingWindow(at(3), 0, wrap), true);
  assert.equal(insideTextingWindow(at(12), 0, wrap), false);
});

test("next time the window opens", () => {
  const w = { startHour: 8, endHour: 20 };
  assert.equal(new Date(nextWindowOpen(Date.parse("2026-10-10T21:00:00Z"), 0, w)).toISOString(), "2026-10-11T08:00:00.000Z");
  assert.equal(new Date(nextWindowOpen(Date.parse("2026-10-10T05:00:00Z"), 0, w)).toISOString(), "2026-10-10T08:00:00.000Z");
});

test("plain-English time formatting", () => {
  assert.equal(formatWhen(sat2pm, 0), "Sat, Oct 10, 2:00 PM");
  assert.equal(formatClock(Date.parse("2026-10-10T00:05:00Z"), 0), "12:05 AM");
});

test("the whole appointment must fit in their availability (a 3-hour color is not offered to someone free for 1 hour)", () => {
  const free = { days: [6], from: "13:00", to: "16:00" }; // free 1 PM to 4 PM; the slot starts at 2 PM
  assert.equal(canMakeIt(free, sat2pm, 0, 60), true);
  assert.equal(canMakeIt(free, sat2pm, 0, 120), true); // ends exactly at 4 PM
  assert.equal(canMakeIt(free, sat2pm, 0, 180), false);
  const out = eligibleOrdered([entry({ id: "a", availability: free })], { service: "Haircut", stylist: "", startsAt: new Date(sat2pm).toISOString(), utcOffsetMinutes: 0, durationMinutes: 180 });
  assert.equal(out.length, 0);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(30), "30 minutes");
  assert.equal(formatDuration(60), "1 hour");
  assert.equal(formatDuration(90), "1 hour 30 minutes");
  assert.equal(formatDuration(180), "3 hours");
});
