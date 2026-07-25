import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from liveclaudecode.server import make_server
from liveclaudecode.transcript import reset_cache

from . import fixtures as fx

SESSION = "sess-1"


class TestEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reset_cache()
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        fx.write_transcript(d / ("%s.jsonl" % SESSION), [
            fx.user_text("/ship @plan.md"),
            fx.assistant(fx.text("**Wave 1**"),
                         fx.tool("Agent", "spawn-a", description="slice A")),
        ])
        fx.write_subagent(d / SESSION, "agent-a", [
            fx.assistant(fx.tool("Edit", "e1", file_path="/repo/src/a.ts")),
            fx.user_result("e1", "ok"),
        ], {"agentType": "implementation-worker", "description": "slice A",
            "toolUseId": "spawn-a"})

        cls.httpd = make_server(d, port=0, hours=99999)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()
        reset_cache()

    def get(self, path):
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        with urllib.request.urlopen(url) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")

    def get_json(self, path):
        status, body, _ = self.get(path)
        return status, json.loads(body)

    def test_index_is_served(self):
        status, body, ctype = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"Claude Run", body)

    def test_static_assets_are_served_with_types(self):
        for name, expect in (("app.css", "text/css"), ("app.js", "javascript")):
            status, _, ctype = self.get("/static/%s" % name)
            self.assertEqual(status, 200)
            self.assertIn(expect, ctype)

    def test_directory_traversal_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/static/../../etc/passwd")
        self.assertEqual(cm.exception.code, 404)

    def test_tree_returns_the_run_hierarchy(self):
        status, j = self.get_json("/api/tree")
        self.assertEqual(status, 200)
        root = j["roots"][0]
        self.assertEqual(root["key"], SESSION)
        self.assertEqual(root["children"][0]["agentType"], "implementation-worker")

    def test_run_describes_the_whole_run_for_a_selected_worker(self):
        status, j = self.get_json("/api/run?key=%s/agent-a" % SESSION)
        self.assertEqual(status, 200)
        self.assertEqual(j["root"]["key"], SESSION)          # panels stay run-wide
        self.assertEqual(j["node"]["label"], "slice A")      # selection is the worker
        self.assertEqual(len(j["lanes"]), 2)
        self.assertEqual(j["files"], [["src/a.ts", 1]])
        self.assertEqual([p["title"] for p in j["phases"]], ["Wave 1"])

    def test_events_paginate_by_index(self):
        _, first = self.get_json("/api/events?key=%s&since=0" % SESSION)
        self.assertGreater(len(first["events"]), 0)
        _, second = self.get_json("/api/events?key=%s&since=%d"
                                  % (SESSION, first["next"]))
        self.assertEqual(second["events"], [])
        self.assertEqual(second["next"], first["next"])

    def test_agent_calls_link_to_the_transcript_they_spawned(self):
        _, j = self.get_json("/api/events?key=%s&since=0" % SESSION)
        spawn = [e for e in j["events"] if e.get("spawn")][0]
        self.assertEqual(spawn["childKey"], "%s/agent-a" % SESSION)

    def test_unknown_key_is_a_404(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get("/api/run?key=nope")
        self.assertEqual(cm.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
