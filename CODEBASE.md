# Christopher v3 — Codebase Reference

> **11,330 lines** | React 18 + Express + Socket.IO + Supabase PostgreSQL
> **Last updated:** 2026-04-09

---

## Architecture

```
Christopher v3
├── server/                    Express + Socket.IO backend
│   ├── index.js               Main server, 55 API routes, socket handlers (1696 lines)
│   ├── claude-manager.js      Claude CLI spawner: one-shot + persistent modes, cwd resolution (560 lines)
│   ├── terminal-manager.js    node-pty terminal: PTY spawn, session detect, SessionTailer attach (310 lines)
│   ├── session-tailer.js      Tails Claude's JSONL for clean message capture (replaces terminal scraping) (120 lines)
│   ├── memory-manager.js      Multi-agent memory + local message storage + pagination (427 lines)
│   ├── db.js                  Supabase cloud or embedded PostgreSQL fallback (387 lines)
│   ├── auto-migration-system.js  Schema auto-migration on startup (230 lines)
│   ├── task-routes.js         Task CRUD routes (240 lines)
│   ├── session-reader.js      Reads local Claude CLI .jsonl session files (123 lines)
│   ├── screenshot.js          Multi-monitor screenshot capture (85 lines)
│   ├── tts.js                 Text-to-speech via node-edge-tts (51 lines)
│   └── db-init.js             Standalone DB init script (20 lines)
│
├── src/                       React frontend (Vite)
│   ├── App.jsx                Main app: socket, multi-view layout, overlays, shortcuts (1109 lines)
│   ├── App.css                Top bar, buttons, mode badges, layout grid (282 lines)
│   ├── index.css              Design tokens, CSS variables, animations, a11y (115 lines)
│   ├── main.jsx               React entry (10 lines)
│   └── components/
│       ├── Sidebar.jsx        Chats/Settings tabs, filters, context menu, settings modal (509 lines)
│       ├── Sidebar.css        Sidebar: tabs, filters, convo items, modal, master chat (754 lines)
│       ├── CliPanel.jsx       Chat UI + XtermPanel switch + scroll buttons + pagination (308 lines)
│       ├── CliPanel.css       Chat styling, tool calls, code blocks, scroll btns, load-more (426 lines)
│       ├── XtermPanel.jsx     xterm.js terminal with PTY via Socket.IO + scroll protection (285 lines)
│       ├── XtermPanel.css     Terminal overlay, resume/connect cards (105 lines)
│       ├── SettingsPanel.jsx  Flat nav: agent mode, skills, connectors, tasks, TTS (99 lines)
│       ├── SettingsPanel.css  Nav items, mode toggle, TTS switch (144 lines)
│       ├── SkillsPage.jsx     Dedicated page: list, view, add, delete with confirm (214 lines)
│       ├── ConnectorsPage.jsx Dedicated page: installed + available MCPs (128 lines)
│       ├── SessionBrowser.jsx Session list with filters + replay viewer (290 lines)
│       ├── SessionBrowser.css Session cards, filter pills, replay view (363 lines)
│       ├── ScreenViewer.jsx   Multi-monitor screen streaming (306 lines)
│       ├── ScreenViewer.css   Screen viewer controls (210 lines)
│       ├── VoiceOrb.jsx       Voice input orb with speech recognition (103 lines)
│       ├── VoiceOrb.css       Orb animations, pulse effects (151 lines)
│       ├── TaskModule/
│       │   ├── TaskModule.jsx Task CRUD, filters, detail view, analytics (348 lines)
│       │   └── TaskModule.css Task list, modal, filter styles (173 lines)
│       ├── ChatPanel.jsx      Legacy (unused) (234 lines)
│       ├── ChatPanel.css      Legacy (365 lines)
│       ├── ActivityPanel.jsx  Legacy (52 lines)
│       └── ActivityPanel.css  Legacy (139 lines)
│
├── .env                       PORT, PG_PORT, DATABASE_URL (Supabase)
├── package.json               node-pty, @xterm/*, socket.io, pg, express, react
├── vite.config.js             Vite + React plugin
├── SETUP.md                   Full setup guide
└── CODEBASE.md                This file
```

---

## Conversation Modes

| Mode | Backend | Frontend | How it works |
|------|---------|----------|--------------|
| **terminal-persistent** | `terminal-manager.js` → node-pty → `claude` | `XtermPanel.jsx` (xterm.js) | Full interactive CLI in browser terminal |
| **process-persistent** | `claude-manager.js` → stream-json pipe, stays alive | `CliPanel.jsx` chat UI | Chat UI, process survives between messages |
| **process-oneshot** | `claude-manager.js` → `--print`, dies after response | `CliPanel.jsx` chat UI | Chat UI, new process per message |

