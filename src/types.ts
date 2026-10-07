// Shared types for the Juniper Salon waitlist prototype.

/** A client's general availability: which weekdays (0 = Sunday ... 6 = Saturday) and a time-of-day range. */
export type AvailabilityWindow = { days: number[]; from: string; to: string };

/** One person on the waitlist, as Lena described it: service, stylist preference, phone, general availability. */
export type WaitlistEntry = {
  id: string;
  name: string;
  phone: string;
  service: string;
  stylist?: string; // optional: "their preferred stylist if they listed one"
  availability: AvailabilityWindow;
  joinedAt: string; // ISO time; earliest joined is offered first
};

/** What staff enter when a cancellation opens a slot: service, stylist, date, and time. */
export type OpeningRequest = {
  service: string;
  stylist: string;
  startsAt: string; // ISO time of the appointment
  durationMinutes?: number; // Lena: lengths range from about 30 minutes to three hours (default 60)
  utcOffsetMinutes: number; // the salon's local offset, so "can they make it" uses local clock time
};

export type TextingWindow = { startHour: number; endHour: number };

export type OpeningInput = OpeningRequest & {
  openingId: string;
  waitMinutes: number; // how long each person has to reply (15 for same-day; staff choose for later slots)
  waitlist: WaitlistEntry[];
  speed: number; // 1 = real time. Demo mode uses a larger number to shorten waits.
  enforceTextingHours: boolean;
  textingWindow: TextingWindow; // assumption: Lena said "normal daytime and early evening"; no precise cutoff
  baseUrl: string;
};

export type Phase =
  | "starting"
  | "waiting_for_texting_hours"
  | "offer_out"
  | "filled"
  | "booked"
  | "unfilled"
  | "canceled";

export type PersonState =
  | "eligible"
  | "offered"
  | "accepted"
  | "declined"
  | "timed_out"
  | "skipped"
  | "withdrawn"
  | "booking_canceled";

export type PersonRow = { entryId: string; name: string; phone: string; state: PersonState; at?: string };

/** Every text or notification is simulated: it is recorded here and printed by an Activity, never sent. */
export type Message = { at: string; to: string; kind: "client" | "front_desk"; text: string; link?: string };

export type OpeningStatus = {
  openingId: string;
  phase: Phase;
  summary: string;
  opening: { service: string; stylist: string; startsAt: string; durationMinutes: number };
  currentOffer?: { entryId: string; name: string; expiresAt: string };
  filledBy?: { entryId: string; name: string };
  people: PersonRow[];
  messages: Message[];
  endedReason?: string;
};

export type ReplyInput = { entryId: string; accept: boolean };
export type CancelInput = { reason?: string };
export type CancelBookingInput = { reason: "client_canceled" | "stylist_unavailable" };

/** What a client sees on their phone: only their own offer, no other clients' information. */
export type OfferView = {
  status: "open" | "accepted" | "declined" | "expired" | "taken" | "withdrawn" | "waiting" | "not_found";
  message: string;
  opening?: { service: string; stylist: string; startsAt: string; durationMinutes: number };
  expiresAt?: string;
};
