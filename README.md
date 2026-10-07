# Juniper Salon: last-minute opening waitlist (prototype)

When a client cancels, Juniper Salon staff enter the service, stylist, date and time. The system finds the eligible people on the waitlist, offers the slot to **one person at a time**, moves to the next person automatically if they say no or do not answer, and makes sure **exactly one person gets the slot**.

Everything outward-facing is **simulated**: no real texts are sent and Square is not touched (see "Simulated or excluded" below).

## Run it

Requirements: Node.js 20 or newer, and Docker Desktop (running).

```bash
npm install
npm run dev
```

- Staff page: <http://localhost:3000> (a day/week calendar of openings with a form to start a new one)
- Temporal Web UI: <http://localhost:8233>
- Stop the local Temporal service afterwards with `npm run stop`.

Other commands: `npm test` (28 tests, no Docker needed) and `npm run typecheck`.

## Try it in two minutes

1. Open <http://localhost:3000>. The form is pre-filled. Pick a service, a stylist and a time **tomorrow during the day** (for example Haircut, Carla, 2:00 PM). The list on the left shows who is eligible, in order.
2. Click **Start offering this slot**. Demo mode is on, so the reply timer is entered in **seconds** (15 seconds stands in for Lena's 15 minutes). Untick demo mode to enter real minutes.
3. In "Messages (simulated)", open **the client's reply page** link. That is what a client would see on their phone after the text: no account, no login. Tap **Yes** or **No thanks**.
4. Watch the status update: who has the offer, who declined or timed out, who is still eligible, and whether it was filled. When someone says yes, the **front desk** gets a "please add this person to the calendar" message and everyone else who replies is told the slot is taken.
5. Try the staff buttons: **Skip this person**, **Cancel this opening**, **I put them on the calendar**, **Client canceled: offer to the next person**, and, on an opening nobody took, **Remove from calendar** (this only hides it from the calendar; the Temporal history stays).
6. The waitlist panel on the left shows who is **Fulfilled**. Because booking someone uses them up, the demo can run out of eligible people; press **Reset demo waitlist** to start over. On a client page, try **I have a question** and watch the staff page flag it.
7. Open the Temporal Web UI to see the opening as a Workflow with its full event history. A screenshot of one is in [`evidence/`](evidence/).

To see two people answering at the same moment, open two reply links (or the same one twice) and tap Yes together. The test `NEVER two winners` does this automatically.

## What Lena asked for, and where it lives

The full chat is in [`docs/customer-chat.md`](docs/customer-chat.md). Quotes below are Lena's.

| What Lena said | What the prototype does |
|---|---|
| "I need to enter the service, stylist, date, and time." | The staff form asks for exactly these. |
| "Our main services are haircuts, color, and blowouts. Appointment lengths range from about 30 minutes to three hours." | The service list is those three. Staff also pick the appointment length (30 minutes to 3 hours). The calendar shows each opening as a block of that length, and someone is only offered the slot if the whole appointment fits their availability (see assumption 6). |
| "The same service, a time they can actually make, and their preferred stylist if they listed one... whoever joined the waitlist earliest." | `src/matching.ts` filters and orders the waitlist this way, and the page shows the eligible people before you start. |
| "For a same-day opening, I'd give them 15 minutes. If they don't answer by then, it should move to the next person automatically." | Each offer has a durable Temporal timer (default 15 minutes). When it fires, the Workflow moves on with nobody having to remember. |
| "For an opening that's a day or two away... it depends." | Staff choose the wait (1 minute to 24 hours) for each opening. |
| "If it allowed two people to claim the same opening, it wouldn't be worth it." | One Workflow per opening is the only decider. A reply is decided before anything else can happen, and only the person who currently holds the offer can win. Everyone else gets "just taken". Tested with simultaneous replies. |
| "They should have been told immediately that the slot was already taken... kept on the waitlist." | Late or extra "yes" replies get an immediate "just taken" text and stay on the waitlist. |
| "Who currently has the offer, who declined or timed out, who is still eligible, and whether the opening was filled. I also need to know if the process stopped or someone canceled." | The status panel shows all of these, plus a log of every simulated message. |
| "The client who accepted, or the stylist becoming unavailable. Staff should be able to cancel... and the client should be told." | Staff can cancel an opening, cancel a booking because the client backed out (the slot is offered to the next person), or cancel because the stylist is unavailable (the client is told). |
| "Clear notification to the client and front desk when it's filled." | The winner gets a confirmation text. The front desk gets "FILLED: please add [name] to the calendar". |
| "They need the service, stylist, date, time, and a clear deadline... accept or decline from their phone without creating an account." | The text contains a link to a phone-friendly page with these details and a deadline. No account. |
| "It should show as unfilled and tell the front desk that the process is finished... shouldn't keep going indefinitely." | When the list runs out, the status is "Not filled", the front desk is told, and the Workflow ends. |
| "Avoid very early mornings and late evenings." | See assumption 1. Offers are held until texting hours when demo mode is off. |
| "Our staff should do it. The prototype doesn't need to update Square." | Not built. The front desk is told who to book. |
| After someone gets an opening: "They should be removed or marked as fulfilled so they don't get another offer for it." | When a client accepts, their request is marked **fulfilled** right away, before any text is sent. They no longer appear in the eligible list and are skipped by any other opening, even one that was already running. The waitlist panel shows who is Fulfilled. If the booking is canceled (client or stylist), they go back on the waiting list (assumption 7). |
| A reply that is not a clear yes or no: "It should flag that for staff rather than treating it as acceptance. We can answer questions or follow up ourselves." | The client page has an **I have a question** button with a text box. It flags the person for staff ("Needs staff", with their message) and sends the front desk a message. It is never counted as a yes. The offer stays open until the timer runs out, and the client can still answer Yes or No. |
| "I haven't thought about a specific limit" on how often one person is offered openings. | Not built. There is no per-person limit. See "Next step". |
| "At least half of those last-minute cancellations refilled without us repeatedly checking." | Not measurable in a prototype. See "Next step". |

## Simulated or excluded

- **Texts are simulated.** An Activity (`sendText`) prints "[simulated text]" and the message appears on the page. No SMS provider is connected.
- **Front-desk notifications are simulated** the same way (`notifyFrontDesk`).
- **Square and the Google Sheet are not connected.** The waitlist is 10 invented people kept in memory (`src/seed.ts`), all with fake names and `(555)` numbers. Staff book the real calendar themselves, as Lena asked.
- **The client's reply page** uses a link instead of a real text reply. There is no sign-in, and the link only shows that person's own offer. Links are not signed or expired beyond the offer itself, which is acceptable for a prototype but not for real use.
- No email, no payments, no staff accounts, no data kept after the server stops (the Temporal history is kept by the local Temporal service).

## Assumptions I made (not Lena's words)

1. **Texting hours are 8 AM to 8 PM.** Lena said "normal daytime and early evening" and gave no cutoff. With demo mode off, offers wait until the window opens and the opening ends as unfilled if the appointment time arrives first. Staff can use **Send now anyway**.
2. **One offer at a time, in waitlist order.** Lena sometimes texts several people at once but said avoiding double-claims matters more than speed. Sequential offers are the safe starting point.
3. **Staff can skip a person.** Lena said "usually" about earliest-first.
4. **Demo mode** speeds waits up 60 times so the flow can be seen in a minute. Untick it for real-time waits.
5. The salon's clock is this computer's local time.
6. **Appointment length is a field staff choose** (default 1 hour). Lena said lengths range from about 30 minutes to three hours, but not that staff would enter it, so this is my addition. I also decided that the whole appointment must fit inside a person's availability.
7. **If a booking is canceled** (the client backs out, or the stylist becomes unavailable), that person's request is unmet again, so they go back on the waiting list. Lena described fulfilled requests but not this case.
8. **A question does not pause the timer.** Staff follow up while the offer stays open. Real text replies are not parsed; the question box on the reply page stands in for "a reply that is not a clear yes or no".

## Next step

Before building more, run this with **real client replies for one or two weeks** (texts through a real SMS service, staff still booking Square by hand) and compare against Lena's baseline of about 3 refills out of 8 to 12 cancellations a week. Her goal is at least half. The things I would learn first are how long people really take to answer, whether one-at-a-time offers are fast enough on same-day openings, and how often the same person ends up being offered openings (Lena has not set a limit, so the trial would show whether one is needed). If they are not, the next feature is limited parallel offers, which the Workflow can support because it already decides the single winner.

Not covered yet:
- **A client offered two openings at the same moment can accept both.** The fulfilled check stops *later* offers, and the Workflow skips someone fulfilled elsewhere, but two simultaneous accepts in different openings are not reconciled. Lena's "never two people for one opening" rule is met; this is a different case.
- A limit on how many offers one person gets in a day (Lena has not set one), a client who already has a nearby booking, parsing real text replies, and reading the real waitlist from the Google Sheet.

## Repository map

- `src/workflows.ts`: the opening Workflow (one per cancellation), with Signals for replies and staff actions, and Queries for status
- `src/activities.ts`: simulated text and front-desk notification
- `src/matching.ts`: who is eligible, and texting-hours logic (plain functions, easy to test)
- `src/api.ts`: browser-facing API and Temporal Client
- `src/worker.ts`: Worker and Task Queue
- `src/seed.ts`: invented waitlist and defaults
- `src/fulfilledStore.ts`: which waitlist requests are already fulfilled (a small file under `.data/`, ignored by git)
- `public/`: staff page (`index.html`) and client reply page (`offer.html`)
- `tests/`: matching and Workflow tests using Temporal's time-skipping test environment
- `docs/customer-chat.md`: the customer conversation
- `evidence/`: Temporal Web UI screenshot of one Workflow

Built with an AI coding agent (Claude), as the assessment instructions allow.
