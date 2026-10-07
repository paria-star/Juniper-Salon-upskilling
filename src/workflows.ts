import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import { eligibleOrdered, formatClock, formatDuration, formatWhen, insideTextingWindow, nextWindowOpen } from "./matching";
import type {
  CancelBookingInput,
  CancelInput,
  Message,
  OfferView,
  OpeningInput,
  OpeningStatus,
  Phase,
  PersonRow,
  QuestionInput,
  ReplyInput,
} from "./types";

// One Workflow = one open slot. It is the single place that decides who gets the slot, so two replies can never
// both win (Lena's non-negotiable). It waits on durable timers, so it keeps moving to the next person even if
// nobody remembers to, and it survives a restart without losing its place.

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

// Signals: things that happen to an opening.
export const replySignal = defineSignal<[ReplyInput]>("reply"); // a client accepts or declines
export const cancelOpeningSignal = defineSignal<[CancelInput]>("cancelOpening"); // staff stop the process
export const skipCurrentSignal = defineSignal("skipCurrent"); // staff skip the person who holds the offer
export const questionSignal = defineSignal<[QuestionInput]>("question"); // a client replies with something that is not a clear yes or no
export const sendNowSignal = defineSignal("sendNow"); // staff override the texting-hours pause
export const markBookedSignal = defineSignal("markBooked"); // front desk put the person on the real calendar
export const cancelBookingSignal = defineSignal<[CancelBookingInput]>("cancelBooking"); // accepted client cancels / stylist unavailable

// Queries: things staff and clients can look at.
export const getStatusQuery = defineQuery<OpeningStatus>("getStatus");
export const getOfferViewQuery = defineQuery<OfferView, [string]>("getOfferView");

