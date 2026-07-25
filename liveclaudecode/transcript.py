"""Incremental parsing of a single Claude Code JSONL transcript.

A transcript is append-only JSON Lines. `Scan` keeps a parsed view of one file
and only reads the lines it has not seen yet, so polling a 2 MB transcript
every two seconds stays cheap. A trailing line without a newline is treated as
still being written and is re-read on the next refresh.
"""

import json
import re
import time
from pathlib import Path

MAX_CHARS = 8000        # per message body sent to the browser
LIVE_WINDOW = 45        # seconds since last write before a run counts as idle

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_editor"}
READ_TOOLS = {"Read", "Glob", "Grep", "NotebookRead"}
SPAWN_TOOLS = {"Agent", "Task"}


# ------------------------------------------------------------------ helpers
def plain_text(content) -> str:
    """Concatenated text of a message content field (str or block list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text", ""))
            elif isinstance(b, str):
                out.append(b)
        return "\n".join(out)
    return ""


TOOL_SUMMARY_KEYS = [
    "command", "file_path", "pattern", "path", "description", "prompt",
    "query", "url", "skill", "notebook_path", "old_string",
]


def tool_summary(inp) -> str:
    """The one line worth showing for a tool call: its command, path, pattern..."""
    if not isinstance(inp, dict):
        return ""
    for k in TOOL_SUMMARY_KEYS:
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            return re.sub(r"\s+", " ", v.strip())
    try:
        return json.dumps(inp)[:200]
    except Exception:
        return ""


def result_text(tr) -> str:
    if isinstance(tr, str):
        return tr
    if isinstance(tr, list):
        out = []
        for b in tr:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    out.append(b.get("text", ""))
                elif b.get("type") == "image":
                    out.append("[image]")
            elif isinstance(b, str):
                out.append(b)
        return "\n".join(out)
    if isinstance(tr, dict):
        try:
            return json.dumps(tr, indent=2)
        except Exception:
            return str(tr)
    return ""


def clip(s: str):
    """(body, original_length) — long bodies are truncated for transport."""
    s = s or ""
    return (s[:MAX_CHARS], len(s)) if len(s) > MAX_CHARS else (s, len(s))


# Milestone signals, in priority order: explicit wave/phase/slice markers,
# then bold standalone headings, then markdown headings.
PHASE_RES = [
    re.compile(
        r"^\s{0,3}(?:[-*]\s*)?(?:#{1,4}\s*)?(?:\*\*)?\s*"
        r"((?:Wave|Phase|Slice|Step|Round|Stage)\s+[\w\d.]+[^\n*]{0,70})",
        re.IGNORECASE | re.MULTILINE,
    ),
    re.compile(r"^\s{0,3}\*\*([^\n*]{4,70})\*\*:?\s*$", re.MULTILINE),
    re.compile(r"^\s{0,3}#{1,4}\s+([^\n]{4,70})$", re.MULTILINE),
]


def find_milestones(text: str):
    """[(title, strong)] — strong marks an explicit Wave/Phase/Slice/Step line.

    Only the highest-priority pattern that matches is used, so a message full of
    bold sub-headings does not drown out the run's actual phase markers.
    """
    for i, rx in enumerate(PHASE_RES):
        hits = [(m.start(), re.sub(r"\s+", " ", m.group(1)).strip(" *:#-"))
                for m in rx.finditer(text)]
        if hits:
            return [(t, i == 0) for _, t in sorted(hits)]
    return []


FAIL_RE = re.compile(
    r"\b(\d+ failed|FAIL\b|failing|error TS\d+|Error:|✗|✘|command not found|"
    r"exit code [1-9]|Test Files\s+\d+ failed)", re.IGNORECASE)
PASS_RE = re.compile(r"\b(passed|✓|PASS\b|0 problems|no issues|success)", re.IGNORECASE)


def command_ok(output: str, is_error: bool):
    """Best-effort pass/fail for a shell command from its output."""
    if is_error:
        return False
    head = (output or "")[:2500]
    if FAIL_RE.search(head) and not PASS_RE.search(head[:200]):
        return False
    return True


def short_path(p: str, root: str = "") -> str:
    """Path relative to the run's own cwd, else the last three segments."""
    if not p:
        return ""
    if root and p.startswith(root.rstrip("/") + "/"):
        return p[len(root.rstrip("/")) + 1:]
    parts = p.split("/")
    return "/".join(parts[-3:]) if len(parts) > 3 else p


