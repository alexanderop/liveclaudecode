import tempfile
import unittest
from pathlib import Path

from liveclaudecode.runs import (build_tree, flatten, path_for, root_of,
                                 run_phases)
from liveclaudecode.transcript import reset_cache

from . import fixtures as fx

SESSION = "sess-1"


class RunTreeCase(unittest.TestCase):
    """A session that spawns two workers, one of which is still running."""

    def setUp(self):
        reset_cache()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

        fx.write_transcript(self.dir / ("%s.jsonl" % SESSION), [
            fx.user_text("/ship @plan.md"),
            fx.assistant(fx.text("**Wave 1 — two slices**"),
                         fx.tool("Agent", "spawn-a", description="slice A"),
                         fx.tool("Agent", "spawn-b", description="slice B"),
                         ts=fx.T0 % 1),
            fx.user_result("spawn-a", "done", ts=fx.T0 % 30),
        ])
        sdir = self.dir / SESSION
        fx.write_subagent(sdir, "agent-a", [
            fx.assistant(fx.tool("Edit", "e1", file_path="/repo/src/a.ts"), ts=fx.T0 % 2),
            fx.user_result("e1", "ok", ts=fx.T0 % 3),
        ], {"agentType": "implementation-worker", "description": "slice A",
            "toolUseId": "spawn-a"})
        fx.write_subagent(sdir, "agent-b", [
            fx.assistant(fx.text("**Wave 2 — follow up**"),
                         fx.tool("Bash", "b1", command="pnpm test"), ts=fx.T0 % 4),
        ], {"agentType": "implementation-worker", "description": "slice B",
            "toolUseId": "spawn-b"})

        self.roots, self.by_key = build_tree(self.dir, hours=99999)

    def tearDown(self):
        self.tmp.cleanup()
        reset_cache()


class TestHierarchy(RunTreeCase):
    def test_subagents_hang_off_the_transcript_that_spawned_them(self):
        self.assertEqual(len(self.roots), 1)
        root = self.roots[0]
        self.assertEqual(root["key"], SESSION)
        self.assertEqual(sorted(c["label"] for c in root["children"]),
                         ["slice A", "slice B"])

    def test_returned_and_running_agents_are_distinguished(self):
        state = {c["label"]: c["spawnState"] for c in self.roots[0]["children"]}
        self.assertEqual(state["slice A"], "returned")
        self.assertEqual(state["slice B"], "running")

    def test_rollups_aggregate_the_whole_subtree(self):
        root = self.roots[0]
        self.assertEqual(root["subAgents"], 2)
        self.assertEqual(root["subTools"], 4)          # 2 spawns + edit + bash
        self.assertEqual(root["subFiles"], {"src/a.ts": 1})

    def test_lanes_are_depth_ordered_for_the_timeline(self):
        lanes = flatten(self.roots[0])
        self.assertEqual([lane["depth"] for lane in lanes], [0, 1, 1])
        self.assertEqual(lanes[0]["key"], SESSION)

    def test_root_of_finds_the_run_a_worker_belongs_to(self):
        worker = "%s/agent-b" % SESSION
        self.assertEqual(root_of(self.roots, worker)["key"], SESSION)

    def test_phases_merge_across_every_agent_in_the_run(self):
        titles = [p["title"] for p in run_phases(self.roots[0])]
        self.assertEqual(titles, ["Wave 1 — two slices", "Wave 2 — follow up"])

    def test_phase_entries_name_the_agent_that_announced_them(self):
        who = {p["title"]: p["who"] for p in run_phases(self.roots[0])}
        self.assertEqual(who["Wave 1 — two slices"], "main")
        self.assertEqual(who["Wave 2 — follow up"], "slice B")


class TestPaths(unittest.TestCase):
    def test_session_key_maps_to_a_top_level_transcript(self):
        self.assertEqual(path_for(Path("/p"), "abc"), Path("/p/abc.jsonl"))

    def test_subagent_key_maps_into_the_subagents_directory(self):
        self.assertEqual(path_for(Path("/p"), "abc/agent-1"),
                         Path("/p/abc/subagents/agent-1.jsonl"))


class TestAgeFilter(RunTreeCase):
    def test_hours_filter_can_exclude_everything(self):
        reset_cache()
        roots, _ = build_tree(self.dir, hours=0)
        self.assertEqual(roots, [])


if __name__ == "__main__":
    unittest.main()
