"""apply_patch: the reference implementation of the gate's `patch` frame, in Python.

After the one `welcome` frame (which carries a full Snapshot), every snapshot
update on a gate WebSocket is a `patch`:

    {"v":1,"type":"patch","payload":{"now":123,"city.queues":[]},"gone":["alliance"]}

Each value REPLACES a whole subtree - a top-level Snapshot key, or
"city.<key>" / "player.<key>" / "viewport.<key>" one level down - and `gone`
deletes one. Nothing is merged deeper than that: a deeper merge would keep map
entries the server has dropped (a Bag item consumed to zero would linger
forever), which is the bug this rule exists to prevent.

Absent keys mean "unchanged", never "empty".

Two exceptions:
  - `chat` carries only the NEW lines since the last frame: append them to the
    chat you hold (keep the newest 70);
  - "<path>_delta" {set, del, order?} updates the list at <path> element by
    element. Elements are keyed by "id", "id#slot" when they carry a slot, or
    "x,y" for tiles: remove the keys in del, overlay the elements in set (new
    keys go at the end, in set's order), and when `order` is present it is the
    full key order. The whole list still comes instead whenever that is smaller.

Plain Python, no dependencies: copy this file as-is into your own agent.
A line-for-line port of examples/node/patch.mjs.
"""

NESTED = ("city", "player", "viewport")


def _key_of(e):
    if isinstance(e.get("id"), str):
        slot = e.get("slot")
        if isinstance(slot, (int, float)) and not isinstance(slot, bool):
            return f"{e['id']}#{slot:g}" if isinstance(slot, float) else f"{e['id']}#{slot}"
        return e["id"]
    return f"{e.get('x')},{e.get('y')}"


def _list_delta(lst, d):
    by_key = {}
    for e in lst if isinstance(lst, list) else []:
        by_key[_key_of(e)] = e
    for k in d.get("del") or []:
        by_key.pop(k, None)
    for e in d.get("set") or []:
        by_key[_key_of(e)] = e
    order = d.get("order")
    if not isinstance(order, list):
        return list(by_key.values())
    return [by_key[k] for k in order if k in by_key]


def _nested(key):
    dot = key.find(".")
    parent = key[:dot] if dot > 0 else ""
    return (parent, key[dot + 1:]) if parent in NESTED else None


def apply_patch(base, payload, gone=None):
    """Fold one patch frame into the snapshot you hold; returns the new snapshot."""
    nxt = dict(base or {})
    subs = {}

    def sub_of(parent):
        if parent not in subs:
            subs[parent] = dict(nxt.get(parent) or {})
            nxt[parent] = subs[parent]
        return subs[parent]

    for key, value in (payload or {}).items():
        n = _nested(key)
        if key.endswith("_delta") and isinstance(value, dict):
            if n:
                sub = sub_of(n[0])
                name = n[1][:-6]
                sub[name] = _list_delta(sub.get(name), value)
            else:
                nxt[key[:-6]] = _list_delta(nxt.get(key[:-6]), value)
        elif n:
            sub_of(n[0])[n[1]] = value
        elif key == "chat" and isinstance(nxt.get("chat"), list) and isinstance(value, list):
            # chat: the NEW lines, appended (keep the newest 70)
            nxt["chat"] = (nxt["chat"] + value)[-70:]
        else:
            nxt[key] = value
    for key in gone or []:
        n = _nested(key)
        if n:
            sub_of(n[0]).pop(n[1], None)
        else:
            nxt.pop(key, None)
    return nxt


def track_snapshot(snapshot, frame):
    """The whole client side of the wire in one call: feed it every parsed
    frame, get the current snapshot back (or None before `welcome`)."""
    if not isinstance(frame, dict):
        return snapshot
    if frame.get("type") == "welcome":
        return frame.get("snapshot")
    if frame.get("type") == "patch":
        return apply_patch(snapshot or {}, frame.get("payload"), frame.get("gone"))
    return snapshot