# ------------------------------------------------------------------ scan
class Scan:
    """Parsed, incrementally-updated view of one transcript file."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.line = 0             # complete lines consumed so far
        self.events = []          # render-ready events, in file order
        self.tool_uses = {}       # tool_use_id -> {name, summary, ts}
        self.open_tools = {}      # tool_use_id -> same, still awaiting a result
        self.spawn_ids = {}       # tool_use_id of Agent/Task calls
        self.files = {}           # short path -> {ops, tools, lastTs}
        self.commands = []        # [{cmd, ts, ok, tid}]
        self.cmd_by_tid = {}
        self.todos = None
        self.skills = []
        self.milestones = []
        self.counts = {}
        self.errors = 0
        self.first_ts = None
        self.last_ts = None
        self.tokens_out = 0
        self.final_text = ""
        self.cwd = ""

    # -- reading
    def refresh(self):
        """Parse whatever has been appended since the last call."""
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return self
        text = raw.decode("utf-8", "replace")
        lines = text.split("\n")
        # The last element is either "" (file ends with \n) or a partially
        # written line; either way it is not ready to parse yet.
        complete = lines[:-1]
        for i in range(self.line, len(complete)):
            s = complete[i]
            if not s.strip():
                continue
            try:
                d = json.loads(s)
            except Exception:
                continue
            self._ingest(d, i)
        self.line = len(complete)
        return self

    # -- one record
    def _ingest(self, d, idx):
        self.cwd = self.cwd or d.get("cwd") or ""
        ts = d.get("timestamp")
        if ts:
            self.first_ts = self.first_ts or ts
            self.last_ts = ts
        typ = d.get("type")
        if typ == "assistant":
            self._assistant(d, idx, ts)
        elif typ == "user":
            self._user(d, idx, ts)
        elif typ == "system":
            txt = d.get("content") or ""
            if isinstance(txt, str) and txt.strip():
                body, full = clip(txt)
                self.events.append({"role": "system", "kind": "system", "ts": ts,
                                    "body": body, "full": full, "line": idx})

    def _assistant(self, d, idx, ts):
        msg = d.get("message") or {}
        content = msg.get("content")
        blocks = content if isinstance(content, list) else (
            [{"type": "text", "text": content}] if isinstance(content, str) else []
        )
        usage = msg.get("usage") or {}
        self.tokens_out += usage.get("output_tokens", 0) or 0
        made = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and (b.get("text") or "").strip():
                self.final_text = b["text"]
                body, full = clip(b["text"])
                made.append({"kind": "text", "ts": ts, "body": body, "full": full})
                for title, strong in find_milestones(b["text"]):
                    if not self.milestones or self.milestones[-1]["title"] != title:
                        self.milestones.append(
                            {"title": title[:90], "ts": ts, "strong": strong})
            elif bt == "thinking" and (b.get("thinking") or "").strip():
                body, full = clip(b["thinking"])
                made.append({"kind": "thinking", "ts": ts, "body": body, "full": full})
            elif bt == "tool_use":
                made.append(self._tool_use(b, ts))
        if made:
            if usage:
                made[-1]["usage"] = {
                    "in": usage.get("input_tokens", 0),
                    "out": usage.get("output_tokens", 0),
                    "cr": usage.get("cache_read_input_tokens", 0),
                    "cw": usage.get("cache_creation_input_tokens", 0),
                }
            made[-1]["model"] = msg.get("model", "")
        for e in made:
            e["role"] = "assistant"
            e["line"] = idx
            self.events.append(e)

    def _tool_use(self, b, ts):
        name = b.get("name", "?")
        tid = b.get("id")
        inp = b.get("input") or {}
        summ = tool_summary(inp)
        self.counts[name] = self.counts.get(name, 0) + 1
        rec = {"name": name, "summary": summ, "ts": ts}
        self.tool_uses[tid] = rec
        self.open_tools[tid] = rec
        if name == "Skill" and inp.get("skill"):
            self.skills.append({"skill": inp["skill"], "ts": ts})
        if name in SPAWN_TOOLS:
            self.spawn_ids[tid] = True
        if name == "TodoWrite" and isinstance(inp.get("todos"), list):
            self.todos = inp["todos"]
        if name in EDIT_TOOLS:
            fp = inp.get("file_path") or inp.get("notebook_path") or inp.get("path")
            if fp:
                e = self.files.setdefault(short_path(fp, self.cwd),
                                          {"ops": 0, "tools": [], "lastTs": ts})
                e["ops"] += 1
                e["lastTs"] = ts
                if name not in e["tools"]:
                    e["tools"].append(name)
        if name == "Bash":
            cmd = re.sub(r"\s+", " ", (inp.get("command") or "").strip())
            c = {"cmd": cmd[:160], "ts": ts, "ok": None, "tid": tid}
            self.commands.append(c)
            self.cmd_by_tid[tid] = c
        return {"kind": "tool_use", "ts": ts, "tool": name, "id": tid,
                "summary": summ, "input": clip(json.dumps(inp, indent=2))[0],
                "spawn": name in SPAWN_TOOLS, "write": name in EDIT_TOOLS}

    def _user(self, d, idx, ts):
        msg = d.get("message") or {}
        content = msg.get("content")
        blocks = content if isinstance(content, list) else (
            [{"type": "text", "text": content or ""}] if content else []
        )
        for b in blocks:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_result":
                tid = b.get("tool_use_id")
                self.open_tools.pop(tid, None)
                txt = result_text(b.get("content"))
                is_err = bool(b.get("is_error")) or txt.lstrip().lower().startswith("error")
                if is_err:
                    self.errors += 1
                c = self.cmd_by_tid.get(tid)
                if c is not None:
                    c["ok"] = command_ok(txt, is_err)
                body, full = clip(txt)
                src = self.tool_uses.get(tid, {})
                self.events.append({
                    "role": "tool", "kind": "tool_result", "ts": ts, "id": tid,
                    "tool": src.get("name", ""), "summary": src.get("summary", "")[:120],
                    "error": is_err, "body": body, "full": full, "line": idx,
                })
            elif b.get("type") == "text":
                txt = b.get("text") or ""
                if not txt.strip():
                    continue
                meta = bool(d.get("isMeta")) or txt.lstrip().startswith("<system-reminder")
                body, full = clip(txt)
                self.events.append({
                    "role": "user", "kind": "meta" if meta else "prompt",
                    "ts": ts, "body": body, "full": full, "line": idx,
                })

    # -- derived
    def current_activity(self):
        """The tool call still awaiting a result, i.e. what this agent is doing."""
        if not self.open_tools:
            return None
        tid = list(self.open_tools)[-1]
        rec = self.open_tools[tid]
        return {"tool": rec["name"], "summary": rec["summary"][:160], "ts": rec["ts"]}

    def stats(self):
        st = self.path.stat()
        now = time.time()
        files = [
            {"path": p, "ops": v["ops"], "tools": v["tools"], "lastTs": v["lastTs"]}
            for p, v in sorted(self.files.items(), key=lambda kv: -kv[1]["ops"])
        ]
        return {
            "records": self.line,
            "tools": sum(self.counts.values()),
            "toolCounts": self.counts,
            "reads": sum(v for k, v in self.counts.items() if k in READ_TOOLS),
            "errors": self.errors,
            "tokensOut": self.tokens_out,
            "firstTs": self.first_ts,
            "lastTs": self.last_ts,
            "mtime": st.st_mtime,
            "ago": int(now - st.st_mtime),
            "live": (now - st.st_mtime) < LIVE_WINDOW,
            "size": st.st_size,
            "todos": self.todos,
            "skills": self.skills[-6:],
            "milestones": self.milestones[-10:],
            "current": self.current_activity(),
            "files": files,
            "commands": self.commands[-40:],
            "finalText": self.final_text[:600],
        }


# One Scan per file for the process lifetime, so re-parsing stays incremental.
SCANS = {}


def get_scan(path) -> Scan:
    key = str(path)
    sc = SCANS.get(key)
    if sc is None:
        sc = SCANS[key] = Scan(Path(path))
    sc.refresh()
    return sc


def reset_cache():
    """Drop all cached scans (tests, or a project switch)."""
    SCANS.clear()


__all__ = [
    "Scan", "get_scan", "reset_cache", "find_milestones", "short_path",
    "command_ok", "tool_summary", "plain_text", "result_text", "clip",
    "EDIT_TOOLS", "READ_TOOLS", "SPAWN_TOOLS", "LIVE_WINDOW", "MAX_CHARS",
]