Master Chat is always `process-persistent`. Right-click > Settings to change mode per conversation.

### Mode Conversion (terminal ↔ process)

`PUT /api/conversations/:id/mode` switches mode and **kills the old process/PTY**:
- terminal → process: kills the PTY via `terminalManager.destroyTerminal()`
- process → terminal: kills persistent process via `claudeManager.stopConversation()`
- Previously (pre Apr 9) this only updated DB metadata, leaving zombie processes.

### Context Overflow

Each process dispatch (`--print --resume <sessionId>`) is a **separate process spawn**. The Claude CLI reads the session JSONL, auto-compresses older turns if context is too long, then sends the message. No special handling needed — the CLI manages context compression internally on every invocation.

---

## The `.claude` Directory (Global Brain)

Two config files at home directory — don't confuse them:

```
~/
├── .claude.json                       ← MCP server registrations (Claude Code reads MCPs HERE)
└── .claude/                           ← Everything else
```

### Full structure

```
~/.claude/
├── settings.json                      Hooks, cleanup, permissions (NOT for MCPs)
├── settings.local.json                Permission allowlist
├── mode.txt                           Current agent: "coding" or "personal"
├── christopher-config.json            TTS, model, layout prefs (saved by app)
│
├── agents/                            MULTI-AGENT SYSTEM
│   ├── coding/
│   │   ├── IDENTITY.md                Agent identity, role, tone
│   │   ├── AGENTS.md                  Behavior rules, memory standards
│   │   ├── HEARTBEAT.md              Periodic tasks
│   │   ├── memory/                   Datewise memory files
│   │   │   └── YYYY-MM-DD/{slug}.md  Frontmatter: name, type, agent, date, time
│   │   └── messages/                 Chat messages (local JSONL, NOT in Supabase)
│   │       └── {conversation-id}.jsonl
│   └── personal/
│       ├── IDENTITY.md, AGENTS.md
│       ├── memory/
│       └── messages/
│
├── shared/                            Read by BOTH agents
│   ├── SOUL.md                        Core values, red lines
│   ├── USER.md                        Shubham's profile, tech stack
│   └── TOOLS.md                       Machine setup, Chrome config
│
├── skills/                            Shared (both agents)
│   └── ui-ux-pro-max/                Design intelligence skill
│
├── christopher/                       Server data
│   ├── config/                        mcp-config.json
│   └── backups/                       Auto DB backups (embedded mode)
│
├── hooks/                             Session lifecycle
│   ├── session-start.sh              Loads memories, launches Chrome CDP, checks Christopher
│   └── session-stop.sh              Cleanup
│
├── projects/                          Claude CLI session files (.jsonl)
│   └── C--Users-Shubham-Code-/       Sessions by project dir hash
│
├── cache/                             Junction to local SSD (not synced)
├── shell-snapshots/                   Junction to local SSD (not synced)
└── history.jsonl                      Global CLI history
```

### Key rules

| What | Where | Why |
|------|-------|-----|
| MCP registrations | `~/.claude.json` | Claude Code ONLY reads MCPs from here |
| Hooks, cleanup | `~/.claude/settings.json` | NOT for MCPs — #1 setup mistake |
| Memory writes | `agents/{mode}/memory/YYYY-MM-DD/` | Agent-scoped, datewise |
| Memory reads | Both agents + shared | Cross-agent awareness |
| Chat messages | `agents/{agent}/messages/{convo}.jsonl` | Local JSONL, not Supabase |
| Agent lock | Write only to current mode's conversations | Error if wrong mode |
| Config (TTS, model, layout) | `~/.claude/christopher-config.json` | Global, not in codebase |
| Google Drive sync | Entire `~/.claude/` except cache/shell-snapshots | Junctions skip local folders |

### MCP Loading Lifecycle

```
Claude Code starts
  ├── Reads ~/.claude.json for MCP registrations
  ├── Runs session-start.sh hook (launches Chrome if needed)
  ├── Spawns each MCP server process
  ├── Connected → tools available for entire session
  └── Failed → tools GONE, no retry, restart required
```

Hook NEVER kills Chrome. Just launches if CDP not responding on 9222.

---

## Data Storage (Hybrid: Supabase + Local Files)

### Supabase (metadata only — 512MB free tier)

