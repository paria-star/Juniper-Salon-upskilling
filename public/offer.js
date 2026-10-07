// Client page: no login. The link carries the opening and the person; the page shows only that person's own offer.
const params = new URLSearchParams(location.search);
const openingId = params.get("opening");
const entryId = params.get("entry");
const $ = (id) => document.getElementById(id);

const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

function line(label, value) {
  const d = document.createElement("div");
  const b = document.createElement("strong");
  b.textContent = `${label}: `;
  d.append(b, value);
  return d;
}

async function load() {
  if (!openingId || !entryId) return fail("This link is missing something. Please use the link from your text.");
  const res = await fetch(`/api/offers/${encodeURIComponent(openingId)}/${encodeURIComponent(entryId)}`);
  if (!res.ok) return fail("We couldn't find that opening.");
  const v = await res.json();
  $("title").textContent = v.status === "open" ? "A spot just opened up" : "Juniper Salon";
  $("note").textContent = v.message;
  $("lines").replaceChildren();
  if (v.opening) {
    $("lines").append(line("Service", v.opening.service), line("Stylist", v.opening.stylist || "Any available stylist"), line("When", fmtWhen(v.opening.startsAt)), line("Length", `about ${v.opening.durationMinutes >= 60 ? `${Math.floor(v.opening.durationMinutes / 60)} hr` : ""}${v.opening.durationMinutes % 60 ? ` ${v.opening.durationMinutes % 60} min` : ""}`.replace("  ", " ").trim()));
  }
  $("btns").hidden = v.status !== "open";
  if (v.status !== "open") $("askbox").hidden = true;
}

function fail(text) {
  $("title").textContent = "Juniper Salon";
  $("note").textContent = text;
}

async function reply(accept) {
  $("btns").hidden = true;
  const res = await fetch(`/api/openings/${encodeURIComponent(openingId)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, accept }),
  });
  $("result").hidden = false;
  $("result").textContent = res.ok
    ? accept ? "Thanks! We're checking, and we'll text you right away to confirm." : "No problem. You stay on our waitlist."
    : "Something went wrong. Please call the salon.";
  setTimeout(async () => { await load(); $("result").hidden = true; }, 1200); // the page itself now shows the outcome
}

async function askStaff() {
  const res = await fetch(`/api/openings/${encodeURIComponent(openingId)}/question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, note: $("question-text").value }),
  });
  $("askbox").hidden = true;
  $("btns").hidden = true;
  $("result").hidden = false;
  $("result").textContent = res.ok ? "Thanks! A member of our staff will follow up with you. This is not counted as a yes." : "Something went wrong. Please call the salon.";
  setTimeout(async () => { await load(); $("result").hidden = true; }, 1200);
}

$("ask").addEventListener("click", () => { $("askbox").hidden = false; $("question-text").focus(); });
$("send-question").addEventListener("click", askStaff);
$("yes").addEventListener("click", () => reply(true));
$("no").addEventListener("click", () => reply(false));
load();
