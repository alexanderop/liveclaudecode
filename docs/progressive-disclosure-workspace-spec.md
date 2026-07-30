# Progressive Disclosure Workspace

## Product and UX specification

**Status:** Revised proposal after product, frontend, and accessibility review  
**Product:** liveclaudecode  
**Audience:** Product, design, frontend engineering, accessibility, and QA  
**Scope:** Information architecture and interaction redesign of the session dashboard  

## 1. Summary

The current dashboard exposes the session summary, execution canvas, canvas
controls, navigation, and supporting views at the same time. This makes the
product powerful, but the first view is visually dense and asks users to
understand the interface before they have chosen what to investigate.

The redesigned workspace uses progressive disclosure:

- The first selected-session view is a calm **Overview**.
- A compact **Open view** launcher gives experienced users fast navigation.
- The launcher can expand into a full, centered view browser for discovery.
- Only one primary workspace is visible at a time.
- Details about a selected agent or item appear in one contextual side panel.
- Ask is a contextual tool and does not replace the primary workspace.
- Technical metadata remains available through disclosures.

No existing capability is removed. The redesign changes when and where each
capability appears.

## 2. Problem statement

The current interface does not clearly separate six user intents:

1. Understand the current state of a session.
2. Explore the run and subagent hierarchy.
3. Read chronological activity.
4. Review changed work and command outcomes.
5. Investigate warnings and failures.
6. Ask a follow-up question about the session.

Presenting these capabilities simultaneously creates visual competition and
makes the canvas feel mandatory even when the user only wants a summary.

## 3. Product goals

1. Make the initial selected-session view understandable without instruction.
2. Answer three observer questions without requiring navigation:
   - Is the session running or finished?
   - What is it doing, or what did it conclude?
   - Are there warnings or errors that need review?
3. Let users deliberately open the workspace they need.
4. Preserve fast keyboard and cross-session comparison workflows.
5. Preserve all current run, activity, change, diagnostic, and Ask capabilities.
6. Use one interaction model across desktop and mobile.
7. Meet WCAG 2.1 AA keyboard, focus, reflow, and status-message requirements.

## 4. Non-goals

- Changing transcript parsing, polling, schemas, or server APIs.
- Adding telemetry or a runtime network dependency.
- Turning the observer into an editor or command runner.
- Displaying multiple primary workspaces simultaneously.
- Copying Codex visual styling exactly.
- Hiding provider health, failures, or incomplete data.

## 5. Design principles

### Calm by default

Show the minimum information needed to understand the selected session.
Additional agents, metrics, metadata, and technical detail remain disclosed.

### Intent before interface

The user chooses whether to monitor, explore, review, diagnose, or ask. The
application then gives that activity the available workspace.

### Attention may interrupt calm

Failures, warnings, degraded sources, and meaningful state transitions may be
prominent. Decorative metrics and informational diagnostics may not.

### Stable spatial meaning

- Left: choose a project or session.
- Center: use the selected primary workspace.
- Right: inspect the selected item or use Ask.
- Compact launcher: temporarily overlays workspace chrome.
- Expanded launcher: temporarily replaces the center workspace.

### No lost capability

Every action removed from permanent navigation remains available from the
launcher, a contextual action, global search, or an accessible shortcut.

## 6. Core identity model

The implementation must not treat the selected session, followed run, and
inspected item as the same identity.

~~~text
SelectedSession = project ID + root session key
FocusedRunKey   = root or subagent currently followed in the selected session
SelectedItem    = agent, event, file, or incident currently being inspected
~~~

Rules:

- Workspace and Ask state are owned by SelectedSession.
- Follow active may update FocusedRunKey without causing a session switch.
- Selecting an agent changes SelectedItem, not SelectedSession.
- A session switch occurs only when the project ID or root session key changes.
- A selected item must be validated against the selected session after refresh.
- If a linked or selected item no longer exists, clear it and retain the current
  primary workspace.

## 7. Layout regions

The dashboard has four layout regions. The header and session browser are
persistent; the primary workspace is required after session selection; the
context panel is conditional.

~~~text
+------------------+----------------------------------------------------------+
|                  | GLOBAL HEADER                                            |
|                  +---------------------------------------+------------------+
| SESSION          |                                       |                  |
| BROWSER          | PRIMARY WORKSPACE                     | CONTEXT PANEL    |
|                  |                                       | optional         |
| projects         | Overview / Agent map / Activity /     | Agent details    |
| sessions         | Changes / Diagnostics                 | or Ask           |
| filters          |                                       |                  |
|                  +---------------------------------------+------------------+
|                  | OPEN VIEW CONTROL                                         |
+------------------+----------------------------------------------------------+
~~~

