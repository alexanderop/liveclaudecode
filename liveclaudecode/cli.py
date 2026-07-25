"""Command line entry point."""

import argparse
import os
import sys
import webbrowser
from pathlib import Path

from . import __version__
from .runs import PROJECTS, newest_project_dir, project_dir_for
from .server import serve


def resolve_project(arg) -> Path:
    """--project accepts a path, a slug under ~/.claude/projects, or nothing."""
    if arg:
        p = Path(arg).expanduser()
        if p.is_dir() and list(p.glob("*.jsonl")):
            return p
        slug = PROJECTS / arg
        if slug.is_dir():
            return slug
        guess = project_dir_for(p.resolve())
        if guess.is_dir():
            return guess
        raise SystemExit("no transcripts for %r (looked in %s)" % (arg, PROJECTS))
    here = project_dir_for(os.getcwd())
    return here if here.is_dir() else newest_project_dir()


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="liveclaudecode",
        description="Live web view of a running Claude Code session and its subagents.")
    ap.add_argument("project", nargs="?", default=None,
                    help="repo path or ~/.claude/projects slug (default: current directory)")
    ap.add_argument("-p", "--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--hours", type=float, default=24.0,
                    help="only show transcripts touched in the last N hours (default: 24)")
    ap.add_argument("--open", action="store_true", help="open a browser window")
    ap.add_argument("-V", "--version", action="version", version=__version__)
    args = ap.parse_args(argv)

    project = resolve_project(args.project)
    url = "http://%s:%d" % (args.host, args.port)
    print("watching : %s" % project)
    print("open     : %s" % url)
    if args.open:
        webbrowser.open(url)
    try:
        serve(project, args.port, args.host, args.hours)
    except KeyboardInterrupt:
        print()
    except OSError as e:
        raise SystemExit("cannot bind %s: %s" % (url, e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
