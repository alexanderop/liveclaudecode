"""Read-only HTTP server: static UI plus three JSON endpoints.

    GET /                       the UI
    GET /api/tree               every run in the project, as a tree
    GET /api/run?key=           timeline lanes, files written, phases for a run
    GET /api/events?key=&since= transcript events after index `since`

Nothing here writes to disk; the transcripts are only ever read.
"""

import http.server
import json
import mimetypes
import socketserver
import time
import urllib.parse
from pathlib import Path

from .runs import (build_tree, flatten, path_for, root_of, run_phases,
                   strip_node)
from .transcript import get_scan

STATIC = Path(__file__).parent / "static"


class Handler(http.server.BaseHTTPRequestHandler):
    project_dir = None
    hours = 24.0

    server_version = "liveclaudecode"

    def log_message(self, *args):
        pass  # the terminal belongs to the run being watched, not to us

    # -- responses
    def _send(self, body: bytes, ctype: str, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser navigated away mid-poll

    def _json(self, obj, code=200):
        self._send(json.dumps(obj).encode(), "application/json", code)

    def _static(self, name: str):
        p = (STATIC / name).resolve()
        if not p.is_file() or STATIC.resolve() not in p.parents:
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(p.read_bytes(), ctype)

    # -- routes
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        if u.path == "/":
            return self._static("index.html")
        if u.path.startswith("/static/"):
            return self._static(u.path[len("/static/"):])
        if u.path == "/favicon.ico":
            return self._send(b"", "image/x-icon", 204)
        if u.path == "/api/tree":
            return self._tree()
        if u.path == "/api/run":
            return self._run(q.get("key", [""])[0])
        if u.path == "/api/events":
            return self._events(q.get("key", [""])[0], q.get("since", ["0"])[0])
        self.send_error(404)

    def _tree(self):
        roots, _ = build_tree(self.project_dir, self.hours)
        self._json({"project": self.project_dir.name, "roots": roots, "now": time.time()})

    def _run(self, key):
        roots, by_key = build_tree(self.project_dir, self.hours)
        if key not in by_key:
            return self._json({"error": "unknown key"}, 404)
        # The panels describe the whole run, not just the selected agent, so the
        # overview stays stable while the feed follows the active worker.
        root = root_of(roots, key)
        files = sorted(root["subFiles"].items(), key=lambda kv: -kv[1])
        self._json({
            "key": key,
            "lanes": flatten(root),
            "files": files,
            "phases": run_phases(root),
            "node": strip_node(by_key[key]),
            "root": strip_node(root),
        })

    def _events(self, key, since):
        try:
            since = int(since)
        except ValueError:
            since = 0
        _, by_key = build_tree(self.project_dir, self.hours)
        if key not in by_key:
            return self._json({"error": "unknown key"}, 404)
        node = by_key[key]
        sc = get_scan(path_for(self.project_dir, key))
        # Link each Agent call to the transcript it spawned, so the UI can offer
        # a jump straight into that subagent.
        child_by_tid = {c["toolUseId"]: c["key"]
                        for c in node["children"] if c.get("toolUseId")}
        out = []
        for e in sc.events[since:]:
            if e.get("spawn") and e.get("id") in child_by_tid:
                e = dict(e, childKey=child_by_tid[e["id"]])
            out.append(e)
        self._json({"key": key, "events": out, "next": len(sc.events),
                    "node": strip_node(node)})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_server(project_dir: Path, port: int, host: str = "127.0.0.1",
                hours: float = 24.0) -> Server:
    Handler.project_dir = Path(project_dir)
    Handler.hours = hours
    return Server((host, port), Handler)


def serve(project_dir: Path, port: int, host: str = "127.0.0.1", hours: float = 24.0):
    with make_server(project_dir, port, host, hours) as httpd:
        httpd.serve_forever()