Spatial rules:

- Only one primary workspace is rendered as active.
- At most one context panel is visible.
- A compact launcher may appear above either region.
- An expanded launcher replaces the primary workspace and temporarily hides the
  context panel without discarding eligible state.

## 8. Destinations

### 8.1 Primary workspaces

| Workspace | User question | Presentation |
| --- | --- | --- |
| **Overview** | What is happening, and should I review anything? | Calm default workspace |
| **Agent map** | How did the session and subagents execute? | Full available primary width |
| **Activity** | What happened in chronological order? | Full available primary width |
| **Changes** | What file changes and command outcomes were recorded? | Full available primary width |
| **Diagnostics** | What failed, degraded, or may affect the result? | Full available primary width |

### 8.2 Contextual destination

**Ask** is listed in the launcher but is not a primary workspace.

- Desktop: Ask opens in the context panel and leaves the primary workspace
  unchanged.
- Mobile: Ask opens as a full-screen modal sheet. Closing it returns to the
  unchanged primary workspace.
- Opening Ask replaces Agent details in the context region.
- Ask conversation state is owned per selected session.

### 8.3 Consolidation of existing views

The existing Now and Guide concepts become one adaptive Overview:

- Running sessions prioritize the current action.
- Completed sessions prioritize the final result.
- Narrative and phase information remains available under Run details.

## 9. Default desktop experience

### 9.1 Running session

~~~text
+----------------------+-------------------------------------------------------+
| Live Claude Code  [<]| Claude > my-project > Fix scrolling         [Running] |
+----------------------+-------------------------------------------------------+
| Search sessions...   |                                                       |
|                      |                    3 agents active                     |
| MY PROJECT           |                                                       |
|  * Fix scrolling     |       Explorer is reading RunCanvas.client.vue       |
|    Refactor layout   |                    [2 more active]                    |
|    Inspect Nuxt UI   |                                                       |
|                      |                  No warnings or errors                 |
| OTHER PROJECT        |                                                       |
|    Previous session  |          [View live agents]  [Read activity]          |
|                      |                                                       |
|                      |                                                       |
|                      | [Open view]                                           |
+----------------------+-------------------------------------------------------+
~~~

Default limits:

- One primary heading.
- One current-action row.
- One collapsed disclosure for additional active agents.
- One attention message, only when warnings or errors exist.
- At most two primary actions.
- One collapsed Run details disclosure.
- No KPI card grid.

The phrase No warnings or errors is used only when loaded diagnostic data
supports that claim. It is omitted when diagnostics are incomplete or unknown.

### 9.2 Completed session

~~~text
+----------------------+-------------------------------------------------------+
| Live Claude Code  [<]| Codex > my-project > Simplify UI          [Complete]  |
+----------------------+-------------------------------------------------------+
| Sessions             |                                                       |
|                      |                  Session completed                     |
|  Selected session    |                                                       |
|                      |  "Implemented responsive panel behavior and added..." |
|                      |                                                       |
|                      |  One recovered tool failure may affect the result     |
|                      |                                                       |
|                      |              [Review changes]  [Ask about run]         |
|                      |                                                       |
|                      |                    [Run details]                       |
|                      |                                                       |
|                      | [Open view]                                           |
+----------------------+-------------------------------------------------------+
~~~

The result excerpt is short and does not become a transcript preview. Metrics,
the full narrative, and technical metadata remain under Run details.

### 9.3 Empty library

The current client automatically selects the first available session. Therefore
the no-selection design is an empty-library state, not a normal landing state.

~~~text
+----------------------+-------------------------------------------------------+
| Live Claude Code  [<]| Local sessions                                        |
+----------------------+-------------------------------------------------------+
| Search sessions...   |                                                       |
|                      |                 No local sessions found                |
|                      |                                                       |
|                      |       Start a supported coding-agent session or       |
|                      |       adjust the project and recency filters.         |
|                      |                                                       |
+----------------------+-------------------------------------------------------+
~~~

During initial loading, show shell-aligned skeletons rather than this empty
state.

## 10. Session display states

Overview, sidebar status, launcher badges, and status announcements use one
shared state model.

