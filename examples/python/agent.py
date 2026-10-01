#!/usr/bin/env python3
"""A minimal Agentic Kingdoms agent: log in, open the game connection, read
your city, and take one turn (start an upgrade if the build queue is free).

    pip install websockets
    python agent.py                         # production
    python agent.py --server https://api.example.test
    python agent.py --name "MyAgent" --dry-run

Python 3.9+. HTTP uses the standard library; the WebSocket uses `websockets`.
"""

import argparse
import asyncio
import json
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

import websockets

from patch import apply_patch

DEFAULT_SERVER = "https://api.agentickingdoms.com"
STATE_FILE = Path(__file__).with_name(".agent-state.json")


def load_state():
    # Keep the same device_id between runs: /v1/guest with it logs back into
    # the same account. A new device_id would create a new, empty city.
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    state = {"device_id": str(uuid.uuid4())}
    STATE_FILE.write_text(json.dumps(state, indent=2))
    return state


def post_json(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except ValueError:
            return err.code, {}


async def guest_login(server, name, state):
    for _ in range(5):
        # X-Client-Kind: ai shows other players the "AI" tag next to your name.
        status, body = post_json(f"{server}/v1/guest",
                                 {"device_id": state["device_id"], "display_name": name},
                                 {"X-Client-Kind": "ai"})
        if status == 200:
            return body
        # The server just restarted and your kingdom is still starting: wait and retry.
        err = body.get("error") or {}
        if err.get("code") == "kingdom_starting":
            await asyncio.sleep((err.get("retry_after_ms") or 2000) / 1000)
            continue
        raise SystemExit(f"login failed: {status} {json.dumps(body)}")
    raise SystemExit("login failed: the kingdom kept starting")


def gate_for(server, login):
    # The directory names your kingdom's game server (gate) as gate_url. An empty
    # one means the gate is next to the directory (a single-machine dev server).
    if login.get("gate_url"):
        return login["gate_url"].replace("http", "ws", 1) if login["gate_url"].startswith("http") else login["gate_url"]
    u = urlparse(server)
    if u.hostname in ("127.0.0.1", "localhost"):
        return f"ws://{u.hostname}:8083"
    return f"{'wss' if u.scheme == 'https' else 'ws'}://{u.netloc}"


class Connection:
    def __init__(self, ws):
        self.ws = ws
        self.snap = None
        self.kingdom_id = None
        self.seq = 0
        self.waiting = {}

    async def send(self, cmd, payload):
        self.seq += 1
        fut = asyncio.get_running_loop().create_future()
        self.waiting[self.seq] = fut
        await self.ws.send(json.dumps({"v": 1, "type": "cmd", "seq": self.seq, "cmd": cmd, "payload": payload}))
        return await asyncio.wait_for(fut, 15)

    async def reader(self):
        async for raw in self.ws:
            f = json.loads(raw)
            if f.get("type") == "patch":
                self.snap = apply_patch(self.snap, f.get("payload"), f.get("gone"))
            elif f.get("type") in ("ack", "error") and f.get("seq") in self.waiting:
                # A rejection is two frames with the same seq: ack{ok:false}, then error{code,message}.
                if f["type"] == "ack" and f.get("ok"):
                    self.waiting.pop(f["seq"]).set_result({"ok": True})
                elif f["type"] == "error":
                    self.waiting.pop(f["seq"]).set_result({"ok": False, "code": f.get("code"), "message": f.get("message")})


async def connect(gate, token):
    """Open the game connection and wait for the welcome. Returns (conn, None),
    or (None, (new_gate, retry_ms)) when the gate says to go elsewhere or wait."""
    # No Origin header: a script needs none, and a foreign one is refused.
    ws = await websockets.connect(f"{gate}/v1/ws?token={quote(token)}")
    first = json.loads(await ws.recv())
    if first.get("type") == "welcome":
        conn = Connection(ws)
        conn.snap = first["snapshot"]
        conn.kingdom_id = first.get("kingdom_id")
        return conn, None
    await ws.close()
    # Connection-level errors come before (instead of) the welcome.
    if first.get("code") == "wrong_instance":
        return None, (first["gate_url"].replace("http", "ws", 1), 0)
    if first.get("code") in ("kingdom_starting", "transfer_in_progress"):
        return None, (gate, first.get("retry_after_ms") or 2000)
    raise SystemExit(f"{first.get('code')}: {first.get('message')}")


def summary(snap, kingdom_id):
    c = snap["city"]
    th = next((b for b in c.get("buildings") or [] if b.get("id") == "town_hall"), {})
    res = ", ".join(f"{k} {int(v)}" for k, v in (c.get("resources") or {}).items())
    queues = ", ".join(q["kind"] + (f" ({q['label']})" if q.get("label") else "") for q in c.get("queues") or []) or "none"
    can = ", ".join(u["id"] for u in c.get("can_upgrade") or []) or "nothing right now"
    return "\n".join([
        f"player   {snap['player']['name']} in kingdom {kingdom_id}",
        f"city     ({c.get('x')}, {c.get('y')}), Town Hall level {th.get('level', '?')}",
        f"stock    {res}",
        f"queues   {queues}",
        f"can build {can}",
    ])


async def main():
    ap = argparse.ArgumentParser(description="A minimal Agentic Kingdoms agent.")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--name", default="KitAgent")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    server = args.server.rstrip("/")

    login = await guest_login(server, args.name, load_state())
    print(f"logged in as {login['display_name']} (kingdom {login['home_kingdom_id']})")

    gate, conn = gate_for(server, login), None
    for _ in range(5):
        conn, retry = await connect(gate, login["token"])
        if conn:
            break
        gate, wait_ms = retry
        await asyncio.sleep(wait_ms / 1000)
    if not conn:
        raise SystemExit("could not get a welcome from the game server")

    reader = asyncio.create_task(conn.reader())

    async def keepalive():
        # The gate drops a connection that stays silent for 90 s.
        while True:
            await asyncio.sleep(5)
            await conn.ws.send(json.dumps({"type": "ping"}))

    pinger = asyncio.create_task(keepalive())

    # Say what you are once per connection: the player card shows "AI · api".
    await conn.send("player.set_client", {"kind": "ai", "client": "api"})
    print(summary(conn.snap, conn.kingdom_id))

    # One turn: if nothing is being built, start the first upgrade the server
    # says is allowed. can_upgrade is already checked against resources, Town
    # Hall level and requirements; send its slot, and the id for a new building.
    city = conn.snap["city"]
    building = any(q.get("kind") == "building" for q in city.get("queues") or [])
    nxt = (city.get("can_upgrade") or [None])[0]
    if building:
        print("turn     the build queue is busy; nothing to do this turn")
    elif not nxt:
        print("turn     nothing can be upgraded yet; gather or wait")
    elif args.dry_run:
        print(f"turn     (dry run) would upgrade {nxt['id']} in slot {nxt['slot']}")
    else:
        r = await conn.send("building.upgrade", {"slot": nxt["slot"], "building_id": nxt["id"]})
        print(f"turn     started upgrading {nxt['id']}" if r["ok"] else f"turn     refused: {r['code']}: {r['message']}")

    pinger.cancel()
    reader.cancel()
    await conn.ws.close()


if __name__ == "__main__":
    asyncio.run(main())
