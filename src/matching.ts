import type { AvailabilityWindow, OpeningRequest, TextingWindow, WaitlistEntry } from "./types";

// Pure, deterministic helpers (safe to use inside a Workflow and easy to unit-test).

const DAY_MS = 24 * 60 * 60 * 1000;

export function localClock(ms: number, utcOffsetMinutes: number): { day: number; minutes: number; hour: number } {
  const d = new Date(ms + utcOffsetMinutes * 60_000);
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), hour: d.getUTCHours() };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** The whole appointment has to fit inside their availability, so a 3-hour color is not offered to someone free for only one hour. */
export function canMakeIt(a: AvailabilityWindow, startsAtMs: number, utcOffsetMinutes: number, durationMinutes = 0): boolean {
  const { day, minutes } = localClock(startsAtMs, utcOffsetMinutes);
  return a.days.includes(day) && minutes >= toMinutes(a.from) && minutes + durationMinutes <= toMinutes(a.to);
}

/** 30 -> "30 minutes", 90 -> "1 hour 30 minutes", 180 -> "3 hours". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h > 1 ? "s" : ""}` : "";
  const mins = m ? `${m} minutes` : "";
  return [hours, mins].filter(Boolean).join(" ");
}

/** Lena's rule: same service, a time they can actually make, and their preferred stylist if they listed one. */
export function isEligible(entry: WaitlistEntry, opening: OpeningRequest): boolean {
  if (entry.service !== opening.service) return false;
  if (entry.stylist && opening.stylist && entry.stylist !== opening.stylist) return false;
  return canMakeIt(entry.availability, Date.parse(opening.startsAt), opening.utcOffsetMinutes, opening.durationMinutes ?? 60);
}

/** Eligible people, earliest on the waitlist first ("whoever joined the waitlist earliest"). */
export function eligibleOrdered(waitlist: WaitlistEntry[], opening: OpeningRequest): WaitlistEntry[] {
  return waitlist
    .filter((e) => isEligible(e, opening))
    .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.id.localeCompare(b.id));
}

/** Is this moment inside the allowed texting hours? Handles windows that wrap past midnight. */
export function insideTextingWindow(ms: number, utcOffsetMinutes: number, w: TextingWindow): boolean {
  const { hour } = localClock(ms, utcOffsetMinutes);
  return w.startHour < w.endHour ? hour >= w.startHour && hour < w.endHour : hour >= w.startHour || hour < w.endHour;
}

/** The next moment the texting window opens (in UTC ms), strictly after `ms` if we are currently outside it. */
export function nextWindowOpen(ms: number, utcOffsetMinutes: number, w: TextingWindow): number {
  const local = ms + utcOffsetMinutes * 60_000;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  let candidate = dayStart + w.startHour * 3_600_000;
  if (candidate <= local) candidate += DAY_MS;
  return candidate - utcOffsetMinutes * 60_000;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable local time without Intl (keeps Workflow code deterministic). Example: "Sat, Oct 10, 2:00 PM". */
export function formatWhen(ms: number, utcOffsetMinutes: number): string {
  const d = new Date(ms + utcOffsetMinutes * 60_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export function formatClock(ms: number, utcOffsetMinutes: number): string {
  const d = new Date(ms + utcOffsetMinutes * 60_000);
  const h = d.getUTCHours();
  return `${((h + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
