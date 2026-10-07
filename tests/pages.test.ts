import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Guards against a mistake found during click-through testing: two elements with the same id made the question
// box read the wrong element, so the client's typed message was silently lost.
const pub = path.join(process.cwd(), "public");
const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf8");
const idsIn = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const usedBy = (js: string) => [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);

for (const [html, js] of [
  ["index.html", "app.js"],
  ["offer.html", "offer.js"],
] as const) {
  test(`${html}: every id is unique`, () => {
    const ids = idsIn(read(html));
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, []);
  });

  test(`${js}: every element it looks up exists in ${html}`, () => {
    const ids = new Set(idsIn(read(html)));
    const missing = [...new Set(usedBy(read(js)))].filter((id) => !ids.has(id));
    assert.deepEqual(missing, []);
  });
}
