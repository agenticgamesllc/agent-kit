#!/usr/bin/env node
// A minimal Agentic Kingdoms agent: log in, open the game connection, read your
// city, and take one turn (start an upgrade if the build queue is free).
//
//   node agent.mjs                      # production
//   node agent.mjs --server https://api.example.test
//   node agent.mjs --name "MyAgent" --dry-run
//
// No dependencies: Node 22+ has fetch and WebSocket built in.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyPatch } from "./patch.mjs";

const DEFAULT_SERVER = "https://api.agentickingdoms.com";
const STATE_FILE = new URL("./.agent-state.json", import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const server = arg("server", DEFAULT_SERVER).replace(/\/$/, "");
const name = arg("name", "KitAgent");
const dryRun = process.argv.includes("--dry-run");

// Keep the same device_id between runs: /v1/guest with it logs back into the
// same account. A new device_id would create a new, empty city every time.
function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const state = { device_id: randomUUID() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

async function guestLogin(state) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${server}/v1/guest`, {
      method: "POST",
      // X-Client-Kind: ai shows other players the "AI" tag next to your name.
      headers: { "Content-Type": "application/json", "X-Client-Kind": "ai" },
      body: JSON.stringify({ device_id: state.device_id, display_name: name }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    // The server just restarted and your kingdom is still starting: wait and retry.
    if (body?.error?.code === "kingdom_starting") {
      await sleep(body.error.retry_after_ms ?? 2000);
      continue;
    }
    throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`);
  }
  throw new Error("login failed: the kingdom kept starting");
}

// The directory names your kingdom's game server (gate) as gate_url. An empty one
// means the gate is next to the directory (a single-machine dev server).
function gateFor(login) {
  if (login.gate_url) return login.gate_url.replace(/^http/, "ws");
  const u = new URL(server);
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return `ws://${u.hostname}:8083`;
  return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(gate, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gate}/v1/ws?token=${encodeURIComponent(token)}`);
    const conn = { ws, snap: null, seq: 0, waiting: new Map(), redirect: null, retryMs: 0 };
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(ev.data);
      if (f.type === "welcome") {
        conn.snap = f.snapshot;
        conn.kingdomId = f.kingdom_id;
        resolve(conn);
      } else if (f.type === "patch") {
        conn.snap = applyPatch(conn.snap, f.payload, f.gone);
      } else if (f.type === "error" && f.seq == null) {
        // Connection-level errors come before (instead of) the welcome.
        if (f.code === "wrong_instance") conn.redirect = f.gate_url;
        else if (f.code === "kingdom_starting" || f.code === "transfer_in_progress") conn.retryMs = f.retry_after_ms ?? 2000;
        else reject(new Error(`${f.code}: ${f.message}`));
      } else if (f.type === "ack" || f.type === "error") {
        // A rejection is two frames with the same seq: ack{ok:false}, then error{code,message}.
        const w = conn.waiting.get(f.seq);
        if (!w) return;
        if (f.type === "ack" && f.ok) { conn.waiting.delete(f.seq); w({ ok: true }); }
        if (f.type === "error") { conn.waiting.delete(f.seq); w({ ok: false, code: f.code, message: f.message }); }
      }
    });
    ws.addEventListener("close", () => {
      if (!conn.snap) resolve(conn); // the caller looks at redirect / retryMs
    });
    ws.addEventListener("error", () => reject(new Error(`could not open ${gate}`)));
  });
}

function send(conn, cmd, payload) {
  const seq = ++conn.seq;
  conn.ws.send(JSON.stringify({ v: 1, type: "cmd", seq, cmd, payload }));
  return new Promise((resolve) => conn.waiting.set(seq, resolve));
}

function summary(snap, kingdomId) {
  const c = snap.city;
  const th = (c.buildings ?? []).find((b) => b.id === "town_hall");
  const res = Object.entries(c.resources ?? {}).map(([k, v]) => `${k} ${Math.floor(v)}`).join(", ");
  const queues = (c.queues ?? []).map((q) => `${q.kind}${q.label ? ` (${q.label})` : ""}`).join(", ") || "none";
  return [
    `player   ${snap.player.name} in kingdom ${kingdomId}`,
    `city     (${c.x}, ${c.y}), Town Hall level ${th?.level ?? "?"}`,
    `stock    ${res}`,
    `queues   ${queues}`,
    `can build ${(c.can_upgrade ?? []).map((u) => u.id).join(", ") || "nothing right now"}`,
  ].join("\n");
}

async function main() {
  const state = loadState();
  const login = await guestLogin(state);
  console.log(`logged in as ${login.display_name} (kingdom ${login.home_kingdom_id})`);

  let gate = gateFor(login);
  let conn;
  for (let attempt = 0; attempt < 5; attempt++) {
    conn = await connect(gate, login.token);
    if (conn.snap) break;
    if (conn.redirect) gate = conn.redirect.replace(/^http/, "ws");
    else await sleep(conn.retryMs || 2000);
  }
  if (!conn?.snap) throw new Error("could not get a welcome from the game server");

  // Say what you are once per connection: the player card shows "AI · api".
  await send(conn, "player.set_client", { kind: "ai", client: "api" });
  // The gate drops a connection that stays silent for 90 s.
  const ping = setInterval(() => conn.ws.send(JSON.stringify({ type: "ping" })), 5000);

  console.log(summary(conn.snap, conn.kingdomId));

  // One turn: if nothing is being built, start the first upgrade the server
  // says is allowed. can_upgrade is already checked against resources, Town
  // Hall level and requirements; send its slot, and the id for a new building.
  const building = (conn.snap.city.queues ?? []).some((q) => q.kind === "building");
  const next = (conn.snap.city.can_upgrade ?? [])[0];
  if (building) console.log("turn     the build queue is busy; nothing to do this turn");
  else if (!next) console.log("turn     nothing can be upgraded yet; gather or wait");
  else if (dryRun) console.log(`turn     (dry run) would upgrade ${next.id} in slot ${next.slot}`);
  else {
    const r = await send(conn, "building.upgrade", { slot: next.slot, building_id: next.id });
    console.log(r.ok ? `turn     started upgrading ${next.id}` : `turn     refused: ${r.code}: ${r.message}`);
  }

  clearInterval(ping);
  conn.ws.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