| State | Overview headline | Treatment | Attention badge |
| --- | --- | --- | --- |
| Running | Session running | Live indicator; neutral/accent content | No |
| Waiting | Session waiting | Neutral; explain recorded wait when known | No |
| Completed | Session completed | Neutral completion | No |
| Completed with warnings | Completed with warnings | Amber | Yes |
| Failed | Session failed | Red; show failure summary | Yes |
| Stopped | Session stopped | Neutral or amber based on recorded outcome | Only if result may be incomplete |
| Inactive | No recorded activity | Neutral; do not imply success | No |
| Incomplete source | Session data may be incomplete | Amber source warning | Yes |

Precedence:

1. A recorded failure remains Failed even when the source is degraded.
2. Source degradation adds an incomplete-data warning; it does not replace the
   recorded run outcome.
3. Warning and error diagnostics contribute to attention counts.
4. Informational diagnostics never contribute to launcher or Overview badges.
5. Unknown outcome is never displayed as success.

Live stability:

- Text may update in place on each polling result.
- Overview does not reorder content more than once per polling cycle.
- Updates never steal focus.
- Transcript events are not individually announced.
- The Open view control never moves because of a live update.

## 11. Open view launcher

The launcher has closed, compact, and expanded states.

### 11.1 Persistent control

The trigger uses a panels/grid icon and the label **Open view**. A plus icon is
not used because this read-only application is not creating a new object.

Placement:

- Desktop: sticky workspace-chrome control inset 16 px from the lower-left of
  the primary-workspace viewport.
- Scrollable workspaces reserve the trigger height plus 16 px of bottom padding.
- Agent map: the trigger belongs to the canvas toolbar rather than floating over
  graph nodes.
- Mobile: the trigger appears in the bottom app bar.
- Below 680 px, the visible label may collapse, but the accessible name remains
  Open a session view.

### 11.2 Compact launcher

The compact launcher is for fast navigation.

~~~text
                    +--------------------------------+
                    | Overview                    N  |
                    | Agent map                   M  |
                    | Activity                    A  |
                    | Changes                     D  |
                    | Diagnostics              1  I  |
                    | Ask                         Q  |
                    +--------------------------------+
                    | Expand launcher             [ ]|
                    +--------------------------------+
~~~

Content rules:

- Each row contains icon, name, and launcher-scoped mnemonic.
- Only warning/error counts may appear as metadata.
- Purpose descriptions and live metrics do not appear in compact mode.
- The current primary workspace uses aria-current="page".
- Ask uses a visible active-conversation indicator when relevant.

ARIA and keyboard pattern:

- Trigger is a button with aria-haspopup="menu", aria-expanded, and
  aria-controls.
- The popup is a named menu using roving tabindex.
- Destinations and Expand launcher use role="menuitem".
- Up/Down and Home/End move focus.
- Enter or Space selects.
- Escape closes the menu and restores focus to Open view.
- Optional typeahead may match destination names.
- Opening compact mode focuses the current destination, otherwise Overview.
- Mnemonics N, M, A, D, I, and Q work only while focus is inside the launcher.

### 11.3 Expanded launcher

Expanded mode is for discoverability. It temporarily replaces the primary
workspace in the DOM. It is not a modal, does not trap focus, and leaves the
header and session browser operable.

~~~text
+----------------------+-------------------------------------------------------+
| Sessions             | my-project > Fix scrolling                 [Running] |
+----------------------+-------------------------------------------------------+
|                      |                                      [Back to view]   |
|                      |                                                       |
|                      |                 Open a session view                   |
|                      |            Choose what you want to inspect            |
|                      |                                                       |
|                      |  +-------------------------------------------------+  |
|                      |  | Overview                                    N   |  |
|                      |  | Current state, result, and review summary        |  |
|                      |  +-------------------------------------------------+  |
|                      |  | Agent map                                   M   |  |
|                      |  | Explore the session and subagent relationships  |  |
|                      |  +-------------------------------------------------+  |
|                      |  | Activity                                    A   |  |
|                      |  | Read prompts, tools, and results in order       |  |
|                      |  +-------------------------------------------------+  |
|                      |  | Changes                                     D   |  |
|                      |  | Review file changes and command outcomes       |  |
|                      |  +-------------------------------------------------+  |
|                      |  | Diagnostics                    1 warning    I   |  |
|                      |  | Investigate data that may affect the result    |  |
|                      |  +-------------------------------------------------+  |
|                      |  | Ask                                         Q   |  |
|                      |  | Ask a read-only local agent about the session  |  |
|                      |  +-------------------------------------------------+  |
|                      |                                                       |
+----------------------+-------------------------------------------------------+
~~~

