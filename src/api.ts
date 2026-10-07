import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, Connection } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { eligibleOrdered } from "./matching";
import { DEFAULT_TEXTING_WINDOW, SERVICES, STYLISTS, seedWaitlist } from "./seed";
import type { OfferView, OpeningInput, OpeningStatus } from "./types";
import {
  cancelBookingSignal,
  cancelOpeningSignal,
  getOfferViewQuery,
  getStatusQuery,
  markBookedSignal,
  openingWorkflow,
  replySignal,
  sendNowSignal,
  skipCurrentSignal,
} from "./workflows";

const TASK_QUEUE = "juniper-waitlist";
const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

// The waitlist lives in memory for this prototype (a real system would use the salon's own sheet or a database).
const waitlist = seedWaitlist();

// Openings staff removed from the calendar. The Temporal history is kept; this only hides them from the calendar.
const DISMISSED_FILE = path.join(process.cwd(), ".data", "dismissed.json");
const dismissed = new Set<string>(
  (() => {
    try {
      return JSON.parse(fs.readFileSync(DISMISSED_FILE, "utf8")) as string[];
    } catch {
      return [];
    }
  })(),
);
function saveDismissed(): void {
  fs.mkdirSync(path.dirname(DISMISSED_FILE), { recursive: true });
  fs.writeFileSync(DISMISSED_FILE, JSON.stringify([...dismissed]));
}

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

/** The salon's local time is this computer's local time. */
function parseLocal(date: string, time: string): { startsAt: string; utcOffsetMinutes: number } {
  const d = new Date(`${date}T${time}:00`);
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error("Please enter a valid date and time."), { status: 400 });
  return { startsAt: d.toISOString(), utcOffsetMinutes: -d.getTimezoneOffset() };
}

const handleOf = async (id: string) => (await getClient()).workflow.getHandle(id);

app.get("/api/config", (_req, res) => {
  res.json({ services: SERVICES, stylists: STYLISTS, textingWindow: DEFAULT_TEXTING_WINDOW });
});

app.get("/api/waitlist", (_req, res) => {
  res.json(waitlist);
});

// "Show me the eligible waitlist people": same service, a time they can make, their preferred stylist if they listed one.
app.get("/api/eligible", (req, res) => {
  const { service = "", stylist = "", date = "", time = "", duration = "60" } = req.query as Record<string, string>;
  const slot = parseLocal(date, time);
  const people = eligibleOrdered(waitlist, { service, stylist, durationMinutes: Number(duration) || 60, ...slot });
  res.json(people.map(({ id, name, stylist: pref, joinedAt }) => ({ id, name, stylist: pref ?? null, joinedAt })));
});

app.post("/api/openings", async (req, res) => {
  const { service, stylist = "", date, time, waitMinutes = 15, durationMinutes = 60, demoMode = true } = req.body ?? {};
  if (!SERVICES.includes(service)) throw Object.assign(new Error("Please choose a service."), { status: 400 });
  const wait = Number(waitMinutes);
  if (!(wait > 0 && wait <= 24 * 60)) throw Object.assign(new Error("Wait time must be between 1 minute and 24 hours."), { status: 400 });
  const length = Number(durationMinutes);
  if (!(length >= 30 && length <= 180)) throw Object.assign(new Error("Appointment length must be between 30 minutes and 3 hours."), { status: 400 });
  const slot = parseLocal(String(date), String(time));
  const openingId = `opening-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const input: OpeningInput = {
    ...slot,
    durationMinutes: length,
    openingId,
    service,
    stylist,
    waitMinutes: wait,
    waitlist,
    speed: demoMode ? 60 : 1, // demo mode: one real second stands for one minute of waiting
    enforceTextingHours: !demoMode,
    textingWindow: DEFAULT_TEXTING_WINDOW,
    baseUrl,
  };
  const client = await getClient();
  await client.workflow.start(openingWorkflow, { workflowId: openingId, taskQueue: TASK_QUEUE, args: [input] });
  res.status(201).json({ openingId });
});

app.get("/api/openings", async (_req, res) => {
  const client = await getClient();
  const found: { id: string; startedAt: string }[] = [];
  for await (const info of client.workflow.list({ query: "WorkflowType = 'openingWorkflow'" })) {
    if (dismissed.has(info.workflowId)) continue;
    found.push({ id: info.workflowId, startedAt: info.startTime.toISOString() });
    if (found.length >= 100) break;
  }
  found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const results = await Promise.allSettled(
    found.slice(0, 60).map(async (f) => (await handleOf(f.id)).query<OpeningStatus>(getStatusQuery)),
  );
  res.json(results.flatMap((r) => (r.status === "fulfilled" ? [{ ...r.value, messages: undefined }] : [])));
});

app.get("/api/openings/:id", async (req, res) => {
  res.json(await (await handleOf(req.params.id)).query<OpeningStatus>(getStatusQuery));
});

// Staff controls
// Remove an opening nobody took (unfilled or canceled) from the calendar. Filled or booked openings are a record of a real appointment, so they stay.
app.post("/api/openings/:id/remove", async (req, res) => {
  const status = await (await handleOf(req.params.id)).query<OpeningStatus>(getStatusQuery);
  if (status.phase !== "unfilled" && status.phase !== "canceled") {
    throw Object.assign(new Error("Only an opening that nobody took (not filled, or canceled) can be removed. Cancel it first if it is still running."), { status: 409 });
  }
  dismissed.add(req.params.id);
  saveDismissed();
  res.json({ removed: true });
});
app.post("/api/openings/:id/cancel", async (req, res) => {
  await (await handleOf(req.params.id)).signal(cancelOpeningSignal, { reason: req.body?.reason });
  res.status(202).json({ accepted: true });
});
app.post("/api/openings/:id/skip", async (req, res) => {
  await (await handleOf(req.params.id)).signal(skipCurrentSignal);
  res.status(202).json({ accepted: true });
});
app.post("/api/openings/:id/send-now", async (req, res) => {
  await (await handleOf(req.params.id)).signal(sendNowSignal);
  res.status(202).json({ accepted: true });
});
app.post("/api/openings/:id/mark-booked", async (req, res) => {
  await (await handleOf(req.params.id)).signal(markBookedSignal);
  res.status(202).json({ accepted: true });
});
app.post("/api/openings/:id/cancel-booking", async (req, res) => {
  const reason = req.body?.reason === "stylist_unavailable" ? "stylist_unavailable" : "client_canceled";
  await (await handleOf(req.params.id)).signal(cancelBookingSignal, { reason });
  res.status(202).json({ accepted: true });
});

// Client side: no account, no login. A client sees only their own offer.
app.get("/api/offers/:id/:entryId", async (req, res) => {
  const view = await (await handleOf(req.params.id)).query<OfferView, [string]>(getOfferViewQuery, req.params.entryId);
  res.json(view);
});
app.post("/api/openings/:id/reply", async (req, res) => {
  const { entryId, accept } = req.body ?? {};
  if (typeof entryId !== "string" || typeof accept !== "boolean") throw Object.assign(new Error("Invalid reply."), { status: 400 });
  await (await handleOf(req.params.id)).signal(replySignal, { entryId, accept });
  res.status(202).json({ accepted: true });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const status = (error as { status?: number })?.status ?? 500;
  if (status >= 500) console.error(error);
  response.status(status).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

app.listen(port, () => console.log(`Juniper Salon waitlist is available at http://localhost:${port}`));