| Table | Purpose |
|-------|---------|
| `conversations` | Chat session metadata (title, status, agent, session_id) |
| `memory_entities` | Memory file index (agent-scoped) |
| `memory_connections` | Entity relationships |
| `tasks` | Shared task board |
| `task_history` | Task change log |
| `task_attachments` | Task files |
| `messages` | Schema exists but **NOT USED** — messages stored locally |

### Local files (synced via Google Drive)

| Path | Purpose |
|------|---------|
| `agents/{agent}/messages/{convo_id}.jsonl` | All chat messages (user + assistant) |
| `agents/{agent}/memory/YYYY-MM-DD/{slug}.md` | Agent memories with frontmatter |

Messages moved to local files to save Supabase storage (~90% reduction).

---

## API Reference (55 endpoints)

### Settings
| Method | Path | Purpose |
|--------|------|---------|
| GET/PUT | `/api/settings/playwright` | Playwright mode |
| GET/PUT | `/api/settings/model` | Default model |
| GET/PUT | `/api/settings/tts` | TTS enabled/disabled |
| GET/PUT | `/api/settings/layout` | Multi-view layout (maxPanes, multiView, paneConvos) |
| GET/PUT/DELETE | `/api/settings/screen-res` | Screen resolution overrides |

### Agent Mode
| GET | `/api/mode` | Current mode |
| POST | `/api/mode` | Switch mode → emits `mode:changed` |

### Conversations
| GET/POST | `/api/conversations` | List/create |
| GET/DELETE | `/api/conversations/:id` | Get/delete |
| PUT | `/api/conversations/:id/title` | Rename |
| PUT | `/api/conversations/:id/mode` | Set mode |
| PUT | `/api/conversations/:id/status` | Set status (kills PTY/process if "completed") |
| POST | `/api/conversations/:id/keep-alive` | Toggle persistent |
| POST | `/api/conversations/:id/dispatch` | Dispatch task to worker (mode-aware: terminal PTY or process, with fallback) |
| PUT | `/api/conversations/:id/session` | Manually set session ID |
| GET | `/api/conversations/:id/session-history` | Session ID change log |
| GET | `/api/conversations/:id/messages` | Get messages — supports `?limit=50&offset=0&maxContentLen=20000` for pagination |
| GET | `/api/conversations/:id/last-messages` | Recent messages (uses paginated reader) |
| POST | `/api/master-chat` | Get/create master chat |

### Memory
| POST | `/api/memory/save` | Save memory (agent-scoped, datewise) |
| GET | `/api/memory/list` | List memories by agent/date |
| GET/POST | `/api/memory/entities` | Entity CRUD |
| POST | `/api/memory/entities/:id/timeline` | Append timeline |
| GET/POST | `/api/memory/daily/:date` | Daily notes |
| GET/POST | `/api/memory/connections` | Entity connections |
| POST | `/api/memory/sync` | Sync files → DB |

### Skills & Connectors
| GET | `/api/skills` | List (with file counts) |
| GET | `/api/skills/:name` | View skill content + file tree |
| POST | `/api/skills/create` | Create skill |
| DELETE | `/api/skills/:name` | Delete skill |
| GET | `/api/connectors` | List installed + available MCPs |
| POST | `/api/connectors/add` | Add MCP to settings.json |
| DELETE | `/api/connectors/:name` | Remove MCP |

### Sessions
| GET | `/api/sessions/local` | List local CLI sessions |
| POST | `/api/sessions/:id/import` | Import to DB |
| GET | `/api/sessions/:id/replay` | Event stream |
| GET | `/api/sessions/:id/summary` | Summary |

### Other
| GET | `/api/health` | Health check |
| GET | `/api/brain/context` | Full agent context |
| GET | `/api/admin/info` | Running conversations (process + terminal + persistent) |
| GET | `/api/queue` | Waiting conversations |

---

## Socket.IO Events

### Client → Server
| Event | Purpose |
|-------|---------|
| `chat:message` | Send message (agent-locked) |
| `chat:stop` | Kill CLI process |
| `pty:create` | Create terminal PTY |
| `pty:input` | Type into terminal (captures user input for message saving) |
| `pty:resize` | Resize terminal |
| `pty:destroy` | Kill terminal |
| `pty:check` | Check if PTY alive |
| `view:conversation` | Set viewed conversation |
| `screen:start/stop` | Screen streaming |

