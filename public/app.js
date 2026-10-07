// Staff page for Juniper Salon. Plain JS; all text is set with textContent (no HTML injection).
const $ = (id) => document.getElementById(id);
let currentId = null;
let latest = null;
let lastDetailSig = "";
let lastCalSig = "";

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid);
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options && { ...options, headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtLen = (m) => { const h = Math.floor(m / 60), r = m % 60; return [h ? `${h} hr` : "", r ? `${r} min` : ""].filter(Boolean).join(" "); };
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const PHASES = { starting: "Starting", waiting_for_texting_hours: "Waiting for texting hours", offer_out: "Offer out", filled: "Filled", booked: "Booked", unfilled: "Not filled", canceled: "Canceled" };
const STATES = { eligible: "Waiting", offered: "Offer out", accepted: "Said yes", declined: "Said no", timed_out: "No reply", skipped: "Skipped by staff", withdrawn: "Offer withdrawn", booking_canceled: "Canceled booking" };

async function loadForm() {
  const config = await api("/api/config");
  for (const s of config.services) $("service").append(new Option(s, s));
  $("stylist").append(new Option("Any stylist", ""));
  for (const s of config.stylists) $("stylist").append(new Option(s, s));
  const t = new Date(Date.now() + 24 * 3600 * 1000); // default: tomorrow at 2:00 PM, when most waitlist people are available
  const p = (n) => String(n).padStart(2, "0");
  $("date").value = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  $("time").value = "14:00";
  for (const [m, label] of [[30, "30 minutes"], [60, "1 hour"], [90, "1 hour 30 minutes"], [120, "2 hours"], [150, "2 hours 30 minutes"], [180, "3 hours"]]) $("duration").append(new Option(label, String(m)));
  $("duration").value = "60";
  refreshEligible();
}

let eligibleRequest = 0;
async function refreshEligible() {
  const mine = ++eligibleRequest; // overlapping updates: only the newest one may draw
  const { service, stylist, date, time, duration } = { service: $("service").value, stylist: $("stylist").value, date: $("date").value, time: $("time").value, duration: $("duration").value };
  if (!service || !date || !time) return $("eligible-list").replaceChildren();
  let items;
  try {
    const q = new URLSearchParams({ service, stylist, date, time, duration });
    const people = await api(`/api/eligible?${q}`);
    items = people.length
      ? people.map((p) => el("li", {}, p.name, " ", el("small", {}, p.stylist ? `(wants ${p.stylist})` : "(any stylist)")))
      : [el("li", {}, "Nobody on the waitlist fits this slot.")];
  } catch (e) {
    items = [el("li", {}, e.message)];
  }
  if (mine === eligibleRequest) $("eligible-list").replaceChildren(...items);
}
for (const id of ["service", "stylist", "date", "time", "duration"]) $(id).addEventListener("change", refreshEligible);

// The reply timer is in SECONDS in demo mode (sped up 60 times) and in MINUTES in real mode.
function syncWaitUnit() {
  const demo = $("demo").checked;
  $("wait-label").textContent = demo ? "Seconds each person has to reply (demo mode)" : "Minutes each person has to reply";
  $("wait-hint").textContent = demo
    ? "Demo timer: 15 seconds stands in for Lena's 15 minutes for same-day openings. Untick demo mode to enter real minutes."
    : "Same-day openings: 15 minutes (Lena's rule). For a day or two out, you choose.";
}
$("demo").addEventListener("change", () => {
  // keep the number meaningful when the unit changes: 15 either way stands for the same-day rule
  syncWaitUnit();
});
syncWaitUnit();

$("opening-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("form-error").textContent = "";
  $("start-btn").disabled = true;
  try {
    const { openingId } = await api("/api/openings", {
      method: "POST",
      body: { service: $("service").value, stylist: $("stylist").value, date: $("date").value, time: $("time").value, waitMinutes: Number($("wait").value), durationMinutes: Number($("duration").value), demoMode: $("demo").checked },
    });
    currentId = openingId;
    calAnchor = new Date(`${$("date").value}T${$("time").value}:00`);
    await refresh();
  } catch (e) {
    $("form-error").textContent = e.message;
  } finally {
    $("start-btn").disabled = false;
  }
});