Content rules:

- Each row contains an icon, name, stable one-sentence purpose, and mnemonic.
- Only warning/error attention counts are dynamic.
- General live metrics are excluded so this does not become a second dashboard.
- Expanded mode is a nav region labelled by the visible heading.
- Rows use normal document Tab order, not menu semantics.

Transitions:

- Compact to expanded focuses the corresponding expanded destination row.
- Back or Escape restores the previous primary workspace and focuses Open view.
- Selecting a primary destination opens it and focuses its heading.
- Selecting Ask restores the previous primary workspace and opens Ask.
- Expanded mode temporarily hides an open context panel.
- Selecting a primary destination closes suspended Agent details.
- Selecting a primary destination restores suspended Ask beside the new
  workspace.
- Cancelling expanded mode restores the previously visible eligible context
  panel.
- A session switch clears all suspended launcher-return state.

### 11.4 Layer and Escape contract

One Escape press closes exactly one layer.

Priority:

1. Nested select, menu, tooltip with interaction, or popover.
2. Compact launcher.
3. Mobile modal context sheet, Ask sheet, or session-browser sheet.
4. Expanded launcher.
5. Docked context panel.
6. No action.

Implementation guardrails:

- Nested components consume the event they handle.
- The app-level handler ignores defaultPrevented and composing events.
- The app-level handler consults one centralized layer stack.
- Escape never closes both a nested control and its parent layer.

## 12. Overview specification

Overview is the only workspace that opens automatically.

### Running content order

1. One status sentence and active-agent count.
2. The single most important current action.
3. A disclosure such as 2 more active agents when needed.
4. One attention message when a warning or error exists.
5. At most two actions selected from Agent map, Activity, or Diagnostics.
6. One collapsed Run details disclosure.

### Completed content order

1. Completion, warning, stopped, or failure headline.
2. Short final-result or failure excerpt.
3. One attention message when applicable.
4. At most two actions selected from Changes, Activity, Diagnostics, or Ask.
5. One collapsed Run details disclosure.

### Run details disclosure

Run details contains:

- agent totals and state breakdown;
- tool-call and file-change counts;
- elapsed time;
- session narrative and phases;
- session ID;
- provider and model;
- token and cache usage;
- transcript JSONL path and Copy action;
- first and last timestamps; and
- provider-specific technical metadata.

### Calmness constraints

Before opening Run details, Overview contains no:

- execution graph;
- event feed;
- KPI card grid;
- transcript path;
- token count;
- provider-specific metadata; or
- more than two primary actions.

At 1280 by 720 and 390 by 844, a first-time user can identify the state,
latest meaningful action or result, and warning/error state without scrolling.

## 13. Agent map

The existing execution canvas becomes an explicitly opened primary workspace.

~~~text
+------------------------------------------------------------------------------+
| Agent map                                      [Search] [Display] [Fit view]  |
+------------------------------------------------------------------------------+
|                                                                              |
|                     +-----------+                                             |
|                     | Main run  |                                             |
|                     +-----+-----+                                             |
|                           |                                                   |
|                  +--------+--------+                                          |
|                  v                 v                                          |
|            +----------+       +----------+                                    |
|            | Explorer |       | Tester   |                                    |
|            +----------+       +----------+                                    |
|                                                                              |
| [Open view]                                                                  |
+------------------------------------------------------------------------------+
~~~

Rules:

- Search and display controls are visually secondary.
- Advanced layout and lens controls are collapsed under Display by default.
- Selecting an agent opens Agent details.
- Closing Agent details preserves graph position, search, lens, replay point,
  collapsed nodes, and selection.
- Map state is stored per selected session.
- Map to Activity to Map restores the previous map state.
- Expanded launcher to Back restores the previous map state.
- Switching away and returning to a session restores that session's in-memory
  map state.
- Do not mount multiple canvases concurrently because the existing Vue Flow
  instance uses a fixed ID.

Implementation must either retain one hidden canvas safely or lift its internal
state into a session-keyed composable. This decision is made before layout work.

## 14. Activity

Activity uses the full available primary width.

Persistent controls:

- agent filter;
- compact, normal, or raw density;
- errors-only toggle; and
- follow-output toggle.

Rules:

- Secondary controls belong under Filters.
- Selecting an event may open Agent details without leaving Activity.
- Density and errors-only are global user preferences.
- Agent filter and scroll position are per selected session.
- A session switch validates or resets the agent filter.
- Activity lists are not live regions.

