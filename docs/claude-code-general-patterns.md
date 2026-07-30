# General Claude Code Project Report

## Executive summary

The best Claude Code projects do not rely on enormous prompts or complicated
agent scaffolding. They provide:

- Clear objectives
- A small number of meaningful constraints
- Access to relevant tools and context
- Strong automated verification
- Permission boundaries
- Regular evaluation and pruning

The operating principle is to manage Claude like a capable coworker: explain
the outcome and boundaries, then let it determine the implementation.

## 1. Keep `CLAUDE.md` small

Include only information Claude cannot reliably discover:

- Build, test, and lint commands
- Non-obvious architecture boundaries
- Project-specific conventions
- Safety or data-handling requirements
- Known traps and unusual dependencies

Avoid generic advice, tutorials, detailed API documentation, and rules added
after one isolated mistake.

Boris Cherny's recommendation is deliberately aggressive:

> “Every six months, delete your CLAUDE.md. Delete your skills. Delete your
> hooks.”

Practically, test Claude without custom instructions first. Add instructions
back only when you observe repeated failures.

### Interview example

When preparing Claude Code for Opus 5, the team removed more than 80% of its
system prompt. They also tested a minimal mode with the prompts removed from
both Claude Code and its tools. To determine what was genuinely useful, they
started with nothing and restored individual instructions one at a time while
measuring their effect. Cherny recommends applying the same experiment to
project instructions, skills, and hooks whenever a major new model arrives.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=415s)

### Related Claude documentation

- [How Claude remembers your project](https://code.claude.com/docs/en/memory) —
  `CLAUDE.md`, project rules, imports, auto memory, and guidance for keeping
  instructions concise.
- [CLI reference: bare mode](https://code.claude.com/docs/en/cli-usage) — run
  Claude without automatically loading `CLAUDE.md`, hooks, skills, plugins,
  MCP, or auto memory when testing how much scaffolding is still necessary.

## 2. Prompt with outcomes, not implementation recipes

A strong task prompt contains four elements:

```text
Objective:
What should change?

Context:
Where is the relevant code or source of truth?

Guardrails:
What must remain true?

Exit criteria:
How can Claude verify completion?
```

Example:

```text
Add password-reset support following the existing authentication patterns.

Preserve backward compatibility and do not add another authentication library.

The task is complete when expired and valid tokens are covered by tests,
the complete authentication test suite passes, and the application builds.
Choose the implementation approach.
```

Avoid specifying every file, function, and implementation step unless those
choices are genuine requirements.

### Interview example

Cherny asked Claude to rewrite an Electron desktop application in Swift. He
provided the desired result and the verification mechanism: run both versions
on a macOS virtual machine, capture screenshots, compare their appearance, and
keep iterating. He did not prescribe the file structure, sequence of edits, or
agent topology. The task continued for more than two weeks because the model
could decide how to proceed while repeatedly checking its own output.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=1293s)

### Related Claude documentation

- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) —
  prompt with specific context and verification criteria while leaving Claude
  room to determine the implementation.

## 3. Make verification the center of the workflow

Claude should not depend on a human to identify every mistake. Give it access
to:

- Unit and integration tests
- Typechecking and linting
- Build commands
- Expected inputs and outputs
- Browser automation
- Screenshots or visual references
- Logs and diagnostics
- Performance or accessibility checks

As Cherny puts it:

> “Verification … is probably the single most important thing.”

Every task should end with an objective signal that Claude can evaluate itself.

### Interview example

The Bun team explored rewriting more than 100,000 lines of its runtime from Zig
to Rust. The crucial enabling condition was not an elaborate prompt: Bun and
Node already had extensive test suites, so Claude could continuously determine
whether the rewritten runtime behaved correctly. The workflow ran for 11 days,
with human steering, and the resulting implementation was placed into
production for Claude Code.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=944s)

### Related Claude documentation