async function act(path, body) {
  try {
    await api(`/api/openings/${currentId}/${path}`, { method: "POST", body });
    if (path === "remove") {
      currentId = null;
      latest = null;
      lastDetailSig = "";
      $("detail").hidden = true;
      $("empty").hidden = false;
      return await renderRecent();
    }
    await new Promise((r) => setTimeout(r, 300));
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

function renderActions(s) {
  const box = $("actions");
  box.replaceChildren();
  const add = (label, path, body, cls = "") => box.append(el("button", { class: cls, onclick: () => act(path, body) }, label));
  if (s.phase === "offer_out") add("Skip this person", "skip");
  if (s.phase === "waiting_for_texting_hours") add("Send now anyway", "send-now");
  if (["starting", "waiting_for_texting_hours", "offer_out"].includes(s.phase)) add("Cancel this opening", "cancel", {}, "danger");
  if (s.phase === "unfilled" || s.phase === "canceled") add("Remove from calendar", "remove", {}, "danger");
  if (s.phase === "filled") add("I put them on the calendar", "mark-booked");
  if (s.phase === "filled") {
    add("Client canceled: offer to the next person", "cancel-booking", { reason: "client_canceled" }, "danger");
    add("Stylist unavailable: cancel", "cancel-booking", { reason: "stylist_unavailable" }, "danger");
  }
}

function renderDetail(s) {
  $("empty").hidden = true;
  $("detail").hidden = false;
  $("phase-badge").className = `badge ${s.phase}`;
  $("phase-badge").textContent = PHASES[s.phase] || s.phase;
  $("summary").textContent = s.summary;
  $("opening-line").textContent = `${s.opening.service}${s.opening.stylist ? ` with ${s.opening.stylist}` : ""}, ${fmtWhen(s.opening.startsAt)} (${fmtLen(s.opening.durationMinutes)})`;
  const offer = $("offer-box");
  offer.hidden = !s.currentOffer;
  if (s.currentOffer) {
    $("offer-name").textContent = s.currentOffer.name;
    $("countdown").dataset.expires = s.currentOffer.expiresAt;
  }
  renderActions(s);
  const body = $("people-body");
  body.replaceChildren();
  s.people.forEach((p, i) => {
    body.append(el("tr", {}, el("td", {}, String(i + 1)), el("td", {}, p.name), el("td", {}, el("span", { class: `state ${p.state}` }, STATES[p.state] || p.state))));
  });
  const list = $("messages");
  list.replaceChildren();
  for (const m of [...(s.messages || [])].reverse()) {
    const li = el("li", { class: m.kind === "front_desk" ? "fd" : "" });
    li.append(el("span", { class: "to" }, m.kind === "front_desk" ? "To front desk" : `To ${m.to}`), el("time", {}, fmtTime(m.at)), el("br"), m.text);
    if (m.link) li.append(el("br"), el("a", { href: m.link, target: "_blank", rel: "noopener" }, "Open the client's reply page"));
    list.append(li);
  }
}

// ---- calendar ----
const HOUR_PX = 44;
let calView = "week";
let calAnchor = new Date();
let openings = [];
let scrolledOnce = false;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

function visibleDays() {
  if (calView === "day") return [startOfDay(calAnchor)];
  const s = startOfDay(calAnchor);
  const monday = addDays(s, -((s.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function blockText(o) {
  const who = o.currentOffer ? `Offer: ${o.currentOffer.name}` : o.filledBy ? `${o.filledBy.name}` : PHASES[o.phase] || o.phase;
  return [`${o.opening.service}${o.opening.stylist ? " \u00b7 " + o.opening.stylist : ""}`, who];
}

function renderCalendar() {
  const days = visibleDays();
  // show 8 AM to 8 PM, and grow if an opening falls outside
  let first = 8, last = 20;
  for (const o of openings) {
    const d = new Date(o.opening.startsAt);
    if (!days.some((x) => sameDay(x, d))) continue;
    first = Math.min(first, d.getHours());
    last = Math.min(24, Math.max(last, Math.ceil((d.getHours() * 60 + d.getMinutes() + (o.opening.durationMinutes || 60)) / 60)));
  }
  const rows = last - first;
  const cols = `54px repeat(${days.length}, 1fr)`;
  $("cal-title").textContent = calView === "day"
    ? days[0].toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : `${days[0].toLocaleDateString([], { month: "short", day: "numeric" })} to ${days[6].toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  $("view-day").classList.toggle("on", calView === "day");
  $("view-week").classList.toggle("on", calView === "week");

  const cal = $("cal");
  const previous = cal.querySelector(".cal-scroll");
  const previousTop = previous ? previous.scrollTop : 0; // read before the old node is detached (a detached node reports 0)
  cal.replaceChildren();
  const head = el("div", { class: "cal-head" }, el("div", {}, ""));
  head.style.gridTemplateColumns = cols;
  for (const d of days) {
    const label = d.toLocaleDateString([], { weekday: "short" });
    const num = el("b", {}, String(d.getDate()));
    head.append(el("div", { class: sameDay(d, new Date()) ? "today" : "" }, `${label} `, num));
  }
  cal.append(head);

  const body = el("div", { class: "cal-body" });
  body.style.gridTemplateColumns = cols;
  body.style.height = `${rows * HOUR_PX}px`;
  const gutter = el("div", { class: "cal-gutter" });
  for (let h = first; h < last; h++) {
    const s = el("span", {}, hourLabel(h));
    s.style.top = `${(h - first) * HOUR_PX}px`;
    if (h > first) gutter.append(s);
  }
  body.append(gutter);

  for (const d of days) {
    const col = el("div", { class: `cal-col ${sameDay(d, new Date()) ? "today" : ""}` });
    col.style.backgroundSize = `100% ${HOUR_PX}px`;
    col.addEventListener("click", (event) => {
      if (event.target !== col) return;
      // measure against the column's own box, so it stays right under page zoom
      const box = col.getBoundingClientRect();
      const hour = first + Math.min(rows - 1, Math.max(0, Math.floor(((event.clientY - box.top) / box.height) * rows)));
      $("date").value = isoDate(d);
      $("time").value = `${pad2(hour)}:00`;
      refreshEligible();
      $("opening-form").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // openings on this day; overlapping ones share the width
    const todays = openings
      .filter((o) => sameDay(new Date(o.opening.startsAt), d))
      .sort((a, b) => a.opening.startsAt.localeCompare(b.opening.startsAt));
    // Overlapping openings share the width, but only within their own overlap group.
    let laneEnds = [];
    let group = [];
    const closeGroup = () => { for (const g of group) g._lanes = Math.max(1, laneEnds.length); group = []; laneEnds = []; };
    let groupEnd = -1;
    for (const o of todays) {
      const dt0 = new Date(o.opening.startsAt);
      const startMin = dt0.getHours() * 60 + dt0.getMinutes();
      if (startMin >= groupEnd) closeGroup();
      let lane = laneEnds.findIndex((end) => end <= startMin);
      if (lane === -1) lane = laneEnds.length;
      const endMin = startMin + (o.opening.durationMinutes || 60);
      laneEnds[lane] = endMin;
      groupEnd = Math.max(groupEnd, endMin);
      o._lane = lane;
      group.push(o);
    }
    closeGroup();
    for (const o of todays) {
      const dt = new Date(o.opening.startsAt);
      const startMin = dt.getHours() * 60 + dt.getMinutes();
      const [line1, line2] = blockText(o);
      const b = el("button", { type: "button", class: `block ${o.phase} ${o.openingId === currentId ? "sel" : ""}`, title: o.summary, onclick: () => { currentId = o.openingId; refresh(); } },
        el("b", {}, `${dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${line1}`), el("span", {}, line2));
      const lanesCount = o._lanes || 1;
      b.style.top = `${((startMin - first * 60) / 60) * HOUR_PX}px`;
      b.style.height = `${Math.max(22, ((o.opening.durationMinutes || 60) / 60) * HOUR_PX - 3)}px`;
      b.style.left = `${(o._lane / lanesCount) * 100 + 1}%`;
      b.style.width = `${100 / lanesCount - 2}%`;
      col.append(b);
    }
    if (sameDay(d, new Date())) {
      const n = new Date();
      const line = el("div", { class: "now-line" });
      line.style.top = `${((n.getHours() * 60 + n.getMinutes() - first * 60) / 60) * HOUR_PX}px`;
      if (n.getHours() >= first && n.getHours() < last) col.append(line);
    }
    body.append(col);
  }
  const scroller = el("div", { class: "cal-scroll" }, body);
  cal.append(scroller);
  if (previous && scrolledOnce) scroller.scrollTop = previousTop;
  else {
    scrolledOnce = openings.length > 0; // first draw: start near the day's activity instead of the very top
    const hours = openings.map((o) => new Date(o.opening.startsAt)).filter((d) => days.some((x) => sameDay(x, d))).map((d) => d.getHours());
    scroller.scrollTop = Math.max(0, ((hours.length ? Math.min(...hours.filter((h) => h >= 7), 12) : 8) - first - 1) * HOUR_PX);
  }
}

async function renderRecent() {
  const fresh = await api("/api/openings").catch(() => openings);
  const sig = `${calView}|${calAnchor.toDateString()}|${currentId}|${JSON.stringify(fresh)}`;
  openings = fresh;
  if (sig !== lastCalSig) {
    lastCalSig = sig;
    renderCalendar();
  }
}

$("view-day").addEventListener("click", () => { calView = "day"; lastCalSig = ""; renderCalendar(); });
$("view-week").addEventListener("click", () => { calView = "week"; lastCalSig = ""; renderCalendar(); });
$("cal-prev").addEventListener("click", () => { calAnchor = addDays(calAnchor, calView === "day" ? -1 : -7); lastCalSig = ""; renderCalendar(); });
$("cal-next").addEventListener("click", () => { calAnchor = addDays(calAnchor, calView === "day" ? 1 : 7); lastCalSig = ""; renderCalendar(); });
$("cal-today").addEventListener("click", () => { calAnchor = new Date(); lastCalSig = ""; renderCalendar(); });

async function refresh() {
  if (!currentId) return renderRecent();
  try {
    const fresh = await api(`/api/openings/${encodeURIComponent(currentId)}`);
    // redraw only when something changed, so buttons are not replaced under the user's mouse mid-click
    const sig = `${currentId}|${JSON.stringify(fresh)}`;
    if (sig !== lastDetailSig) {
      lastDetailSig = sig;
      latest = fresh;
      renderDetail(latest);
    }
  } catch (e) {
    $("summary").textContent = e.message;
  }
  renderRecent();
}

setInterval(() => {
  const c = $("countdown");
  if (!c.dataset.expires) return c.replaceChildren();
  const left = Math.max(0, Math.round((new Date(c.dataset.expires) - Date.now()) / 1000));
  c.textContent = `Their time runs out in ${left >= 90 ? Math.round(left / 60) + " min" : left + " s"} (the page clock; demo mode is sped up).`;
}, 1000);
setInterval(refresh, 2000);

loadForm().then(renderRecent);