## 15. Changes

Changes uses the full available primary width so paths, patches, and command
outcomes do not have to fit inside a narrow panel.

Content order:

1. Files changed.
2. Command outcomes.
3. Patch provenance.
4. Git events.

Rules:

- Focused file is per selected session and is validated after refresh.
- On a wide screen, file details may open in the context region only if neither
  Ask nor Agent details is active.
- On narrow screens, file details replace the list and provide a visible Back
  action.
- Intrinsically wide patches may scroll horizontally inside their own region;
  primary navigation and page chrome may not.

## 16. Diagnostics

Diagnostics distinguishes:

- **Error:** the session or agent did not produce a usable result.
- **Warning:** the run recovered, but the incident may affect the result.
- **Information:** context pressure, compaction, or timing information.

Rules:

- Opening from an Overview attention message focuses that incident.
- Opening from the launcher shows the full session diagnostic summary.
- No incidents communicates No recorded warnings or errors.
- Informational diagnostics remain available but do not produce badges.
- Focused incident is per selected session and is validated after refresh.

## 17. Context panel

The context panel shows information about a selected item or Ask. It does not
provide primary navigation.

~~~text
+-----------------------------------------------+------------------------------+
| PRIMARY WORKSPACE                             | Agent details             [x]|
|                                               +------------------------------+
|                                               | Summary                      |
|                                               | Activity                     |
|                                               | Incidents                    |
|                                               | Files                        |
|                                               | Result                       |
|                                               |                              |
| [Open view]                                   |                              |
+-----------------------------------------------+------------------------------+
~~~

Geometry:

- Preferred width is the saved user width.
- Effective width is min(saved width, 40vw, 720 px).
- Dock only when at least 640 px remains for the primary workspace.
- Otherwise use a modal slideover.
- Minimum docked width is 280 px.

Agent-details transitions:

- Selecting an agent opens Agent details and focuses its heading or close button.
- Selecting a different agent updates the open panel without stealing focus.
- Explicit close restores focus to the invoking agent or event control.
- If that trigger no longer exists, focus the primary workspace heading.
- Selecting a launcher destination closes Agent details.
- Choosing View activity, View changes, or View in map inside Agent details
  changes workspace and preserves the same agent when the destination supports
  agent context.
- A session switch closes Agent details and focuses the new workspace heading.

Ask persistence:

- History, draft, selected answering agent, status, and scroll position persist
  per selected session while Ask is hidden.
- Hidden Ask instances do not continue 800 ms client polling.
- Reopening Ask refreshes server history before resuming polling.
- Switching sessions hides Ask visually and restores that session's Ask state
  when explicitly reopened.
- Opening Ask replaces Agent details.
- Ask state requires a keyed per-session store or a controlled KeepAlive
  strategy; relying on the current conditional mount is insufficient.

## 18. Global header and search

~~~text
[Sidebar] Provider > Project > Session title       [Status] [Search] [More]
~~~

Always visible:

- sidebar toggle;
- provider/project/session breadcrumb;
- concise session state;
- global search.

Contextual controls:

- Follow active appears only in Overview, Agent map, and Activity.
- Canvas search appears only in Agent map.
- Event density appears only in Activity.
- Transcript path appears only in Run details.
- Color mode may move into More when space is constrained.

Search responsibilities:

- Sidebar search filters visible projects and sessions.
- Command/Ctrl + K searches all sessions and available commands/views.
- Open view switches destinations for the selected session only.
- Agent map and Activity retain workspace-specific search and filters.

The large permanent session hero is removed. Its session-state content moves
into Overview; its technical content moves into Run details.

## 19. Session switching, URLs, and restoration

### Initial behavior

- On initial load, automatic selection, or a session URL without an explicit
  workspace, open Overview.
- A reload resets to Overview unless the workspace is encoded in the URL.
- Temporary launcher and context state never survives reload.

### Manual session switching

- Overview remains Overview.
- After the user explicitly opens Agent map, Activity, Changes, or Diagnostics,
  manual session switching preserves that workspace for the browser session.
- Agent details closes.
- Ask hides, but its per-session state remains stored.
- Compact and expanded launcher states close.
- Focus moves to the new primary workspace heading.

### URL and browser history

MVP URL state includes:

- project and root session identity;
- primary workspace;
- optional focused file or incident when directly addressable.

MVP URL state excludes:

- compact or expanded launcher state;
- context-panel open state;
- drafts, filters, graph viewport, and scroll position.

