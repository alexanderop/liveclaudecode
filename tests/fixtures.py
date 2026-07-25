"""Builders for synthetic transcripts, so tests never need a real session."""

import json
from pathlib import Path

T0 = "2026-07-25T18:00:%02d.000Z"


def rec(**kw):
    kw.setdefault("cwd", "/repo")
    return kw


def assistant(*blocks, ts=T0 % 0, usage=None, model="claude-opus-5"):
    msg = {"content": list(blocks), "model": model}
    if usage:
        msg["usage"] = usage
    return rec(type="assistant", timestamp=ts, message=msg)


def user_result(tool_use_id, text, ts=T0 % 1, is_error=False):
    return rec(type="user", timestamp=ts, message={"content": [
        {"type": "tool_result", "tool_use_id": tool_use_id,
         "content": text, "is_error": is_error}]})


def user_text(text, ts=T0 % 0, meta=False):
    r = rec(type="user", timestamp=ts,
            message={"content": [{"type": "text", "text": text}]})
    if meta:
        r["isMeta"] = True
    return r


def text(t):
    return {"type": "text", "text": t}


def tool(name, tid, **inp):
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def write_transcript(path: Path, records, trailing_partial=False):
    """Write records as JSONL; optionally leave a half-written final line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(json.dumps(r) + "\n" for r in records)
    if trailing_partial:
        body += '{"type":"assistant","message":{"conte'
    path.write_text(body)
    return path


def append_records(path: Path, records):
    with path.open("a") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")


def write_subagent(session_dir: Path, agent_id: str, records, meta):
    """A subagent transcript plus the meta.json that links it to its parent."""
    sub = session_dir / "subagents"
    sub.mkdir(parents=True, exist_ok=True)
    write_transcript(sub / ("%s.jsonl" % agent_id), records)
    (sub / ("%s.meta.json" % agent_id)).write_text(json.dumps(meta))
    return sub / ("%s.jsonl" % agent_id)