### Server → Client
| Event | Purpose |
|-------|---------|
| `chat:chunk` | Streaming response |
| `chat:complete` | Full response done |
| `chat:error` | Error (including agent-lock violations) |
| `pty:output` | Terminal output |
| `pty:exit` | Terminal exited |
| `pty:ready` | Terminal ready |
| `queue:update` | Status changed |
| `mode:changed` | Agent mode switched |
| `conversation:updated` | Session ID detected (live update) |

---

## Dispatch System (Master → Worker)

**Endpoint:** `POST /api/conversations/:id/dispatch` `{ text, keepAlive? }`

The dispatch endpoint is mode-aware with automatic fallback:

| Target Mode | PTY Live? | What Happens |
|---|---|---|
| `process-*` | n/a | `claudeManager.sendPersistentMessage()` — spawns `claude --print --resume <sessionId>` from resolved cwd |
| `terminal` | yes | Writes `text + \r` directly to PTY (like a human typing) |
| `terminal` | no | Falls back to process dispatch — same `--resume` mechanism works regardless of original mode |

**Architecture:** Master chat (terminal mode, where user sits) dispatches to worker chats. Workers can be any mode — dispatch handles routing. Response comes back via `chat:complete` socket event or is captured by SessionTailer (terminal path).

---

## Frontend Component Tree

```
App.jsx
├── Sidebar.jsx
│   ├── [Chats tab] Filters + Master Chat + New Conversation + conversation list
│   └── [Settings tab] SettingsPanel.jsx (flat nav to overlay pages)
│
├── [Main content — one of:]
│   ├── CliPanel.jsx (process mode — with scroll-to-top/bottom buttons)
│   │   └── XtermPanel.jsx (terminal mode — swapped when mode = terminal)
│   ├── Multi-view grid (2-8 panes, PaneHeader with dropdown, persisted layout)
│   ├── ScreenViewer.jsx
│   ├── TaskModule.jsx
│   ├── SessionBrowser.jsx (with replay viewer)
│   ├── SkillsPage.jsx (dedicated page)
│   ├── ConnectorsPage.jsx (dedicated page)
│   └── Cron Jobs info page
│
└── VoiceOrb.jsx
```

---

## Design System