Browser Back restores the previous URL-addressable session/workspace. If the
session, agent, file, or incident no longer exists, retain the closest valid
session/workspace, clear the invalid item, and show a non-blocking explanation.

### State scope

| State | Scope |
| --- | --- |
| Density, errors-only | Global user preference |
| Selected primary workspace | Browser-session preference and URL |
| Map viewport, lens, search, replay, collapsed nodes | Per session, in memory |
| Activity agent filter and scroll | Per session, in memory |
| Focused file or incident | Per session, optionally URL-addressable |
| Ask history, draft, agent, status, scroll | Per session |
| Launcher open state and focus trigger | Temporary |
| Agent details | Temporary and session-owned |

## 20. Responsive behavior

### Desktop and medium screens

- Dock the context panel only when 640 px remains for primary content.
- Otherwise use a modal right slideover.
- Expanded launcher remains a center workspace replacement.

### Mobile: 680 px and below

~~~text
+--------------------------------+
| [Sessions] Session       [Live] |
+--------------------------------+
|                                |
|        2 agents active         |
|                                |
| Explorer is reading            |
| session-state.ts               |
|                                |
|       [View agents]            |
|                                |
|                         [Open] |
+--------------------------------+
~~~

Modal layers:

- Compact launcher bottom sheet, session browser, Agent details, file details,
  and Ask use a named dialog or equivalent component with aria-modal="true".
- Background content becomes inert.
- Tab and Shift+Tab remain inside the active modal sheet.
- Opening sets initial focus according to the focus contract.
- Closing restores the persistent trigger or a documented fallback.
- Body scrolling is locked while a modal sheet is open.

Expanded launcher:

- Replaces the mobile primary workspace rather than overlaying it.
- Uses no dialog role, aria-modal, background inertness, or focus trap.
- Header and session navigation remain operable.
- Browser Back and the visible Back action restore the previous workspace.

Shortcut labels hide only because of available space, never because the device
is assumed to be touch-first.

## 21. Keyboard and focus contract

### Global shortcuts

| Key | Behavior |
| --- | --- |
| Command/Ctrl + B | Toggle session browser |
| Command/Ctrl + K | Open global session/command search |
| Escape | Close exactly one topmost temporary layer |

Global single-character destination shortcuts are not provided.

Shortcut handlers:

- ignore defaultPrevented events;
- ignore composing events;
- do not fire from input, textarea, select, contenteditable descendants, or
  modal/menu interactions that own the event;
- expose active chords through aria-keyshortcuts.

### Launcher-scoped mnemonics

N, M, A, D, I, and Q work only while focus is within the compact or expanded
launcher. They are navigation mnemonics, not global shortcuts.

### Focus transitions

| Transition | Focus destination |
| --- | --- |
| Open compact launcher | Current destination, otherwise Overview |
| Compact to expanded | Corresponding expanded destination row |
| Select primary destination | New workspace heading with tabindex="-1" |
| Select Ask | Ask heading or close control |
| Close compact or expanded launcher | Persistent Open view control |
| Open Agent details | Panel heading or close control |
| Update already-open Agent details | Do not move focus |
| Explicitly close Agent details | Invoking control; otherwise workspace heading |
| Session change | Newly selected session or new workspace heading |
| Close mobile sheet | Persistent trigger; otherwise workspace heading |

View changes are conveyed by moving focus to the new heading, not by live-region
announcement.

## 22. Visual design direction

### Density

- One dominant content area per screen.
- One-line state summaries instead of KPI grids.
- Whitespace separates decisions.
- Overview has one primary heading and one live-action row by default.

### Surfaces

- Primary workspace uses the application background.
- Launcher rows use a subtle raised surface and clear hover/focus state.
- Selection uses a restrained accent.
- Context panel uses one distinct surface and separating border.

### Color

- Accent indicates selection and navigation.
- Green/live indicates recorded active work.
- Red is reserved for recorded failure.
- Amber indicates warnings or incomplete source data.
- Neutral represents completion and informational metadata.
- Color never carries meaning without text or icon support.

### Motion

- Compact launcher: short fade and restrained scale.
- Expanded launcher: short workspace cross-fade.
- Context panel: short horizontal transition.
- Under prefers-reduced-motion: reduce, remove launcher scaling, panel sliding,
  cross-fades, smooth scrolling, graph auto-pan/zoom animation, and pulsing or
  spinning indicators.
- Static icons and text continue to communicate state.

## 23. Accessibility requirements

