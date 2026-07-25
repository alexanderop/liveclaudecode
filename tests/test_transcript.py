import tempfile
import unittest
from pathlib import Path

from liveclaudecode.transcript import (Scan, command_ok, find_milestones,
                                       short_path, tool_summary)

from . import fixtures as fx


class TempTranscript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, records, **kw):
        p = fx.write_transcript(self.dir / "s.jsonl", records, **kw)
        return Scan(p).refresh()


class TestEvents(TempTranscript):
    def test_tool_call_and_result_pair_up(self):
        sc = self.scan([
            fx.assistant(fx.text("looking"), fx.tool("Read", "t1", file_path="/repo/a.ts")),
            fx.user_result("t1", "1\tconst a = 1"),
        ])
        kinds = [e["kind"] for e in sc.events]
        self.assertEqual(kinds, ["text", "tool_use", "tool_result"])
        self.assertEqual(sc.events[1]["summary"], "/repo/a.ts")
        self.assertEqual(sc.events[2]["tool"], "Read")
        self.assertEqual(sc.errors, 0)

    def test_unanswered_tool_call_is_the_current_activity(self):
        sc = self.scan([fx.assistant(fx.tool("Bash", "t1", command="pnpm test"))])
        self.assertEqual(sc.current_activity()["tool"], "Bash")
        self.assertEqual(sc.current_activity()["summary"], "pnpm test")

    def test_answered_tool_call_clears_the_current_activity(self):
        sc = self.scan([
            fx.assistant(fx.tool("Bash", "t1", command="pnpm test")),
            fx.user_result("t1", "ok"),
        ])
        self.assertIsNone(sc.current_activity())

    def test_error_results_are_counted_and_flagged(self):
        sc = self.scan([
            fx.assistant(fx.tool("Bash", "t1", command="nope")),
            fx.user_result("t1", "Error: command not found", is_error=True),
        ])
        self.assertEqual(sc.errors, 1)
        self.assertTrue(sc.events[-1]["error"])

    def test_system_reminders_are_marked_as_noise(self):
        sc = self.scan([fx.user_text("<system-reminder>hi</system-reminder>")])
        self.assertEqual(sc.events[0]["kind"], "meta")

    def test_real_prompts_are_not_noise(self):
        sc = self.scan([fx.user_text("please fix the build")])
        self.assertEqual(sc.events[0]["kind"], "prompt")


class TestIncrementalReads(TempTranscript):
    def test_partial_trailing_line_is_not_parsed_until_complete(self):
        recs = [fx.assistant(fx.text("one"))]
        p = fx.write_transcript(self.dir / "s.jsonl", recs, trailing_partial=True)
        sc = Scan(p).refresh()
        self.assertEqual(len(sc.events), 1)

        # the writer discards the half-line and appends a complete record
        p.write_text(p.read_text().rsplit("\n", 1)[0] + "\n")
        fx.append_records(p, [fx.assistant(fx.text("two"))])
        sc.refresh()
        self.assertEqual([e["body"] for e in sc.events], ["one", "two"])

    def test_refresh_only_parses_new_lines(self):
        p = fx.write_transcript(self.dir / "s.jsonl", [fx.assistant(fx.text("one"))])
        sc = Scan(p).refresh()
        self.assertEqual(sc.line, 1)
        fx.append_records(p, [fx.assistant(fx.text("two"))])
        sc.refresh()
        self.assertEqual(sc.line, 2)
        self.assertEqual(len(sc.events), 2)

    def test_malformed_line_is_skipped_not_fatal(self):
        p = self.dir / "s.jsonl"
        p.write_text('{"type":"assistant""broken"}\n')
        fx.append_records(p, [fx.assistant(fx.text("fine"))])
        sc = Scan(p).refresh()
        self.assertEqual([e["body"] for e in sc.events], ["fine"])