```css
--bg-primary: #0a0a0f;    --bg-secondary: #0f0f16;    --bg-tertiary: #16161f;
--text-primary: #e8e8ed;   --text-secondary: #9898a8;   --text-muted: #55556a;
--accent: #7c6aef;         --accent-light: #a99bff;     --accent-muted: rgba(124,106,239,0.12);
--success: #22c55e;        --danger: #ef4444;            --warning: #eab308;
--font-sans: 'Inter', 'Helvetica Neue', sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Shift+L** | Toggle multi-view layout |
| **Shift+S** | Toggle sidebar |

---

## Key UI Behaviors

| Action | What happens |
|--------|-------------|
| Click anywhere in multi-view pane | Selects pane as active (purple border + sidebar highlight) |
| Double-click pane name / click chevron | Opens conversation switcher dropdown (dark themed) |
| Right-click conversation | Context menu: Rename, Settings (modal), View Messages (terminal), Delete |
| Settings modal | Model, Mode, Status — pill button selectors |
| Set status "Completed" | Kills terminal PTY + process CLI |
| Master Chat gold pulse | Master is running (in_progress or active session) |
| Sidebar Chats tab | Conversation list with All/Coding/Personal/Computer filters |
| Sidebar Settings tab | Flat nav → Skills/Connectors/Tasks/Sessions/CronJobs open as overlays |
| Scroll buttons in chat | Down arrow when scrolled up, up arrow when at bottom |
| Layout persists on reload | maxPanes, multiView, paneConvos saved to christopher-config.json |

---

## Terminal Session Detection

When a terminal PTY starts:
1. Claude CLI creates a `.jsonl` session file in `~/.claude/projects/{hash}/`
2. After ~8s, `detectSessionId()` scans all project dirs for newest `.jsonl` after spawn time
3. UUID saved to `conversations.claude_session_id` in DB
4. Frontend gets `conversation:updated` socket event — sidebar shows session ID instantly
5. Next reconnect passes `--resume {sessionId}` to restore the session

### Message Capture — SessionTailer (Apr 9)

`session-tailer.js` tails Claude's authoritative JSONL (`~/.claude/projects/{hash}/{sessionId}.jsonl`) via `fs.watchFile`. This replaced the old approach of scraping terminal output (which produced garbled messages with ANSI remnants, spinner chars, TUI noise).

- Extracts only `end_turn` assistant text blocks and user messages
- Attaches via `terminalManager.attachSessionTailer(convId, sessionId, callback)`
- Clean messages saved to local JSONL via `memoryManager.appendMessage()`

### Cross-Directory Session Resume (Apr 9)

`claude --resume <sessionId>` only works from the **same cwd** as the original session. Claude hashes the cwd into the project directory path (`~/.claude/projects/{hash}/`). Sessions created from `I:\My Drive\Services\Liaisoning` live under `I--My-Drive-Services-Liaisoning/`, not the default `C--Users-Shubham-Code-/`.

Both managers resolve cwd automatically:
- `ClaudeManager._resolveSessionCwd(sessionId)` — scans all `~/.claude/projects/*/` for the JSONL, reads the `cwd` field from the first event
- `TerminalManager` uses shared `findSessionCwd()` in the same way
- Falls back to `agentConfig.workingDirectory` or `C:/Users/Shubham(Code)` if not found

### Session ID Protection (Apr 9)

On dispatch, if `--resume` fails and Claude creates a new (empty) session, the **original session ID is preserved** in the DB. Only updated if the returned session ID matches the original (confirmed successful resume) or if there was no prior session ID.

---

## Message Pagination

Large conversations (e.g. long terminal sessions) can accumulate 60MB+ of JSONL messages. Loading all messages at once freezes the browser.

### How it works

1. **Frontend** requests `GET /api/conversations/:id/messages?limit=50&offset=0&maxContentLen=20000`
2. **Server** (`memory-manager.js → getMessagesPaginated`):
   - For files >5MB: tail-reads only the last 20% of the file (avoids loading full 61MB)
   - Counts total lines via fast byte scan (no JSON parsing)
   - Parses only the requested page of messages
   - Truncates message content to `maxContentLen` chars (keeps last N chars, sets `truncated: true`)
3. Returns `{ messages: [...], total: 652, hasMore: true }`
4. **Frontend** shows "Load earlier messages (50 of 652)" button at top of chat
5. Clicking loads the next page (`offset=50`) and prepends to the event list

### Without pagination (backward compatible)

`GET /api/conversations/:id/messages` (no `limit` param) returns the full array as before.

---

## XtermPanel Scroll Protection

xterm.js viewport can jump to the top when the browser window loses focus (caused by `fit.fit()` recalculations or `_innerRefresh` resets).

### How it works (`XtermPanel.jsx`)

1. **Position tracking**: Scroll listener on `.xterm-viewport` tracks `isAtBottom` (gap < 10px)
2. **Focus save/restore**: `window.blur` saves scroll position + at-bottom state; `window.focus` restores (scroll-to-bottom if was following output, exact position otherwise) and re-fits terminal
3. **Hidden guard**: `ResizeObserver` skips `fit.fit()` when `document.hidden` is true
4. **Zero-jump guard**: Any scroll from non-zero to 0 while not at bottom is caught and reverted
5. **Alt-screen stripping**: `pty:output` handler strips `\x1b[?1049h/l` and `\x1b[?47h/l` to prevent viewport reset from alternate screen buffer switches

---

## System Prompt Injection

`getChristopherConfig()` builds the prompt with:
1. Agent identity (IDENTITY.md) + behavior rules (AGENTS.md)
2. Core values (SOUL.md)
3. Multi-agent memory paths (write to current, read from both)
4. All Christopher REST API endpoints
5. Chrome safety: NEVER kill chrome.exe, NEVER launch Chrome
6. Legacy CLI memories
7. Server safety: NEVER kill port 3000

---

## Dependencies

```json
{
  "@xterm/addon-fit": "^0.10.0",    "@xterm/addon-web-links": "^0.11.0",
  "@xterm/xterm": "^5.5.0",          "node-pty": "^1.0.0",
  "express": "^4.21.0",              "socket.io": "^4.7.5",
  "pg": "^8.12.0",                   "embedded-postgres": "^18.3.0-beta.16",
  "react": "^18.3.1",                "react-dom": "^18.3.1",
  "dotenv": "^16.4.5",               "node-edge-tts": "^1.2.10",
  "screenshot-desktop": "^1.15.0",   "uuid": "^10.0.0"
}
```

---

## Running

```bash
cd "C:/Users/Shubham(Code)/Desktop/Github/26.Claude Manager"
npm install
npx vite build          # Build frontend → dist/
npm start               # Starts server on :3000, serves dist/
```

`DATABASE_URL` in `.env` → Supabase. If not set → embedded PostgreSQL fallback.