- Compact launcher implements the menu pattern defined in this specification.
- Expanded launcher is a labelled nav region with normal Tab order.
- Icon-only controls have accessible names; tooltips are supplementary.
- Status is never communicated by color alone.
- Touch targets are at least 44 by 44 px on small screens.
- Focus indicators remain visible against every surface.
- The layout supports 400% zoom on a 1280 CSS-pixel-wide viewport, equivalent
  to 320 CSS px, without loss of content or page-level two-dimensional scrolling.
- Agent map panning and intrinsically wide patches/tables are scoped essential
  content exceptions; their surrounding controls and navigation still reflow.

Status announcements:

- Use one persistent role="status", aria-live="polite",
  aria-atomic="true" region.
- Announce only session completed/failed, viewer disconnected/reconnected,
  source degraded/recovered, and warning/error count increases.
- Do not make Overview, Activity, event lists, or the whole Ask log live regions.
- Announce an Ask response once when complete or in deliberately throttled
  sentence-level updates.
- Use role="alert" only for urgent failures requiring immediate review.

## 24. Loading, empty, disconnected, and degraded states

### Loading

- Preserve shell and selected-session context.
- Show restrained workspace-aligned skeletons.
- Do not show zero values before data is loaded.

### Missing provider data

- Explain what was not recorded.
- Do not imply success when outcome is unknown.
- Offer a relevant next destination when useful.

~~~text
No file changes were recorded for this session.
[Read activity]
~~~

### Viewer disconnected

- Keep the last successfully loaded state visible.
- Show one persistent non-blocking header indicator.
- Do not replace the workspace with a connection error.
- Announce disconnect and reconnect once.

### Source degraded

- Show provider health in the session browser.
- Show a concise incomplete-data warning in Overview for an affected session.
- Preserve any separately recorded failure state.

## 25. Required user journeys

Implementation and QA must cover:

1. Running session becomes completed while Overview is open.
2. Session fails or stops without a final response.
3. Source becomes degraded while a workspace is open.
4. User opens an Overview incident, reviews it, and returns.
5. User opens Agent details, navigates to that agent in Activity, and returns.
6. Map to Activity to Map preserves the graph state.
7. Expanded launcher to Back preserves workspace and eligible context state.
8. Ask is generating while the user changes workspace.
9. User changes sessions and later reopens each session's Ask state.
10. Direct URL points to a deleted session, file, or incident.
11. Expanded launcher is opened on mobile and browser Back is used.
12. Session has no agents, files, final text, or diagnostics.
13. Project and session labels are exceptionally long.
14. Escape is pressed while a nested select is open inside a context sheet.

## 26. Acceptance criteria

### Calm default

- Initial or automatic session selection opens Overview.
- Overview shows no more than one primary heading, one current-action row, one
  attention message, two primary actions, and one collapsed details disclosure.
- No graph, event feed, KPI grid, transcript path, token count, or provider
  metadata appears before disclosure.
- State, latest meaningful action/result, and warning/error state are visible
  without scrolling at 1280 by 720 and 390 by 844.
- Live updates do not move Open view or steal focus.

### Launcher

- Open view is reachable by pointer, keyboard, and touch.
- Compact mode lists five primary destinations and Ask.
- Compact mode expands into the full launcher.
- Expanded mode preserves selected session and previous workspace.
- Selecting Ask leaves the primary workspace unchanged.
- Current view and warning/error counts are communicated accessibly.
- Destination letters do not work globally.

### Workspaces and context

- Only one primary workspace is active.
- Agent map, Activity, Changes, and Diagnostics use the full available primary
  width.
- Selecting an agent opens one context panel.
- Ask and Agent details never compete for the same context region.
- Closing context preserves eligible primary-workspace state.
- Map state survives workspace and launcher round trips.
- Ask history, draft, selected agent, and scroll persist per session while hidden.

### Responsive and accessibility

- Modal sheets make background content inert and contain forward/reverse Tab.
- Expanded launcher uses workspace rather than modal semantics.
- One Escape closes exactly one layer.
- Focus lands at the destination defined by the focus table.
- No shortcut fires from editable, contenteditable, composition, or already
  handled events.
- The shell and controls reflow at 400% without page-level horizontal scrolling.
- Reduced-motion mode removes CSS and JavaScript-driven motion.
- Automated accessibility checks report no detectable violations.
- Browser tests cover focus, modal containment, Escape ordering, reflow, and
  reduced motion; automated scanning alone is not sufficient.

## 27. Implementation state model

Suggested client model:

