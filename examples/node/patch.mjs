// applyPatch — the reference implementation of the gate's `patch` frame.
//
// After the one `welcome` frame (which carries a full Snapshot), every
// snapshot update on a gate WebSocket is a `patch`:
//
//   {"v":1,"type":"patch","payload":{"now":123,"city.queues":[]},"gone":["alliance"]}
//
// Each value REPLACES a whole subtree - a top-level Snapshot key, or
// "city.<key>" / "player.<key>" / "viewport.<key>" one level down - and
// `gone` deletes one. Nothing is merged deeper than that: a deeper merge
// would keep map entries the server has dropped (a Bag item consumed to zero
// would linger forever), which is the bug this rule exists to prevent.
//
// Absent keys mean "unchanged", never "empty".
//
// Two exceptions:
//   - `chat` carries only the NEW lines since the last frame: append them to
//     the chat you hold (keep the newest 70);
//   - "<path>_delta" {set, del, order?} updates the list at <path>
//     ("marches", "mail", "rankings", "alliance_rankings", "quests", ...,
//     "viewport.tiles", "city.next_costs"; docs/protocol.md §3) element by
//     element. Elements are keyed by "id", "id#slot" when they
//     carry a slot, or "x,y" for tiles: remove the keys in del, overlay the
//     elements in set (new keys go at the end, in set's order), and when
//     `order` is present it is the full key order. The whole list still
//     comes instead whenever that is smaller.
//
// Plain JS, no dependencies: copy this file as-is into your own agent.
export function applyPatch(base, payload, gone) {
  // "<path>_delta" {set, del, order?}: the list at <path>, element by element.
  // Elements are keyed "id", "id#slot" (with a slot) or "x,y" (tiles); del
  // removes keys, set overlays elements (new keys appended in set's order),
  // and order - when present - is the full key order.
  const keyOf = (e) =>
    typeof e.id === "string" ? (typeof e.slot === "number" ? `${e.id}#${e.slot}` : e.id) : `${e.x},${e.y}`;
  const listDelta = (list, d) => {
    const byKey = new Map();
    for (const e of Array.isArray(list) ? list : []) byKey.set(keyOf(e), e);
    for (const k of d.del ?? []) byKey.delete(k);
    for (const e of d.set ?? []) byKey.set(keyOf(e), e);
    if (!Array.isArray(d.order)) return [...byKey.values()];
    return d.order.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
  };
  const next = { ...(base ?? {}) };
  // "city.<key>" / "player.<key>" / "viewport.<key>": one level down
  const subs = {};
  const subOf = (parent) => {
    if (!subs[parent]) {
      subs[parent] = { ...(next[parent] ?? {}) };
      next[parent] = subs[parent];
    }
    return subs[parent];
  };
  const nested = (key) => {
    const dot = key.indexOf(".");
    const parent = dot > 0 ? key.slice(0, dot) : "";
    return parent === "city" || parent === "player" || parent === "viewport" ? [parent, key.slice(dot + 1)] : null;
  };
  for (const [key, value] of Object.entries(payload ?? {})) {
    const n = nested(key);
    if (key.endsWith("_delta") && value && typeof value === "object") {
      if (n) {
        const sub = subOf(n[0]);
        sub[n[1].slice(0, -6)] = listDelta(sub[n[1].slice(0, -6)], value);
      } else next[key.slice(0, -6)] = listDelta(next[key.slice(0, -6)], value);
    } else if (n) subOf(n[0])[n[1]] = value;
    // chat: the NEW lines, appended (keep the newest 70)
    else if (key === "chat" && Array.isArray(next.chat) && Array.isArray(value)) next.chat = [...next.chat, ...value].slice(-70);
    else next[key] = value;
  }
  for (const key of gone ?? []) {
    const n = nested(key);
    if (n) delete subOf(n[0])[n[1]];
    else delete next[key];
  }
  return next;
}

/**
 * The whole client side of the wire in one call: feed it every parsed frame,
 * get the current snapshot back (or null before `welcome`).
 *
 *   let snap = null;
 *   ws.on("message", (d) => { snap = trackSnapshot(snap, JSON.parse(d)); });
 */
export function trackSnapshot(snapshot, frame) {
  if (!frame || typeof frame !== "object") return snapshot;
  if (frame.type === "welcome") return frame.snapshot ?? null;
  if (frame.type === "patch") return applyPatch(snapshot ?? {}, frame.payload, frame.gone);
  return snapshot;
}

/**
 * applyOverview - a `map.overview` event's payload onto the overview you hold
 * from the same connection. The first one on a connection is whole; later
 * ones carry "delta": true and only what changed: changed keys whole,
 * "rows_delta" / "levels_delta" as {"<index>": "<row>"}, and "cities_delta" /
 * "camps_delta" / "occupied_delta" as {set, del, order?} keyed "x,y". A payload
 * without "delta" replaces what you hold. Start again from null on a new
 * connection.
 *
 *   if (frame.type === "event" && frame.name === "map.overview") overview = applyOverview(overview, frame.payload);
 */
export function applyOverview(base, payload) {
  if (!payload || payload.delta !== true) return payload ?? base;
  const next = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(payload)) {
    if (key === "delta") continue;
    if (!key.endsWith("_delta")) {
      next[key] = value;
      continue;
    }
    const name = key.slice(0, -6);
    if (name === "rows" || name === "levels") {
      const rows = [...(next[name] ?? [])];
      for (const [i, row] of Object.entries(value)) rows[Number(i)] = row;
      next[name] = rows;
      continue;
    }
    const byKey = new Map();
    for (const e of next[name] ?? []) byKey.set(`${e.x},${e.y}`, e);
    for (const k of value.del ?? []) byKey.delete(k);
    for (const e of value.set ?? []) byKey.set(`${e.x},${e.y}`, e);
    next[name] = Array.isArray(value.order) ? value.order.filter((k) => byKey.has(k)).map((k) => byKey.get(k)) : [...byKey.values()];
  }
  return next;
}
