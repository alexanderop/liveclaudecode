"""Turning a directory of transcripts into one run tree.

Claude Code stores a project's transcripts as `<session>.jsonl`, with any
subagent it spawned under `<session>/subagents/<agent>.jsonl` next to an
`<agent>.meta.json`. The meta file records the `toolUseId` of the Agent call
that created it, which is what lets us rebuild the real spawn hierarchy:
the transcript containing that tool call is the parent.
"""

import json
import re
import time
from pathlib import Path

from .transcript import SCANS, get_scan, plain_text

PROJECTS = Path.home() / ".claude" / "projects"


def project_dir_for(cwd: str) -> Path:
    """Claude Code slugifies the working directory to name the project dir."""
    return PROJECTS / str(cwd).replace("/", "-")


def newest_project_dir() -> Path:
    dirs = [p for p in PROJECTS.iterdir() if p.is_dir()]
    if not dirs:
        raise SystemExit(f"no transcripts found under {PROJECTS}")
    return max(dirs, key=lambda p: p.stat().st_mtime)


_prompt_cache = {}


def first_prompt(path: Path) -> str:
    """The opening user message, used as a session's human-readable label."""
    k = str(path)
    if k in _prompt_cache:
        return _prompt_cache[k]
    text = ""
    try:
        with path.open() as fh:
            for i, line in enumerate(fh):
                if i > 60:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "user":
                    continue
                t = plain_text((d.get("message") or {}).get("content"))
                t = re.sub(r"<command-(name|message|args)>", " ", t)
                t = re.sub(r"<[^>]+>", " ", t)
                t = re.sub(r"\s+", " ", t).strip()
                if t and not t.startswith("Caveat:"):
                    text = t[:100]
                    break
    except Exception:
        pass
    _prompt_cache[k] = text
    return text


def collect(project_dir: Path, max_age_h: float):
    """Every transcript in the project touched within `max_age_h` hours."""
    cutoff = time.time() - max_age_h * 3600
    items = []
    for jf in sorted(project_dir.glob("*.jsonl")):
        if jf.stat().st_mtime < cutoff:
            continue
        items.append({"key": jf.stem, "path": str(jf), "kind": "session",
                      "sid": jf.stem, "meta": {},
                      "label": first_prompt(jf) or jf.stem[:8]})
    for af in sorted(project_dir.rglob("subagents/*.jsonl")):
        if af.stat().st_mtime < cutoff:
            continue
        meta = {}
        mp = af.with_suffix(".meta.json")
        if mp.exists():
            try:
                meta = json.loads(mp.read_text())
            except Exception:
                pass
        sid = af.parent.parent.name
        items.append({"key": "%s/%s" % (sid, af.stem), "path": str(af),
                      "kind": "subagent", "sid": sid, "meta": meta,
                      "label": meta.get("description") or af.stem})
    return items


def build_tree(project_dir: Path, hours: float):
    """(roots, by_key) — every node carries its own stats and subtree rollups."""
    items = collect(project_dir, hours)
    by_key = {}
    for it in items:
        sc = get_scan(Path(it["path"]))
        node = dict(it)
        node.update(sc.stats())
        node["agentType"] = it["meta"].get("agentType", "") if it["kind"] == "subagent" else ""
        node["toolUseId"] = it["meta"].get("toolUseId")
        node["children"] = []
        node.pop("meta", None)
        node.pop("path", None)
        by_key[node["key"]] = node

    # Which transcript issued each Agent call, and whether it has returned.
    owner, spawn_state = {}, {}
    for it in items:
        sc = SCANS[it["path"]]
        for tid in sc.spawn_ids:
            owner[tid] = it["key"]
            spawn_state[tid] = "running" if tid in sc.open_tools else "returned"

    roots = []
    for node in by_key.values():
        node["spawnState"] = spawn_state.get(node.get("toolUseId"), "")
        pk = owner.get(node.get("toolUseId")) if node["toolUseId"] else None
        if pk and pk in by_key and pk != node["key"]:
            by_key[pk]["children"].append(node)
        elif node["kind"] == "subagent" and node["sid"] in by_key:
            # Nested agent whose spawning call we could not find: fall back to
            # hanging it off its owning session rather than dropping it.
            by_key[node["sid"]]["children"].append(node)
        else:
            roots.append(node)

    for r in roots:
        rollup(r)
    roots.sort(key=lambda n: n["subLast"] or "", reverse=True)
    return roots, by_key


def rollup(n):
    """Aggregate subtree totals onto every node (agents, tools, errors, files)."""
    agents = running = 0
    errors = n["errors"]
    tools = n["tools"]
    files = {f["path"]: f["ops"] for f in n["files"]}
    last = n["lastTs"] or ""
    live = n["live"]
    for c in n["children"]:
        rollup(c)
        agents += 1 + c["subAgents"]
        running += (1 if c["spawnState"] == "running" or c["live"] else 0) + c["subRunning"]
        errors += c["subErrors"]
        tools += c["subTools"]
        for p, o in c["subFiles"].items():
            files[p] = files.get(p, 0) + o
        last = max(last, c["subLast"] or "")
        live = live or c["subLive"]
    n["subAgents"] = agents
    n["subRunning"] = running
    n["subErrors"] = errors
    n["subTools"] = tools
    n["subFiles"] = files
    n["subLast"] = last
    n["subLive"] = live
    n["children"].sort(key=lambda c: c["firstTs"] or "")
    return n


def flatten(n, depth=0, out=None):
    """Depth-ordered lanes for the timeline view."""
    out = [] if out is None else out
    out.append({
        "key": n["key"], "label": n["label"], "agentType": n["agentType"],
        "kind": n["kind"], "depth": depth, "firstTs": n["firstTs"],
        "lastTs": n["lastTs"], "live": n["live"], "errors": n["errors"],
        "tools": n["tools"], "spawnState": n["spawnState"],
        "files": len(n["files"]),
    })
    for c in n["children"]:
        flatten(c, depth + 1, out)
    return out


def root_of(roots, key):
    """The top-level run a given transcript belongs to."""
    def hit(n):
        return n["key"] == key or any(hit(c) for c in n["children"])
    for r in roots:
        if hit(r):
            return r
    return roots[0] if roots else None


def run_phases(root, limit=16):
    """Phases announced anywhere in the run, merged in time order.

    Explicit Wave/Phase/Slice markers win outright when the run has any, so an
    orchestrator's plan is not buried under incidental bold headings from its
    workers' reports.
    """
    phases = []

    def gather(n):
        who = n["label"] if n["kind"] == "subagent" else "main"
        for m in n["milestones"]:
            phases.append({"ts": m["ts"], "title": m["title"], "who": who,
                           "strong": m.get("strong", False)})
        for c in n["children"]:
            gather(c)

    gather(root)
    if any(m["strong"] for m in phases):
        phases = [m for m in phases if m["strong"]]
    phases.sort(key=lambda m: m["ts"] or "")
    return phases[-limit:]


def strip_node(n):
    """Node without the heavy fields the client does not need."""
    return {k: v for k, v in n.items() if k not in ("children", "subFiles")}


def path_for(project_dir: Path, key: str) -> Path:
    if "/" in key:
        sid, agent = key.split("/", 1)
        return project_dir / sid / "subagents" / ("%s.jsonl" % agent)
    return project_dir / ("%s.jsonl" % key)
