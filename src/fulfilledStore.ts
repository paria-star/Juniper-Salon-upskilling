// Which waitlist requests are already fulfilled (booked). Lena: once someone gets an opening, they are
// "removed or marked as fulfilled so they don't get another offer for it."
// A small JSON file is shared by the API process and the Worker process (a real system would use the salon's own data).
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), ".data", "fulfilled.json");
type Store = Record<string, string>; // waitlist entry id -> the opening that fulfilled it

export function readFulfilled(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, FILE);
}

export function markFulfilled(entryId: string, openingId: string): void {
  write({ ...readFulfilled(), [entryId]: openingId });
}

/** Put someone back on the waiting list, but only if this same opening is what fulfilled them. */
export function release(entryId: string, openingId: string): void {
  const store = readFulfilled();
  if (store[entryId] !== openingId) return;
  delete store[entryId];
  write(store);
}

export function resetAll(): void {
  write({});
}