class TestWorkTracking(TempTranscript):
    def test_edits_are_collected_relative_to_the_run_cwd(self):
        sc = self.scan([
            fx.assistant(fx.tool("Edit", "t1", file_path="/repo/src/a.ts")),
            fx.user_result("t1", "ok"),
            fx.assistant(fx.tool("Write", "t2", file_path="/repo/src/a.ts")),
            fx.user_result("t2", "ok"),
        ])
        self.assertEqual(sc.files["src/a.ts"]["ops"], 2)
        self.assertEqual(sorted(sc.files["src/a.ts"]["tools"]), ["Edit", "Write"])

    def test_reads_do_not_count_as_changes(self):
        sc = self.scan([fx.assistant(fx.tool("Read", "t1", file_path="/repo/src/a.ts"))])
        self.assertEqual(sc.files, {})

    def test_command_outcome_is_inferred_from_output(self):
        sc = self.scan([
            fx.assistant(fx.tool("Bash", "t1", command="pnpm test:unit")),
            fx.user_result("t1", "Test Files  3 passed (3)"),
            fx.assistant(fx.tool("Bash", "t2", command="pnpm type-check")),
            fx.user_result("t2", "src/a.ts(3,1): error TS2345: bad"),
        ])
        self.assertEqual([c["ok"] for c in sc.commands], [True, False])

    def test_running_command_has_no_outcome_yet(self):
        sc = self.scan([fx.assistant(fx.tool("Bash", "t1", command="pnpm test"))])
        self.assertIsNone(sc.commands[0]["ok"])

    def test_spawned_agents_are_recorded(self):
        sc = self.scan([fx.assistant(fx.tool("Agent", "t1", description="slice A"))])
        self.assertIn("t1", sc.spawn_ids)

    def test_todos_keep_only_the_latest_state(self):
        sc = self.scan([
            fx.assistant(fx.tool("TodoWrite", "t1", todos=[{"content": "a", "status": "pending"}])),
            fx.user_result("t1", "ok"),
            fx.assistant(fx.tool("TodoWrite", "t2", todos=[{"content": "a", "status": "completed"}])),
            fx.user_result("t2", "ok"),
        ])
        self.assertEqual(sc.todos, [{"content": "a", "status": "completed"}])

    def test_output_tokens_accumulate(self):
        sc = self.scan([
            fx.assistant(fx.text("a"), usage={"output_tokens": 10}),
            fx.assistant(fx.text("b"), usage={"output_tokens": 5}),
        ])
        self.assertEqual(sc.tokens_out, 15)


class TestMilestones(unittest.TestCase):
    def test_wave_markers_are_strong(self):
        # trailing punctuation is stripped from the title
        self.assertEqual(find_milestones("**Wave 1 (parallel slices):**"),
                         [("Wave 1 (parallel slices)", True)])

    def test_bold_headings_are_weak(self):
        self.assertEqual(find_milestones("**Rulings I folded in**"),
                         [("Rulings I folded in", False)])

    def test_explicit_markers_win_over_bold_headings_in_one_message(self):
        found = find_milestones("**Before**\n\n**Wave 2 — DI core**\n\n**After**")
        self.assertEqual(found, [("Wave 2 — DI core", True)])

    def test_prose_yields_nothing(self):
        self.assertEqual(find_milestones("just some ordinary sentence"), [])


class TestHelpers(unittest.TestCase):
    def test_short_path_prefers_the_run_cwd(self):
        self.assertEqual(short_path("/repo/src/a.ts", "/repo"), "src/a.ts")

    def test_short_path_falls_back_to_tail_segments(self):
        self.assertEqual(short_path("/a/b/c/d/e.ts", "/other"), "c/d/e.ts")

    def test_tool_summary_picks_the_meaningful_field(self):
        self.assertEqual(tool_summary({"command": "ls  -l"}), "ls -l")
        self.assertEqual(tool_summary({"file_path": "/a.ts"}), "/a.ts")

    def test_command_ok_ignores_the_word_error_inside_passing_output(self):
        self.assertTrue(command_ok("✓ 12 passed — no errors reported", False))

    def test_command_ok_is_false_when_the_tool_itself_errored(self):
        self.assertFalse(command_ok("anything", True))


if __name__ == "__main__":
    unittest.main()