- [Best practices: give Claude a way to verify its work](https://code.claude.com/docs/en/best-practices) —
  use tests, expected outputs, browser checks, and screenshots as feedback.

## 4. Separate exploration, planning, and implementation

For complex work:

1. Ask Claude to inspect the relevant code and tests.
2. Request a plan covering dependencies, risks, and verification.
3. Review the plan.
4. Let Claude implement it.
5. Require it to run the verification loop.
6. Review the resulting diff.

Use plan mode for ambiguous or cross-cutting work. Skip it for small, obvious
changes where planning creates unnecessary overhead.

### Interview example

Cherny describes rebuilding a prompt as an observation cycle. First remove the
existing prompt, then use the product normally and watch where the model
struggles. Do not predict every instruction in advance. Restore an instruction
only when the model repeatedly stumbles over the same architecture, workflow,
or product requirement. This turns configuration into an evidence-based
process instead of an upfront design exercise.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=456s)

### Related Claude documentation

- [Choose a permission mode: plan mode](https://code.claude.com/docs/en/permission-modes) —
  let Claude research and propose changes without editing source files.

## 5. Give Claude progressively harder tasks

Do not assume a task is impossible because an older model failed.

Periodically retry:

- Large refactors
- Language or framework migrations
- Difficult bug investigations
- Performance optimization
- Test generation
- Dependency upgrades
- Cross-layer features
- Repository-wide maintenance

Start with a slightly harder task than you expect Claude to complete, provide
verification, and observe the result.

### Interview example

Rewriting Bun from Zig to Rust was used as a recurring challenge against new
model generations. Earlier models could find individual memory leaks but could
not complete the rewrite. Later models became capable of it. Cherny's advice is
to keep retrying important engineering or business problems with each new model
rather than permanently classifying them as impossible after an old failure.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=887s)

### Related Claude documentation

- [Agentic coding and persistent returns to expertise](https://www.anthropic.com/research/claude-code-expertise?level=0) —
  Anthropic research on how domain expertise, planning decisions, and
  verifiable outcomes affect real Claude Code sessions.

## 6. Improve the environment before expanding the prompt

When Claude struggles, diagnose the missing capability:

- Missing knowledge → provide a source file, documentation, or MCP integration.
- Repeated procedure → create a skill.
- Deterministic enforcement → create a hook.
- Missing feedback → add tests or another verifier.
- Excessive task size → divide the work.
- Insufficient context → identify the authoritative source.
- Noisy context → start a clean session.

Do not automatically solve every failure by adding another paragraph to
`CLAUDE.md`.

### Interview example

The Swift rewrite initially lacked two essential capabilities: Claude could not
access a macOS runner, and it could not access the target repository. Cherny
did not compensate with a longer prompt. He connected a GitHub macOS runner and
granted repository access. Once the missing tools and context were available,
Claude could begin the actual rewrite and visual verification loop.

He gives the same diagnostic rule for other failures: improve the prompt when
the objective is unclear, add a skill when a repeatable procedure is missing,
or connect an MCP source when Claude lacks required context.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=1416s)

### Related Claude documentation

- [Extend Claude Code](https://code.claude.com/docs/en/features-overview) — how
  to choose between `CLAUDE.md`, skills, subagents, hooks, MCP, agent teams, and
  plugins.

## 7. Use agents for decomposition

Parallel agents work well when tasks are genuinely independent:

- Researching separate subsystems
- Implementing isolated modules
- Generating tests for different packages
- Running specialized reviews
- Comparing alternative solutions
- Investigating multiple possible causes

Use isolated branches or worktrees for parallel implementation. Give each agent
explicit ownership and completion criteria, then have a coordinating agent
integrate and verify the result.

For recurring work, consider routines that propose:

- Dead-code removal
- Missing tests
- Documentation corrections
- Dependency updates
- Duplicate abstractions
- Performance improvements

Recurring agents should normally produce reviewable pull requests, not merge
directly.

### Interview examples

For a large one-time task, Claude Code's dynamic workflow divided work into
stages: an initial group of agents performed work, another group verified or
summarized it, and later stages fanned out again based on earlier results. The
Bun rewrite and Swift rewrite used this kind of orchestration rather than a
fixed collection of identical parallel agents.

For recurring work, Anthropic configured routines across its CLI, desktop, iOS,
and Android codebases. Examples included:

- Finding and removing dead code each day
- Removing completed experiment infrastructure
- Adding tests where meaningful coverage was missing
- Deleting tests that no longer provided value
- Finding nearly duplicated abstractions and consolidating them

These routines produced ongoing maintenance changes while engineers focused on
new product work and users.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=1482s)

### Related Claude documentation