~~~ts
type SelectedSession = {
  projectId: string
  rootKey: string
}

type PrimaryWorkspace =
  | { kind: "overview" }
  | { kind: "map" }
  | { kind: "activity" }
  | { kind: "changes"; focusedFile?: string }
  | { kind: "diagnostics"; focusedIncidentId?: string }

type ContextPanel =
  | { kind: "closed" }
  | { kind: "agent-details"; agentKey: string; origin: PrimaryWorkspace["kind"] }
  | { kind: "ask"; sessionId: string }

type LauncherState =
  | { kind: "closed" }
  | { kind: "compact"; returnFocusId: string }
  | {
      kind: "expanded"
      previousWorkspace: PrimaryWorkspace
      suspendedContext: ContextPanel
    }
~~~

Transient event focus is grouped rather than held as unrelated refs:

~~~ts
type InvestigationFocus = {
  agentKey?: string
  eventLine?: number
  timestamp?: number
  filePath?: string
  incidentId?: string
}
~~~

State transitions are implemented as named functions or a reducer and tested
without depending on rendered layout.

## 28. Implementation sequence

### Phase 1: Identity, state, and transition tests

- Separate SelectedSession, FocusedRunKey, and SelectedItem.
- Introduce payload-bearing workspace, context, launcher, and investigation
  state.
- Centralize layer and Escape handling.
- Define state scope and URL synchronization.
- Add transition tests before changing layout.

### Phase 2: Primary workspace shell

- Introduce the one-workspace shell.
- Promote Agent map, Activity, Changes, and Diagnostics while retaining existing
  navigation temporarily.
- Decide and implement session-keyed map-state preservation.
- Rename the current RunOverview component before creating adaptive Overview.

### Phase 3: Calm Overview and reduced header

- Consolidate Now and Guide.
- Implement running, waiting, completed, warning, failed, stopped, inactive, and
  incomplete-source states.
- Move metadata into Run details.
- Enforce the calmness limits in component tests.

### Phase 4: Compact and expanded launcher

- Add compact and expanded presentations.
- Implement menu/nav semantics and deterministic focus restoration.
- Add launcher-scoped mnemonics.
- Remove Activity and More only after every destination is functional.

### Phase 5: Context and Ask persistence

- Apply deterministic Agent-details transitions.
- Move Ask state to a per-session store or controlled KeepAlive design.
- Pause hidden polling and refresh on reopen.

### Phase 6: Responsive and accessibility validation

- Implement modal bottom sheets and slideovers.
- Validate focus, inertness, Escape, browser Back, 400% reflow, reduced motion,
  and status announcements.
- Update Nuxt and production-browser coverage.

Changes in phases 2 through 4 should remain behind one development flag until
all launcher destinations work as specified.

## 29. Likely frontend ownership

The redesign primarily affects:

- app/pages/index.vue — identity, workspace, launcher, context, and URL state;
- app/composables/useLiveRuns.ts — stable root-session versus focused-run state;
- app/components/RunHero.vue — reduced global-header responsibility;
- app/components/RunNowBoard.vue and the existing RunOverview.vue — adaptive
  Overview after a component rename;
- app/components/ResponsiveDashboardPanel.vue — context-only responsive panel;
- app/components/RunCanvas.client.vue and useExecutionCanvas.ts — map-state
  preservation;
- app/components/ChatPanel.vue — controlled per-session Ask state and polling;
- a new Open view launcher component;
- app/assets/main.css — workspace geometry and responsive presentation; and
- Nuxt and browser tests for transitions, focus, reflow, and persistence.

No server or transcript-schema change is expected.

## 30. Product decision record

The approved implementation direction is:

1. Overview replaces the canvas as the initial selected-session view.
2. Now and Guide become one strictly limited adaptive Overview.
3. Open view replaces permanent Activity and More navigation.
4. Compact mode supports speed; expanded mode supports discovery.
5. Expanded mode replaces the center workspace and is not modal.
6. Agent map, Activity, Changes, and Diagnostics are primary workspaces.
7. Ask and Agent details are mutually exclusive contextual panels.
8. Session identity is separate from followed and inspected agents.
9. Explicit workspace choice persists across later manual session switches.
10. Launcher/context state is temporary; URL state covers session and workspace.
11. Launcher letters are scoped mnemonics, never global shortcuts.
12. Implementation begins only after identity and state-transition tests exist.

These decisions deliver a calmer first experience while protecting expert
workflows, read-only behavior, accessibility, and existing data architecture.