export async function openingWorkflow(input: OpeningInput): Promise<OpeningStatus> {
  const startsAtMs = Date.parse(input.startsAt);
  const offset = input.utcOffsetMinutes;
  const when = formatWhen(startsAtMs, offset);
  const stylistLabel = input.stylist || "any stylist";
  const durationMinutes = input.durationMinutes ?? 60;
  const eligible = eligibleOrdered(input.waitlist, input);
  const byId = new Map(eligible.map((e) => [e.id, e]));
  const rows: PersonRow[] = eligible.map((e) => ({ entryId: e.id, name: e.name, phone: e.phone, state: "eligible" }));
  const rowOf = (id: string) => rows.find((r) => r.entryId === id);
  const nowIso = () => new Date(Date.now()).toISOString();

  const s: {
    phase: Phase;
    summary: string;
    offer?: { entryId: string; expiresAtMs: number };
    filledBy?: { entryId: string; name: string };
    endedReason?: string;
    sendNow: boolean;
    reopen: boolean;
    messages: Message[];
  } = {
    phase: "starting",
    summary: `Looking at ${eligible.length} eligible ${eligible.length === 1 ? "person" : "people"} on the waitlist.`,
    sendNow: false,
    reopen: false,
    messages: [],
  };

  const isOver = () => s.phase === "canceled" || s.phase === "booked" || s.phase === "unfilled";

  // ---- notifications (simulated texts and front-desk messages) ----
  async function textClient(entryId: string, text: string, link?: string): Promise<void> {
    const person = byId.get(entryId);
    if (!person) return;
    s.messages.push({ at: nowIso(), to: person.name, kind: "client", text, link });
    await act.sendText({ to: person.name, phone: person.phone, text: link ? `${text} ${link}` : text });
  }
  async function tellFrontDesk(text: string): Promise<void> {
    s.messages.push({ at: nowIso(), to: "Front desk", kind: "front_desk", text });
    await act.notifyFrontDesk({ text });
  }

  // ---- queries ----
  setHandler(getStatusQuery, (): OpeningStatus => ({
    openingId: input.openingId,
    phase: s.phase,
    summary: s.summary,
    opening: { service: input.service, stylist: stylistLabel, startsAt: input.startsAt, durationMinutes },
    currentOffer: s.offer
      ? { entryId: s.offer.entryId, name: byId.get(s.offer.entryId)?.name ?? "", expiresAt: new Date(s.offer.expiresAtMs).toISOString() }
      : undefined,
    filledBy: s.filledBy,
    people: rows.map((r) => ({ ...r })),
    messages: s.messages.map((m) => ({ ...m })),
    endedReason: s.endedReason,
  }));

  setHandler(getOfferViewQuery, (entryId: string): OfferView => {
    const row = rowOf(entryId);
    const opening = { service: input.service, stylist: stylistLabel, startsAt: input.startsAt, durationMinutes };
    if (!row) return { status: "not_found", message: "We could not find this offer." };
    if (s.offer?.entryId === entryId && row.flag) {
      return { status: "open", message: "We've passed your question to our staff, who will follow up with you. Your offer stays open until the deadline.", opening, expiresAt: new Date(s.offer.expiresAtMs).toISOString(), flagged: true };
    }
    if (s.offer?.entryId === entryId) {
      return { status: "open", message: "This opening is yours if you reply before the deadline.", opening, expiresAt: new Date(s.offer.expiresAtMs).toISOString() };
    }
    if (row.state === "accepted") return { status: "accepted", message: "You're confirmed. We'll see you then!", opening };
    if (row.state === "declined") return { status: "declined", message: "Thanks for letting us know. You're still on the waitlist.", opening };
    if (row.state === "timed_out") return { status: "expired", message: "This offer expired. You're still on the waitlist for the next opening.", opening };
    if (row.state === "skipped" || row.state === "withdrawn" || s.phase === "canceled") return { status: "withdrawn", message: "This opening is no longer available. You're still on the waitlist.", opening };
    if (s.phase === "filled" || s.phase === "booked") return { status: "taken", message: "Sorry, this opening was just taken. You're still on the waitlist.", opening };
    return { status: "waiting", message: "We'll text you if this opening comes your way.", opening };
  });

  // ---- signals ----
  // A reply is decided synchronously, before any await, so replies that arrive at nearly the same moment are
  // handled strictly one after another. Only the person who currently holds the offer can win.
  setHandler(replySignal, async ({ entryId, accept }: ReplyInput) => {
    const row = rowOf(entryId);
    const person = byId.get(entryId);
    if (!row || !person) return;
    const holdsOffer = s.phase === "offer_out" && s.offer?.entryId === entryId;
    if (holdsOffer) {
      s.offer = undefined;
      row.at = nowIso();
      if (accept) {
        row.state = "accepted";
        s.phase = "filled";
        s.filledBy = { entryId, name: person.name };
        s.summary = `${person.name} accepted. The front desk has been asked to add them to the calendar.`;
        // Mark their request fulfilled right away so no other opening offers them a second slot for it.
        await act.markFulfilled({ entryId, openingId: input.openingId });
        await textClient(entryId, `You're confirmed for ${input.service} with ${stylistLabel} on ${when}. We'll see you then! We've taken you off the waitlist for this request. - Juniper Salon`);
        await tellFrontDesk(`FILLED: please add ${person.name} (${person.phone}) to the calendar: ${input.service} with ${stylistLabel} on ${when}.`);
      } else {
        row.state = "declined";
        s.summary = `${person.name} declined. Moving to the next person.`;
      }
      return;
    }
    // Not their turn, or too late. Never a second winner.
    if (!accept || row.state === "accepted") return; // a winner who taps "yes" twice is simply confirmed already
    if (s.phase === "filled" || s.phase === "booked") {
      await textClient(entryId, "Sorry, that opening was just taken. You're still on our waitlist and we'll text you about the next one. - Juniper Salon");
    } else if (row.state === "timed_out") {
      await textClient(entryId, "That offer has expired. You're still on our waitlist for the next opening. - Juniper Salon");
    } else {
      await textClient(entryId, "That opening is no longer available. You're still on our waitlist. - Juniper Salon");
    }
  });

  // Lena: a reply that is not a clear yes or no "should flag that for staff rather than treating it as acceptance.
  // We can answer questions or follow up ourselves." It never changes who holds the offer, and the timer keeps running.
  setHandler(questionSignal, async ({ entryId, note }: QuestionInput) => {
    const row = rowOf(entryId);
    const person = byId.get(entryId);
    if (!row || !person || isOver()) return;
    const text = (note ?? "").trim().slice(0, 280) || "(no message)";
    const holdsOffer = s.phase === "offer_out" && s.offer?.entryId === entryId;
    row.flag = { note: text, at: nowIso() };
    if (holdsOffer && s.offer) {
      s.summary = `${person.name} replied with a question. Staff need to follow up. This was NOT treated as a yes, and the offer stays open until their time runs out.`;
      await textClient(entryId, `Thanks! A member of our staff will follow up with you. Your offer stays open until ${formatClock(s.offer.expiresAtMs, offset)}. - Juniper Salon`);
      await tellFrontDesk(`NEEDS STAFF: ${person.name} (${person.phone}) replied with a question about the ${input.service} opening on ${when}: "${text}". This was NOT treated as a yes. Please follow up. Their offer is open until ${formatClock(s.offer.expiresAtMs, offset)}.`);
    } else {
      await tellFrontDesk(`NEEDS STAFF: ${person.name} (${person.phone}) replied with a question about the ${input.service} opening on ${when}, which is no longer offered to them: "${text}". Please follow up.`);
    }
  });

  setHandler(cancelOpeningSignal, async ({ reason }: CancelInput) => {
    if (isOver()) return;
    const holder = s.offer;
    const confirmed = s.filledBy; // staff can cancel after someone was already confirmed
    s.offer = undefined;
    s.filledBy = undefined;
    s.phase = "canceled";
    s.endedReason = reason || "Canceled by staff";
    s.summary = reason ? `Canceled by staff. ${reason}` : "Canceled by staff.";
    if (confirmed) {
      // Lena: "the client should be told it's no longer available." Their request is unmet again, so they go back on the list.
      const row = rowOf(confirmed.entryId);
      if (row) row.state = "booking_canceled";
      await act.releaseEntry({ entryId: confirmed.entryId, openingId: input.openingId });
      await textClient(confirmed.entryId, `Your ${input.service} appointment on ${when} is no longer available. We're sorry about that. You're back on our waitlist. - Juniper Salon`);
      await tellFrontDesk(`CANCELED: ${input.service} on ${when}. Staff canceled it and ${confirmed.name} has been told.`);
    }
    if (holder) {
      const row = rowOf(holder.entryId);
      if (row) row.state = "withdrawn";
      await textClient(holder.entryId, "That opening is no longer available. You're still on our waitlist. - Juniper Salon");
    }
  });

  setHandler(skipCurrentSignal, async () => {
    if (s.phase !== "offer_out" || !s.offer) return;
    const holder = s.offer;
    s.offer = undefined;
    const row = rowOf(holder.entryId);
    if (row) row.state = "skipped";
    s.summary = "Staff skipped this person. Moving to the next one.";
    await textClient(holder.entryId, "That opening is no longer available. You're still on our waitlist. - Juniper Salon");
  });

  setHandler(sendNowSignal, () => {
    s.sendNow = true;
  });

  setHandler(markBookedSignal, () => {
    if (s.phase !== "filled") return;
    s.phase = "booked";
    s.summary = `${s.filledBy?.name ?? "The client"} is on the real calendar. Done.`;
  });

  setHandler(cancelBookingSignal, async ({ reason }: CancelBookingInput) => {
    if (s.phase !== "filled" && s.phase !== "booked") return;
    const who = s.filledBy;
    if (!who) return;
    const row = rowOf(who.entryId);
    if (row) row.state = "booking_canceled";
    s.filledBy = undefined;
    // Their request is unmet again, so they go back on the waiting list for other openings.
    await act.releaseEntry({ entryId: who.entryId, openingId: input.openingId });
    await textClient(who.entryId, `Your ${input.service} appointment on ${when} is no longer available. We're sorry about that. - Juniper Salon`);
    if (reason === "stylist_unavailable") {
      s.phase = "canceled";
      s.endedReason = "The stylist became unavailable.";
      s.summary = "Canceled: the stylist became unavailable. The client has been told.";
      await tellFrontDesk(`CANCELED: ${input.service} on ${when}. The stylist is unavailable and ${who.name} has been told.`);
    } else {
      s.reopen = true;
      s.phase = "starting";
      s.summary = `${who.name} canceled. Reopening the slot for the next person.`;
      await tellFrontDesk(`REOPENED: ${who.name} canceled the ${input.service} on ${when}. Offering it to the next person.`);
    }
  });

  // ---- the process ----
  async function offerToEveryoneInOrder(): Promise<void> {
    for (const person of eligible) {
      const row = rowOf(person.id);
      if (!row || row.state !== "eligible") continue;
      if (s.phase === "filled" || isOver()) return;

      // Respect texting hours (Lena: avoid very early mornings and late evenings; no precise cutoff).
      const now = Date.now();
      if (input.enforceTextingHours && !insideTextingWindow(now, offset, input.textingWindow)) {
        const opensAt = nextWindowOpen(now, offset, input.textingWindow);
        if (opensAt >= startsAtMs) {
          s.summary = "No allowed texting hours are left before the appointment time.";
          return;
        }
        s.phase = "waiting_for_texting_hours";
        s.summary = `Paused until texting hours open at ${formatClock(opensAt, offset)}. Staff can press "Send now" to override.`;
        s.sendNow = false;
        await condition(() => s.sendNow || isOver(), opensAt - now);
        if (isOver()) return;
      }

      // Another opening may have fulfilled this person's request while we were waiting.
      if (!(await act.isStillWaiting({ entryId: person.id }))) {
        row.state = "already_booked";
        row.at = nowIso();
        continue;
      }

      const start = Date.now();
      if (start >= startsAtMs - 1000) {
        s.summary = "The appointment time has been reached.";
        return;
      }
      const waitMs = Math.max(1000, Math.round((input.waitMinutes * 60_000) / input.speed));
      const expiresAtMs = Math.min(start + waitMs, startsAtMs);
      s.offer = { entryId: person.id, expiresAtMs };
      s.phase = "offer_out";
      row.state = "offered";
      row.at = nowIso();
      s.summary = `Offered to ${person.name} - waiting for a reply.`;
      const link = `${input.baseUrl}/offer.html?opening=${encodeURIComponent(input.openingId)}&entry=${encodeURIComponent(person.id)}`;
      await textClient(
        person.id,
        `Juniper Salon: an opening just came up for a ${input.service} (about ${formatDuration(durationMinutes)}) with ${stylistLabel} on ${when}. Reply by ${formatClock(expiresAtMs, offset)}:`,
        link,
      );

      // Durable timer. If nobody answers, it moves on by itself. Nobody has to remember.
      const answered = await condition(() => s.offer?.entryId !== person.id || s.phase !== "offer_out", expiresAtMs - Date.now());
      if (!answered && s.offer?.entryId === person.id) {
        s.offer = undefined;
        row.state = "timed_out";
        row.at = nowIso();
        s.summary = `${person.name} did not reply in time. Moving to the next person.`;
        await textClient(person.id, "That offer has expired. You're still on our waitlist for the next opening. - Juniper Salon");
      }
    }
  }

  while (!isOver()) {
    await offerToEveryoneInOrder();
    if (s.phase === "canceled") break;
    if (s.phase === "filled") {
      // Wait for the front desk to put them on the real calendar (or for a cancellation), until the appointment time.
      await condition(() => s.phase !== "filled" || s.reopen, Math.max(1000, startsAtMs - Date.now()));
      if (s.reopen) {
        s.reopen = false;
        continue;
      }
      break;
    }
    if (isOver()) break;
    // The list ran out. The process must finish; it never keeps going indefinitely.
    s.phase = "unfilled";
    s.endedReason = "Nobody on the waitlist took the opening.";
    s.summary = "Unfilled. The front desk has been told the automatic process is finished.";
    await tellFrontDesk(
      `NOT FILLED: nobody took the ${input.service} opening with ${stylistLabel} on ${when}. The automatic process is finished. Try your usual outreach if you'd like to keep going.`,
    );
  }

  await condition(allHandlersFinished);
  return {
    openingId: input.openingId,
    phase: s.phase,
    summary: s.summary,
    opening: { service: input.service, stylist: stylistLabel, startsAt: input.startsAt, durationMinutes },
    filledBy: s.filledBy,
    people: rows.map((r) => ({ ...r })),
    messages: s.messages.map((m) => ({ ...m })),
    endedReason: s.endedReason,
  };
}