- [Run agents in parallel](https://code.claude.com/docs/en/agents) — compare
  subagents, background sessions, agent teams, worktrees, and `/batch`.
- [Automate work with routines](https://code.claude.com/docs/en/routines) — run
  Claude Code on schedules, GitHub events, or API triggers in managed cloud
  environments.

## 8. Maintain an evaluation suite

Create representative tasks that measure how Claude performs in your project:

- A typical feature
- A bug fix
- A refactor
- A test-writing task
- An architecture-sensitive change
- A security-sensitive change
- A UI task requiring visual verification

For every new model or major configuration change, compare:

- Test success
- Number of corrections required
- Unnecessary code changes
- Architecture violations
- Cost and execution time
- Human review findings

Replace evaluations once models consistently solve them; saturated evaluations
no longer reveal meaningful differences.

### Interview example

Claude Code retains an evaluation only while it distinguishes useful behavior.
According to Cherny, an evaluation may remain useful for roughly one to three
model generations. Once newer models consistently solve it, the result becomes
saturated and the team replaces it with a harder evaluation derived from the
new model's observed struggles. The prompt, tools, and harness may change more
quickly than the evaluations, but the evaluations are not permanent either.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=565s)

### Related Claude and Anthropic documentation

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) —
  Anthropic's guide to tasks, trials, graders, transcripts, outcomes, harnesses,
  regression suites, and eval-driven development.

## 9. Preserve security boundaries

Improved model intelligence does not eliminate operational risk.

Use:

- Explicit permission rules
- Sandboxing for autonomous execution
- Protected secrets and environment files
- Human approval for deployment and merging
- Restricted external tools
- Trusted MCP servers only
- Separate environments for experiments
- Careful handling of untrusted web pages, issues, logs, and documents

Never use unrestricted permission modes on a valuable host environment merely
to reduce approval prompts.

### Interview example

Cherny says that after removing much of Claude Code's behavioral scaffolding,
most of the remaining harness code concerns safety, permissions, static
analysis, and user interface behavior. He also describes prompt-injection
defense as several layers: model alignment, a classifier that detects internal
signals associated with prompt injection, and the safety checks used by auto
mode. The practical lesson is to simplify behavioral prompting without
deleting enforcement and safety boundaries.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=126s)

### Related Claude documentation and engineering articles

- [Configure Claude Code permissions](https://code.claude.com/docs/en/permissions) —
  allow, ask, and deny rules; protected paths; permission modes; and sandbox
  integration.
- [Making Claude Code more secure with sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) —
  Anthropic's explanation of filesystem and network isolation for safer
  autonomous execution.

## 10. Manage context deliberately

Start a new session when changing to an unrelated task. Long conversations
accumulate failed approaches, irrelevant files, and obsolete assumptions.

General practices:

- One coherent task per session
- Clear context after repeated failed corrections
- Use subagents for large investigations
- Reference authoritative files directly
- Keep command output focused
- Inspect automatic memory periodically
- Remove stale or contradictory instructions

### Interview example

Cherny describes a common failure mode among experienced engineers: they tell
Claude to reproduce exactly how they would perform a task, including a rigid
sequence of steps. That consumes context and prevents the model from choosing a
better approach. His alternative is to interact with it like a coworker: state
the problem, provide the relevant constraints and verification tools, observe
where it struggles, and correct only the demonstrated gap.

[Watch this section](https://www.youtube.com/watch?v=qyPCVqFUyDo&t=1172s)

### Related Claude documentation

- [Explore the context window](https://code.claude.com/docs/en/context-window) —
  understand what consumes context and what `/compact` replaces with a summary.
- [Project instructions and auto memory](https://code.claude.com/docs/en/memory) —
  inspect, edit, scope, and prune persistent context with `/memory`.

## Recommended operating loop

```text
Define outcome
      ↓
Provide guardrails and verifier
      ↓
Let Claude explore and plan
      ↓
Implement autonomously
      ↓
Run tests and inspect outputs
      ↓
Review the diff
      ↓
Record only repeated lessons
      ↓
Periodically remove obsolete scaffolding
```

The broader lesson from the
[full interview](https://www.youtube.com/watch?v=qyPCVqFUyDo) is that Claude
Code configuration should be treated as an empirical, evolving system—not a
permanent collection of prompt-engineering rules.
