import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { ClaudeManager } from "./claude-manager.js";
import { TerminalManager } from "./terminal-manager.js";
import { SessionReader } from "./session-reader.js";
import { ScreenshotService } from "./screenshot.js";
import { Database } from "./db.js";
import { MemoryManager } from "./memory-manager.js";
import { createTaskRouter } from "./task-routes.js";
import { createCrmProxyRouter } from "./crm-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLAUDE_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude");
const CHRISTOPHER_HOME = path.join(CLAUDE_HOME, "christopher");

dotenv.config({ path: path.join(ROOT, ".env") });
const APP_NAME = process.env.APP_NAME || "AI Assistant";

// Kill any existing process on our app port before starting
function killPort(port) {
  try {
    const result = execSync(
      `netstat -ano | findstr :${port} | findstr LISTENING`,
      { encoding: "utf-8", shell: "cmd.exe", timeout: 5000 }
    );
    const pids = new Set();
    for (const line of result.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== "0" && /^\d+$/.test(pid) && pid !== String(process.pid)) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe", stdio: "ignore", timeout: 5000 });
        console.log(`[Startup] Killed existing process on port ${port} (PID ${pid})`);
      } catch {}
    }
    if (pids.size > 0) {
      execSync("timeout /t 1 /nobreak >nul 2>&1", { shell: "cmd.exe", stdio: "ignore" });
    }
  } catch {}
}

const APP_PORT = parseInt(process.env.PORT || "3000");
killPort(APP_PORT);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 10 * 1024 * 1024,
});

app.use(express.json({ limit: "10mb" }));

// Services
const db = new Database({
  port: parseInt(process.env.PG_PORT || "54329"),
});
await db.initialize();
const screenshotService = new ScreenshotService();
const memoryManager = new MemoryManager(db);
const claudeManager = new ClaudeManager(ROOT, db, memoryManager);
const terminalManager = new TerminalManager(ROOT, db);
const sessionReader = new SessionReader();
app.use("/api/tasks", createTaskRouter(db, io, memoryManager));
app.use("/api/crm", createCrmProxyRouter());

// Christopher config — multi-agent aware
function getChristopherConfig() {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher-config.json");
  let saved = {};
  try { if (fs.existsSync(configPath)) saved = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}

  const mode = memoryManager.getMode();
  const ctx = memoryManager.loadFullContext();
  const cliMemories = memoryManager.loadCliMemories();
  const CLAUDE_HOME_PATH = path.join(process.env.USERPROFILE || process.env.HOME, ".claude").replace(/\\/g, "/");

  return {
    id: "christopher",
    name: `Christopher (${mode})`,
    model: saved.model || "claude-opus-4-6",
    skipPermissions: true,
    workingDirectory: "C:/Users/Shubham(Code)",
    systemPrompt: `You are Christopher, a personal AI system for Shubham Bhole. You are currently in **${mode.toUpperCase()}** mode.

${ctx.identity || ""}

${ctx.agents || ""}

${ctx.soul || ""}

Your capabilities:
- Read, write, and manage files anywhere on the computer
- Run terminal commands
- Access and modify any codebase
- Take multi-monitor screenshots
- Multi-agent memory system with datewise entries per agent

You speak naturally and concisely. You are helpful, direct, and proactive.
When the user asks you to do something, just do it without excessive explanation.

IMPORTANT: You CANNOT edit your own source code.

## Memory System (Multi-Agent)
- Current agent: ${mode}
- WRITE memories to: ${CLAUDE_HOME_PATH}/agents/${mode}/memory/YYYY-MM-DD/{slug}.md
- READ from ALL agents: ${CLAUDE_HOME_PATH}/agents/coding/memory/ AND ${CLAUDE_HOME_PATH}/agents/personal/memory/
- Shared context: ${CLAUDE_HOME_PATH}/shared/ (SOUL.md, USER.md, TOOLS.md)
- Memory format: frontmatter with name, type, agent, date, time
- After saving: curl -s -X POST http://localhost:${APP_PORT}/api/memory/sync

## APIs (http://localhost:${APP_PORT})
- Mode: GET/POST /api/mode
- Tasks: GET/POST /api/tasks
- Memory entities: GET /api/memory/entities
- Save memory: POST /api/memory/save
- List memories: GET /api/memory/list?agent=${mode}&date=YYYY-MM-DD
- Daily notes: GET/POST /api/memory/daily/YYYY-MM-DD
- Sync memory: POST /api/memory/sync
- Brain context: GET /api/brain/context

## Chrome — NEVER KILL OR RESTART
NEVER run taskkill on chrome.exe. NEVER kill Chrome instances. The user may be working in Chrome.
Chrome DevTools MCP connects via CDP on port 9222 using --user-data-dir=C:/Users/Shubham(Code)/ChromeDebug.
Do NOT launch Chrome yourself — it's already running. Use chrome-devtools-mcp tools to interact with browser.

${cliMemories ? `\n## CLI Memories (legacy)\n${cliMemories}` : ""}

CRITICAL: You ARE running inside Christopher's server on port ${APP_PORT} (DB: Supabase cloud). NEVER kill port ${APP_PORT}. NEVER run taskkill on port ${APP_PORT}.`,
  };
}

function getMasterChatConfig() {
  return {
    id: "master",
    name: "Master Chat",
    model: "claude-opus-4-6",
    skipPermissions: true,
    workingDirectory: "C:/Users/Shubham(Code)",
    systemPrompt: `You are the MASTER CHAT — Christopher's task orchestrator for Shubham Bhole.

YOUR ROLE: Dispatch tasks to worker chats. NEVER do direct work yourself (no file edits, no code, no running apps). Only orchestrate.

DISPATCH A TASK (fire and forget — returns instantly):
1. Create conversation + dispatch in one go:
   ID=$(curl -s -X POST http://localhost:${APP_PORT}/api/conversations -H "Content-Type: application/json" -d '{"title":"TASK NAME"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
   curl -s -X POST http://localhost:${APP_PORT}/api/conversations/$ID/dispatch -H "Content-Type: application/json" -d '{"text":"DETAILED TASK"}'

2. Immediately respond to the user: "Dispatched [task name]. Ask me for updates anytime."
   DO NOT wait for the worker to finish. DO NOT check status after dispatching. Just dispatch and respond.

RENAME A CHAT:
   curl -s -X PUT http://localhost:${APP_PORT}/api/conversations/ID/title -H "Content-Type: application/json" -d '{"title":"New Name"}'

CHECK STATUS (only when user asks "what's pending?" / "any updates?" / "is X done?"):
- All tasks: curl -s http://localhost:${APP_PORT}/api/conversations?status=in_progress
- Queue (needs attention): curl -s http://localhost:${APP_PORT}/api/queue
- Check a specific task: curl -s http://localhost:${APP_PORT}/api/conversations/ID/last-messages?limit=3
- All conversations: curl -s http://localhost:${APP_PORT}/api/conversations | python3 -c "import sys,json; [print(f'{c[\"status\"]:15s} {c[\"id\"][:8]} {c[\"title\"]}') for c in json.load(sys.stdin)[:15]]"

MARK TASK AS NEEDING ATTENTION (when a worker finishes and user should know):
   curl -s -X PUT http://localhost:${APP_PORT}/api/conversations/ID/status -H "Content-Type: application/json" -d '{"status":"waiting_for_user","summary":"Task completed - results ready"}'

ADD A TASK TO DATABASE (for simple "add task X" requests — do this directly, no worker needed):
  curl -s -X POST http://localhost:${APP_PORT}/api/tasks -H "Content-Type: application/json" -d '{"title":"TASK TITLE","priority":"medium","category":"personal","description":"DETAILS"}'
  → Returns JSON with task ID. Tell user "Added task #ID: title"

WHAT IS A TASK vs QUESTION vs SIMPLE ADD:
- SIMPLE ADD = "add task X", "remember to X", "task: X" → Use the task API directly (curl POST /api/tasks). No worker needed.
- WORK TASK = "start the app", "write a file", "fix the bug", "run the tests", "google X" → Dispatch to a worker chat
- QUESTION = "what's pending?", "how does X work?", "is task done?", "status?" → Answer directly
- Use your judgment. Simple task adds = API call. Real work = dispatch. Questions = answer.

BEHAVIOR:
- User gives TASK → dispatch immediately → respond "Dispatched [name]" → be ready for next task
- User asks QUESTION → answer it yourself right here
- User asks "what's pending?" → check status of dispatched tasks → report
- User asks "is X done?" → check that specific task → report result
- NEVER proactively interrupt. Only report when asked.
- Keep a mental list of all tasks you dispatched in this conversation
- If a task needs follow-up, dispatch to the SAME conversation ID

CRITICAL: You run inside Christopher on port ${APP_PORT}. NEVER kill port ${APP_PORT} or ${db.port}.`,
  };
}

// --- Playwright Mode Settings ---

const PLAYWRIGHT_TOKEN = "Kz3DVNUIw-Q5mmFsj7x43-ejzt2Elzej_uff2l1IQzQ";
const MCP_CONFIG_PATH = fs.existsSync(path.join(CHRISTOPHER_HOME, "config", "mcp-config.json"))
  ? path.join(CHRISTOPHER_HOME, "config", "mcp-config.json")
  : path.join(CLAUDE_HOME, "christopher", "config", "mcp-config.json");

function getPlaywrightMode() {
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
    const args = config.mcpServers?.playwright?.args || [];
    if (args.includes("--extension")) return "extension";
    if (args.some(a => a.includes("--cdp-endpoint"))) return "cdp";
    return "extension";
  } catch { return "extension"; }
}

function setPlaywrightMode(mode) {
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
    if (mode === "extension") {
      config.mcpServers.playwright = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--extension"],
        env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: PLAYWRIGHT_TOKEN }
      };
    } else {
      config.mcpServers.playwright = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", `http://localhost:${CDP_PORT}`]
      };
    }
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch { return false; }
}

const CDP_PORT_SETTING = 9222;

app.get("/api/settings/playwright", (req, res) => {
  res.json({ mode: getPlaywrightMode(), cdpPort: CDP_PORT_SETTING });
});

app.put("/api/settings/playwright", (req, res) => {
  const { mode } = req.body;
  if (!["extension", "cdp"].includes(mode)) return res.status(400).json({ error: "mode must be extension or cdp" });
  const ok = setPlaywrightMode(mode);
  if (ok) {
    // Update claude-manager's config too
    claudeManager._writeMcpConfig = undefined; // Will use the file directly
    res.json({ ok: true, mode, note: "New conversations will use this mode. Existing sessions keep their current mode." });
  } else {
    res.status(500).json({ error: "Failed to update config" });
  }
});

// --- Model Settings ---

app.get("/api/settings/model", (req, res) => {
  const config = getChristopherConfig();
  res.json({ model: config.model });
});

app.put("/api/settings/model", (req, res) => {
  const { model } = req.body;
  const validModels = ["claude-opus-4-6", "claude-opus-4-20250514", "claude-sonnet-4-6", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"];
  if (!validModels.includes(model)) return res.status(400).json({ error: "Invalid model" });

  const configPath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher-config.json");
  let saved = {};
  try {
    if (fs.existsSync(configPath)) saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {}
  saved.model = model;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(saved, null, 2));
  res.json({ ok: true, model });
});

// --- Screen Resolution Overrides ---

const screenResFile = path.join(CLAUDE_HOME, "christopher-screen-res.json");

function getScreenResOverrides() {
  try {
    if (fs.existsSync(screenResFile)) return JSON.parse(fs.readFileSync(screenResFile, "utf-8"));
  } catch {}
  return {};
}

function saveScreenResOverrides(data) {
  fs.mkdirSync(path.dirname(screenResFile), { recursive: true });
  fs.writeFileSync(screenResFile, JSON.stringify(data, null, 2));
}

app.get("/api/settings/screen-res", (req, res) => {
  res.json(getScreenResOverrides());
});

app.put("/api/settings/screen-res", (req, res) => {
  const { displayIndex, width, height } = req.body;
  if (displayIndex == null || !width || !height) return res.status(400).json({ error: "displayIndex, width, height required" });
  const overrides = getScreenResOverrides();
  overrides[String(displayIndex)] = { width: Number(width), height: Number(height) };
  saveScreenResOverrides(overrides);
  res.json({ ok: true, overrides });
});

app.delete("/api/settings/screen-res/:displayIndex", (req, res) => {
  const overrides = getScreenResOverrides();
  delete overrides[req.params.displayIndex];
  saveScreenResOverrides(overrides);
  res.json({ ok: true, overrides });
});

// --- REST API ---

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", name: APP_NAME });
});

app.get("/api/app-name", (req, res) => {
  res.json({ name: APP_NAME });
});

// Open a path in Windows Explorer
app.post("/api/open-path", (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: "path required" });
  try {
    const winPath = targetPath.replace(/\//g, "\\");
    execSync(`explorer "${winPath}"`, { stdio: "ignore" });
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // explorer returns non-zero even on success
  }
});

// --- Saved Directories ---

app.get("/api/directories", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM saved_directories ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/directories", async (req, res) => {
  try {
    const { name, path: dirPath } = req.body;
    if (!name || !dirPath) return res.status(400).json({ error: "name and path required" });
    const result = await db.query("INSERT INTO saved_directories (name, path) VALUES ($1, $2) RETURNING *", [name.trim(), dirPath.trim()]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/directories/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM saved_directories WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Brain Context (on-demand memory for any CLI instance) ---

app.get("/api/brain/context", async (req, res) => {
  try {
    const context = {};

    // Active tasks
    try {
      const tasks = await db.query(
        `SELECT id, title, priority, status, deadline, category FROM tasks
         WHERE status IN ('incomplete', 'in_progress')
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
         LIMIT 15`
      );
      context.tasks = tasks.rows;
    } catch { context.tasks = []; }

    // Recent daily notes
    try {
      const notes = [];
      for (let i = 0; i < 3; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split("T")[0];
        const note = memoryManager.loadDailyNote(dateStr);
        if (note) notes.push({ date: dateStr, content: note.slice(0, 500) });
      }
      context.recentNotes = notes;
    } catch { context.recentNotes = []; }

    // Active conversations and queue
    try {
      const queue = await db.query(
        `SELECT id, title, status, status_summary FROM conversations
         WHERE status = 'waiting_for_user' ORDER BY status_updated_at DESC LIMIT 10`
      );
      context.queue = queue.rows;

      const running = await db.query(
        `SELECT id, title FROM conversations WHERE status = 'in_progress' LIMIT 5`
      );
      context.running = running.rows;
    } catch { context.queue = []; context.running = []; }

    // Key memory entities
    try {
      const entities = await db.query(
        "SELECT entity_id, entity_type, summary FROM memory_entities ORDER BY last_updated DESC LIMIT 10"
      );
      context.entities = entities.rows;
    } catch { context.entities = []; }

    // Process counts
    context.activeProcesses = claudeManager.getRunningConversations().length;
    context.activeTerminals = terminalManager.getActiveCount();

    res.json(context);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Session Replay (read JSONL session files for historical viewing) ---

// List all local sessions on this computer
app.get("/api/sessions/local", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50");
    const sessions = sessionReader.listAllSessions({ limit });

    // Check which sessions are already in our DB
    const dbSessions = await db.query("SELECT claude_session_id FROM conversations WHERE claude_session_id IS NOT NULL");
    const dbSessionIds = new Set(dbSessions.rows.map(r => r.claude_session_id));

    const enriched = sessions.map(s => ({
      ...s,
      inDatabase: dbSessionIds.has(s.sessionId),
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import a local session into the database
app.post("/api/sessions/:sessionId/import", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title } = req.body;

    // Check if already in DB
    const existing = await db.query("SELECT id FROM conversations WHERE claude_session_id = $1", [sessionId]);
    if (existing.rows.length > 0) {
      return res.json({ ok: true, conversationId: existing.rows[0].id, existing: true });
    }

    // Get session summary and cwd for metadata
    const summary = await sessionReader.getSessionSummary(sessionId);
    let cwd = null;
    const filePath = sessionReader.findSessionFile(sessionId);
    if (filePath) {
      try {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(4096);
        fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const lines = buf.toString("utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try { const e = JSON.parse(line); if (e.cwd) { cwd = e.cwd; break; } } catch {}
        }
      } catch {}
    }
    const sessionTitle = title || `Imported - ${new Date().toLocaleString()}`;

    // Create conversation in DB
    const meta = { mode: "terminal-persistent", imported: true, source: "local", eventCount: summary?.eventCount || 0 };
    if (cwd) meta.cwd = cwd;
    const result = await db.query(
      `INSERT INTO conversations (title, claude_session_id, status, metadata) VALUES ($1, $2, 'active', $3) RETURNING *`,
      [sessionTitle, sessionId, JSON.stringify(meta)]
    );

    const convo = result.rows[0];
    io.emit("queue:update", { conversationId: convo.id, status: "active" });

    res.json({ ok: true, conversationId: convo.id, existing: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:sessionId/replay", async (req, res) => {
  try {
    const events = await sessionReader.readSession(req.params.sessionId);
    if (!events) return res.status(404).json({ error: "Session not found" });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:sessionId/summary", async (req, res) => {
  try {
    const summary = await sessionReader.getSessionSummary(req.params.sessionId);
    if (!summary) return res.status(404).json({ error: "Session not found" });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session info (cwd, project hash) without reading the full file
app.get("/api/sessions/:sessionId/info", (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const filePath = sessionReader.findSessionFile(sessionId);
    if (!filePath) return res.status(404).json({ error: "Session not found" });

    // Read first 4KB to extract cwd
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    let cwd = null;
    for (const line of lines) {
      try { const e = JSON.parse(line); if (e.cwd) { cwd = e.cwd; break; } } catch {}
    }

    // Extract project hash from file path
    const projectDir = path.basename(path.dirname(filePath));

    res.json({ sessionId, cwd, projectDir, filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Christopher config
app.get("/api/config", (req, res) => {
  res.json(getChristopherConfig());
});

// Create or get the Master Chat
app.post("/api/master-chat", async (req, res) => {
  try {
    // Check if master chat already exists
    const existing = await db.query(
      "SELECT * FROM conversations WHERE metadata->>'master' = 'true' ORDER BY created_at DESC LIMIT 1"
    );
    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }
    // Create new master chat
    const result = await db.query(
      "INSERT INTO conversations (title, status, metadata) VALUES ($1, 'active', $2) RETURNING *",
      ["Master Chat", JSON.stringify({ master: true })]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new blank conversation (start session without typing)
app.post("/api/conversations", async (req, res) => {
  try {
    const title = req.body.title || `Session - ${new Date().toLocaleString()}`;
    const result = await db.query(
      "INSERT INTO conversations (title, status) VALUES ($1, 'active') RETURNING *",
      [title]
    );
    const convo = result.rows[0];
    io.emit("queue:update", { conversationId: convo.id, status: "active", summary: "" });
    res.json(convo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a Claude CLI session immediately (pre-initialize)
app.post("/api/conversations/:id/start-session", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const agentConfig = getChristopherConfig();

    // Update conversation status to in_progress
    await db.query(
      "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
      [conversationId]
    );
    io.emit("queue:update", { conversationId, status: "in_progress", summary: "" });

    // Start CLI session with empty prompt to initialize
    await claudeManager.sendMessage(
      "Hello! I'm ready to help.",
      [],
      conversationId,
      agentConfig,
      null,
      // onChunk
      (chunk) => {
        io.emit("chat:chunk", { text: chunk, conversationId });
      },
      // onComplete
      async (fullResponse, sessionId) => {
        memoryManager.appendMessage(conversationId, "assistant", fullResponse);
        await db.query(
          "UPDATE conversations SET claude_session_id = $1, status = 'active', updated_at = NOW() WHERE id = $2",
          [sessionId, conversationId]
        );
        if (sessionId) db.query("INSERT INTO session_history (conversation_id, session_id, source) VALUES ($1, $2, 'process')", [conversationId, sessionId]).catch(() => {});
        io.emit("queue:update", { conversationId, status: "active", summary: "" });
        io.emit("chat:complete", { text: fullResponse, conversationId });
      },
      // onError
      async (error) => {
        await db.query(
          "UPDATE conversations SET status = 'error', status_summary = $1, status_updated_at = NOW() WHERE id = $2",
          [error.message.slice(0, 200), conversationId]
        );
        io.emit("queue:update", { conversationId, status: "error", summary: error.message.slice(0, 200) });
        io.emit("chat:error", { error: error.message, conversationId });
      },
      // onActivity
      (activity) => {
        io.emit("activity:event", { ...activity, conversationId });
      },
      // onRawEvent
      (event) => {
        io.emit("cli:event", { ...event, conversationId });
      }
    );

    res.json({ ok: true, conversationId, message: "Session starting..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get conversations (with optional status filter)
app.get("/api/conversations", async (req, res) => {
  try {
    const { status } = req.query;
    let query = "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50";
    let params = [];
    if (status) {
      query = "SELECT * FROM conversations WHERE status = $1 ORDER BY updated_at DESC LIMIT 50";
      params = [status];
    }
    const convos = await db.query(query, params);
    res.json(convos.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search conversations by title and message content
app.get("/api/conversations/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    if (!q) return res.json([]);

    const results = [];
    const seen = new Set();

    // 1. Title matches from DB
    const titleResults = await db.query(
      "SELECT * FROM conversations WHERE LOWER(title) LIKE $1 ORDER BY updated_at DESC LIMIT 20",
      [`%${q}%`]
    );
    for (const c of titleResults.rows) {
      results.push({ id: c.id, title: c.title, status: c.status, matchType: "title", updated_at: c.updated_at });
      seen.add(c.id);
    }

    // 2. Content matches — scan local JSONL message files
    const allConvos = await db.query("SELECT id, title, status, agent FROM conversations ORDER BY updated_at DESC LIMIT 100");
    for (const c of allConvos.rows) {
      if (seen.has(c.id)) continue;
      const msgs = memoryManager.getMessagesPaginated(c.id, { limit: 200, offset: 0 }, c.agent);
      if (!msgs.messages?.length) continue;
      for (const m of msgs.messages) {
        if (typeof m.content === "string" && m.content.toLowerCase().includes(q)) {
          const idx = m.content.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 40);
          const end = Math.min(m.content.length, idx + q.length + 40);
          const snippet = (start > 0 ? "..." : "") + m.content.slice(start, end).replace(/\n/g, " ") + (end < m.content.length ? "..." : "");
          results.push({ id: c.id, title: c.title, status: c.status, matchType: "content", snippet });
          seen.add(c.id);
          break;
        }
      }
      if (results.length >= 15) break;
    }

    // 3. Local session files (Sessions on Computer) — search by ID, path, and content
    const localSessions = sessionReader.listAllSessions({ limit: 200 });
    for (const s of localSessions) {
      if (results.length >= 20) break;
      // Match session ID or project path
      if (s.sessionId.toLowerCase().includes(q) || s.projectPath.toLowerCase().includes(q)) {
        results.push({
          id: `local-${s.sessionId}`, sessionId: s.sessionId, title: `Session ${s.sessionId.slice(0, 8)}`,
          projectPath: s.projectPath, sizeKb: s.sizeKb, modified: s.modified,
          matchType: "session", status: "local",
        });
        continue;
      }
      // Content search — read up to 20MB files (string search is fast)
      if (s.size < 20 * 1024 * 1024) {
        try {
          const filePath = sessionReader.findSessionFile(s.sessionId);
          if (!filePath) continue;
          const raw = fs.readFileSync(filePath, "utf-8");
          const idx = raw.toLowerCase().indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(raw.length, idx + q.length + 40);
            const snippet = (start > 0 ? "..." : "") + raw.slice(start, end).replace(/[\n\r]+/g, " ").replace(/["\{\}]/g, "").slice(0, 80) + (end < raw.length ? "..." : "");
            results.push({
              id: `local-${s.sessionId}`, sessionId: s.sessionId, title: `Session ${s.sessionId.slice(0, 8)}`,
              projectPath: s.projectPath, sizeKb: s.sizeKb, modified: s.modified,
              matchType: "session-content", status: "local", snippet,
            });
          }
        } catch {}
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single conversation
app.get("/api/conversations/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM conversations WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a conversation
app.put("/api/conversations/:id/title", async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    await db.query(
      "UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2",
      [title, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update conversation session ID (rename/alias)
app.put("/api/conversations/:id/session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    // Preserve the original UUID session ID in metadata so JSONL can still be found
    const convo = (await db.query("SELECT claude_session_id, metadata FROM conversations WHERE id = $1", [req.params.id])).rows[0];
    if (convo && convo.claude_session_id && sessionId && sessionId !== convo.claude_session_id) {
      const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
      // Only set original if not already set (don't overwrite the true original)
      if (!meta.original_session_id) {
        meta.original_session_id = convo.claude_session_id;
        await db.query("UPDATE conversations SET metadata = $1 WHERE id = $2", [JSON.stringify(meta), req.params.id]);
      }
    }
    await db.query(
      "UPDATE conversations SET claude_session_id = $1, updated_at = NOW() WHERE id = $2",
      [sessionId || null, req.params.id]
    );
    if (sessionId) {
      await db.query("INSERT INTO session_history (conversation_id, session_id, source) VALUES ($1, $2, 'manual')", [req.params.id, sessionId]).catch(() => {});
    }
    io.emit("conversation:updated", { conversationId: req.params.id, claude_session_id: sessionId || null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session history for a conversation
app.get("/api/conversations/:id/session-history", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT session_id, set_at, source FROM session_history WHERE conversation_id = $1 ORDER BY set_at DESC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/conversations/:id/mode", async (req, res) => {
  try {
    const { mode } = req.body;
    const convId = req.params.id;
    const validModes = ["terminal-persistent", "process-oneshot", "process-persistent"];
    if (!validModes.includes(mode)) return res.status(400).json({ error: "Invalid mode" });

    // Get current mode to detect transitions
    const convoResult = await db.query("SELECT metadata FROM conversations WHERE id = $1", [convId]);
    const currentMeta = convoResult.rows[0]?.metadata || {};
    const currentMode = currentMeta.mode || "";
    const switchingFromTerminal = currentMode.startsWith("terminal") && !mode.startsWith("terminal");
    const switchingFromProcess = currentMode.startsWith("process") && !mode.startsWith("process");

    // Kill existing PTY when switching FROM terminal to process
    if (switchingFromTerminal) {
      const killed = terminalManager.destroyTerminal(convId);
      if (killed) console.log(`[Mode] Killed PTY for ${convId.slice(0, 8)} (terminal → process)`);
    }

    // Kill existing persistent process when switching FROM process to terminal
    if (switchingFromProcess) {
      const killed = claudeManager.stopConversation(convId);
      if (killed) console.log(`[Mode] Killed process for ${convId.slice(0, 8)} (process → terminal)`);
    }

    // Update keepAlive tracking
    if (mode === "process-persistent" || mode === "terminal-persistent") {
      keepAliveConversations.add(convId);
    } else {
      keepAliveConversations.delete(convId);
    }

    await db.query(
      `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ mode }), convId]
    );
    io.emit("conversation:updated", { conversationId: convId, mode });
    res.json({ ok: true, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update conversation metadata (merge)
app.patch("/api/conversations/:id/metadata", async (req, res) => {
  try {
    const patch = req.body;
    await db.query(
      `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(patch), req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a conversation and its messages
app.delete("/api/conversations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // Stop any running CLI process
    claudeManager.stopConversation(id);
    keepAliveConversations.delete(id);
    // Delete local message files + DB conversation
    memoryManager.deleteMessages(id);
    await db.query("DELETE FROM conversations WHERE id = $1", [id]);
    io.emit("conversation:deleted", { conversationId: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a conversation (supports pagination: ?limit=50&offset=0&maxContentLen=20000)
app.get("/api/conversations/:id/messages", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 0;
    const offset = parseInt(req.query.offset) || 0;
    const maxContentLen = parseInt(req.query.maxContentLen) || 0;
    if (limit > 0) {
      const result = memoryManager.getMessagesPaginated(req.params.id, { limit, offset, maxContentLen });
      res.json(result);
    } else {
      // No limit = return all (backward compatible)
      const msgs = memoryManager.getMessages(req.params.id);
      res.json(msgs);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read current terminal screen content
app.get("/api/conversations/:id/terminal/screen", (req, res) => {
  const lastChars = parseInt(req.query.chars) || 2000;
  const screen = terminalManager.getScreenContent(req.params.id, lastChars);
  if (!screen) return res.status(404).json({ error: "No live PTY for this conversation" });
  res.json(screen);
});

// Write to a live terminal PTY (REST alternative to socket pty:input)
app.post("/api/conversations/:id/terminal/write", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const terminal = terminalManager.getTerminal(req.params.id);
  if (!terminal?.pty) return res.status(404).json({ error: "No live PTY for this conversation" });
  terminalManager.writeToTerminal(req.params.id, text + "\r");
  res.json({ ok: true, method: "terminal" });
});

// List active terminal sessions
app.get("/api/terminals", (req, res) => {
  const terminals = terminalManager.listTerminals ? terminalManager.listTerminals() : [];
  res.json(terminals);
});

// Start a terminal session for a conversation (REST alternative to socket pty:create)
app.post("/api/conversations/:id/terminal/start", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const convoResult = await db.query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
    if (convoResult.rows.length === 0) return res.status(404).json({ error: "Conversation not found" });
    const convo = convoResult.rows[0];

    // If terminal already exists, return it
    const existing = terminalManager.getTerminal(conversationId);
    if (existing?.pty) {
      return res.json({ ok: true, status: "already_running", pid: existing.pid });
    }

    const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
    const mode = meta.mode || "terminal-persistent";
    const termConfig = { sessionId: convo.claude_session_id };

    const agent = convo.agent || memoryManager.getMode();
    const tailerCallback = (role, content, timestamp) => {
      memoryManager.appendMessage(conversationId, role, content, agent, { source: "session-jsonl", timestamp });
    };

    const result = await terminalManager.createTerminal(conversationId, {
      mode,
      config: termConfig,
      cols: 120,
      rows: 30,
      onOutput: (data) => {
        io.emit("pty:output", { conversationId, data });
      },
      onExit: async (exitCode) => {
        io.emit("pty:exit", { conversationId, code: exitCode });
        await db.query("UPDATE conversations SET status = 'active', updated_at = NOW() WHERE id = $1", [conversationId]).catch(() => {});
      },
    });

    // Attach session tailer if session ID known
    if (convo.claude_session_id) {
      terminalManager.attachSessionTailer(conversationId, convo.claude_session_id, tailerCallback, true);
    }

    // Detect session ID if not set
    if (!convo.claude_session_id) {
      const detectInterval = setInterval(async () => {
        const sid = terminalManager.detectSessionId(conversationId);
        if (sid) {
          clearInterval(detectInterval);
          await db.query("UPDATE conversations SET claude_session_id = $1, updated_at = NOW() WHERE id = $2", [sid, conversationId]).catch(() => {});
          io.emit("conversation:updated", { conversationId, claude_session_id: sid });
          terminalManager.attachSessionTailer(conversationId, sid, tailerCallback, false);
        }
      }, 2000);
      setTimeout(() => clearInterval(detectInterval), 60000);
    }

    res.json({ ok: true, status: "started", pid: result.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status of all conversations — mode, session, terminal state
app.get("/api/status", async (req, res) => {
  try {
    const convos = await db.query("SELECT id, title, claude_session_id, status, metadata FROM conversations ORDER BY updated_at DESC");
    const activeTerminals = terminalManager.getActiveTerminals();
    const result = convos.rows.map((c) => {
      const meta = typeof c.metadata === "string" ? JSON.parse(c.metadata || "{}") : (c.metadata || {});
      const terminal = terminalManager.getTerminal(c.id);
      return {
        id: c.id,
        title: c.title,
        session_id: c.claude_session_id,
        status: c.status,
        mode: meta.mode || null,
        terminal: terminal ? { pid: terminal.pid, alive: !!terminal.pty } : null,
        starred: meta.starred || false,
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dispatch a task to a conversation (used by Master Chat to assign work)
// Supports both terminal and process modes with automatic fallback.
app.post("/api/conversations/:id/dispatch", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { text, keepAlive } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    // Save user message
    memoryManager.appendMessage(conversationId, "user", text);

    // Get conversation
    const convoResult = await db.query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
    if (convoResult.rows.length === 0) return res.status(404).json({ error: "Conversation not found" });
    const convo = convoResult.rows[0];

    const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
    const mode = meta.mode || "process-persistent";

    // ── TERMINAL DISPATCH ──────────────────────────────────────────────
    // If conversation is in terminal mode and has a live PTY, write directly to it.
    // This is fire-and-forget — the SessionTailer picks up the response from the JSONL.
    if (mode.startsWith("terminal")) {
      const terminal = terminalManager.getTerminal(conversationId);
      if (terminal?.pty) {
        console.log(`[Dispatch] Terminal mode → writing to PTY for ${conversationId.slice(0, 8)}`);
        // Update status
        await db.query(
          "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
          [conversationId]
        );
        io.emit("queue:update", { conversationId, status: "in_progress", summary: "" });

        // Write the text + Enter to the PTY (like a human typing)
        terminalManager.writeToTerminal(conversationId, text + "\r");

        return res.json({ ok: true, conversationId, method: "terminal", message: "Sent to terminal PTY" });
      }

      // Terminal mode but PTY not running — fall through to process dispatch
      console.log(`[Dispatch] Terminal mode but no live PTY for ${conversationId.slice(0, 8)} — falling back to process dispatch`);
    }

    // ── PROCESS DISPATCH ───────────────────────────────────────────────
    // Dispatched tasks always use keep-alive (process stays alive for multi-step work)
    keepAliveConversations.add(conversationId);

    // Update status
    await db.query(
      "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
      [conversationId]
    );
    io.emit("queue:update", { conversationId, status: "in_progress", summary: "" });

    const isMaster = meta.master === true;
    const agentConfig = isMaster ? getMasterChatConfig() : getChristopherConfig();
    if (isMaster) keepAliveConversations.add(conversationId);

    const useKeepAlive = keepAliveConversations.has(conversationId);
    const sendFn = useKeepAlive
      ? claudeManager.sendPersistentMessage.bind(claudeManager)
      : claudeManager.sendMessage.bind(claudeManager);

    const originalSessionId = convo.claude_session_id;

    sendFn(
      text, [], conversationId, agentConfig, originalSessionId,
      (chunk) => io.emit("chat:chunk", { text: chunk, conversationId }),
      async (fullResponse, sessionId) => {
        memoryManager.appendMessage(conversationId, "assistant", fullResponse);
        const shouldUpdateSession = !originalSessionId || sessionId === originalSessionId;
        if (shouldUpdateSession) {
          await db.query(
            "UPDATE conversations SET claude_session_id = $1, status = 'active', updated_at = NOW() WHERE id = $2",
            [sessionId, conversationId]
          );
        } else {
          console.log(`[Dispatch] New session ${sessionId?.slice(0,8)} differs from original ${originalSessionId?.slice(0,8)} — keeping original`);
          await db.query(
            "UPDATE conversations SET status = 'active', updated_at = NOW() WHERE id = $1",
            [conversationId]
          );
        }
        if (sessionId) db.query("INSERT INTO session_history (conversation_id, session_id, source) VALUES ($1, $2, 'process')", [conversationId, sessionId]).catch(() => {});
        io.emit("queue:update", { conversationId, status: "active", summary: "" });
        io.emit("chat:complete", { text: fullResponse, conversationId });
      },
      async (error) => {
        const errMsg = error.message.slice(0, 200);
        console.log(`[Dispatch] Process failed for ${conversationId.slice(0, 8)}: ${errMsg}`);
        // Don't touch session ID on error — preserve the original
        await db.query(
          "UPDATE conversations SET status = 'error', status_summary = $1, status_updated_at = NOW() WHERE id = $2",
          [errMsg, conversationId]
        );
        io.emit("queue:update", { conversationId, status: "error", summary: errMsg });
        io.emit("chat:error", { error: error.message, conversationId });
      },
      (activity) => io.emit("activity:event", { ...activity, conversationId }),
      (event) => io.emit("cli:event", { ...event, conversationId })
    );

    res.json({ ok: true, conversationId, method: "process", message: "Task dispatched" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get last N messages from a conversation (for Master Chat to check results)
app.get("/api/conversations/:id/last-messages", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 3;
    const { messages } = memoryManager.getMessagesPaginated(req.params.id, { limit, offset: 0 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track keep-alive preference in memory
const keepAliveConversations = new Set();

// Load keep-alive state from database on startup
async function loadKeepAliveState() {
  try {
    const result = await db.query(
      "SELECT id, metadata FROM conversations WHERE metadata IS NOT NULL AND metadata != '{}'"
    );
    for (const row of result.rows) {
      try {
        const metadata = JSON.parse(row.metadata || '{}');
        if (metadata.keepAlive) {
          keepAliveConversations.add(row.id);
          console.log(`[Startup] Restored keep-alive for conversation ${row.id.slice(0, 8)}`);
        }
      } catch {}
    }
  } catch (err) {
    console.error("[Startup] Failed to load keep-alive state:", err.message);
  }
}
// Load keep-alive state after database is initialized
await loadKeepAliveState();

// Toggle keep-alive mode for a conversation
app.post("/api/conversations/:id/keep-alive", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { enabled } = req.body;

    if (enabled) {
      keepAliveConversations.add(conversationId);
    } else {
      keepAliveConversations.delete(conversationId);
      // Kill the persistent session if it exists
      claudeManager.stopConversation(conversationId);
    }

    // Merge keep-alive into existing metadata (don't overwrite master flag etc.)
    await db.query(
      "UPDATE conversations SET metadata = COALESCE(metadata, '{}')::jsonb || $1::jsonb, updated_at = NOW() WHERE id = $2",
      [JSON.stringify({ keepAlive: enabled }), conversationId]
    );

    io.emit("session:keep-alive", { conversationId, enabled });
    res.json({ ok: true, conversationId, keepAlive: enabled });
  } catch (err) {
    console.error("Failed to update keep-alive:", err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle starred flag on a conversation
app.put("/api/conversations/:id/star", async (req, res) => {
  try {
    const { starred } = req.body;
    await db.query(
      "UPDATE conversations SET metadata = COALESCE(metadata, '{}')::jsonb || $1::jsonb, updated_at = NOW() WHERE id = $2",
      [JSON.stringify({ starred: !!starred }), req.params.id]
    );
    res.json({ ok: true, starred: !!starred });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update conversation agent
app.put("/api/conversations/:id/agent", async (req, res) => {
  try {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: "agent required" });
    await db.query("UPDATE conversations SET agent = $1, updated_at = NOW() WHERE id = $2", [agent, req.params.id]);
    res.json({ ok: true, agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent management — list, create, delete agents
app.get("/api/agents", (req, res) => {
  try {
    const agentsDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "agents");
    if (!fs.existsSync(agentsDir)) return res.json([]);
    const agents = fs.readdirSync(agentsDir).filter(d => {
      try { return fs.statSync(path.join(agentsDir, d)).isDirectory(); } catch { return false; }
    }).map(name => {
      const dir = path.join(agentsDir, name);
      const identity = path.join(dir, "IDENTITY.md");
      const hasIdentity = fs.existsSync(identity);
      const hasMemory = fs.existsSync(path.join(dir, "memory"));
      const hasMessages = fs.existsSync(path.join(dir, "messages"));
      let description = "";
      if (hasIdentity) {
        try { description = fs.readFileSync(identity, "utf-8").slice(0, 200); } catch {}
      }
      return { name, description, hasIdentity, hasMemory, hasMessages };
    });
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agents", (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid agent name (alphanumeric, hyphens, underscores only)" });
    const agentsDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "agents");
    const agentDir = path.join(agentsDir, name);
    if (fs.existsSync(agentDir)) return res.status(409).json({ error: "Agent already exists" });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "messages"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "IDENTITY.md"), `# ${name}\n\nAgent identity and behavior rules.\n`, "utf-8");
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/agents/:name", (req, res) => {
  try {
    const { name } = req.params;
    // No built-in agents — all agents are deletable
    const agentDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "agents", name);
    if (!fs.existsSync(agentDir)) return res.status(404).json({ error: "Agent not found" });
    fs.rmSync(agentDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update conversation status (used by Christopher via curl, or frontend)
app.put("/api/conversations/:id/status", async (req, res) => {
  try {
    const { status, summary } = req.body;
    const validStatuses = ["active", "in_progress", "waiting_for_user", "completed", "error"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }
    await db.query(
      "UPDATE conversations SET status = $1, status_summary = $2, status_updated_at = NOW(), updated_at = NOW() WHERE id = $3",
      [status, summary || "", req.params.id]
    );
    io.emit("queue:update", { conversationId: req.params.id, status, summary: summary || "" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Queue — conversations needing user attention
app.get("/api/queue", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM conversations c
       WHERE c.status = 'waiting_for_user'
       ORDER BY c.status_updated_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get memories
app.get("/api/memories", async (req, res) => {
  try {
    const mems = await db.query("SELECT * FROM memories ORDER BY updated_at DESC");
    res.json(mems.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshots
app.get("/api/screenshots", async (req, res) => {
  try {
    const screens = await screenshotService.captureAll();
    res.json(screens);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Memory API ---

app.get("/api/memory/entities", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM memory_entities ORDER BY last_updated DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/memory/entities/:id", async (req, res) => {
  try {
    const { entity, fileContent } = await memoryManager.loadEntity(req.params.id);
    res.json({ entity, content: fileContent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/memory/entities", async (req, res) => {
  try {
    const { entityId, type, filePath, summary, content } = req.body;
    if (!entityId || !type || !filePath) return res.status(400).json({ error: "entityId, type, filePath required" });
    await memoryManager.saveEntity(entityId, { type, filePath, summary, content: content || "" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/memory/entities/:id/timeline", async (req, res) => {
  try {
    const { event } = req.body;
    if (!event) return res.status(400).json({ error: "event required" });
    const ok = await memoryManager.appendToTimeline(req.params.id, event);
    res.json({ ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/memory/daily/:date", (req, res) => {
  const content = memoryManager.loadDailyNote(req.params.date);
  res.json({ date: req.params.date, content });
});

app.post("/api/memory/daily/:date", (req, res) => {
  const { content, append } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });
  if (append) {
    memoryManager.appendToDailyNote(req.params.date, content);
  } else {
    memoryManager.saveDailyNote(req.params.date, content);
  }
  res.json({ ok: true });
});

app.get("/api/memory/connections/:id", async (req, res) => {
  try {
    const connections = await memoryManager.getConnections(req.params.id);
    res.json(connections);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/memory/connections", async (req, res) => {
  try {
    const { from, to, type, context } = req.body;
    if (!from || !to || !type) return res.status(400).json({ error: "from, to, type required" });
    await memoryManager.addConnection(from, to, type, context);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/memory/sync", async (req, res) => {
  try {
    const count = await memoryManager.syncFromFiles();
    res.json({ ok: true, synced: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save memory (multi-agent aware)
app.post("/api/memory/save", (req, res) => {
  try {
    const { name, type, content, agent, date } = req.body;
    if (!name || !content) return res.status(400).json({ error: "name and content required" });
    const result = memoryManager.saveMemory({ name, type, content, agent, date });
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List memories (multi-agent aware)
app.get("/api/memory/list", (req, res) => {
  try {
    const { agent, date } = req.query;
    const memories = memoryManager.listMemories(agent || undefined, date || undefined);
    res.json(memories);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List shared files (~/.claude/shared/)
app.get("/api/memory/shared", (req, res) => {
  try {
    const sharedDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "shared");
    if (!fs.existsSync(sharedDir)) return res.json([]);
    const files = fs.readdirSync(sharedDir).filter(f => {
      try { return fs.statSync(path.join(sharedDir, f)).isFile(); } catch { return false; }
    }).map(name => {
      const stat = fs.statSync(path.join(sharedDir, name));
      return { name, size: stat.size, modified: stat.mtime };
    });
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read a specific shared file
app.get("/api/memory/shared/:name", (req, res) => {
  try {
    const filePath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "shared", req.params.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read a specific memory file content
app.get("/api/memory/file", (req, res) => {
  try {
    const { agent, path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const agentName = agent || memoryManager.getMode();
    const fullPath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "agents", agentName, "memory", filePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });
    const content = fs.readFileSync(fullPath, "utf-8");
    res.json({ content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Server info
app.get("/api/admin/info", (req, res) => {
  res.json({
    appRoot: ROOT,
    nodeVersion: process.version,
    uptime: process.uptime(),
    runningConversations: [...new Set([...claudeManager.getRunningConversations(), ...claudeManager.getPersistentConversations(), ...terminalManager.getActiveTerminals()])],
    persistentConversations: claudeManager.getPersistentConversations(),
    keepAliveConversations: Array.from(keepAliveConversations),
  });
});

// --- Agent Mode API ---

app.get("/api/mode", (req, res) => {
  res.json({ mode: memoryManager.getMode() });
});

app.post("/api/mode", (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) return res.status(400).json({ error: "mode required" });
    const newMode = memoryManager.setMode(mode);
    io.emit("mode:changed", { mode: newMode });
    res.json({ ok: true, mode: newMode });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Layout Settings ---

app.get("/api/settings/layout", (req, res) => {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher-config.json");
  let saved = {};
  try { if (fs.existsSync(configPath)) saved = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
  res.json({ maxPanes: saved.maxPanes || 4, multiView: saved.multiView || false, paneConvos: saved.paneConvos || [], volume: saved.volume !== undefined ? saved.volume : 1, voiceEnabled: saved.voiceEnabled !== undefined ? saved.voiceEnabled : true });
});

app.put("/api/settings/layout", (req, res) => {
  const { maxPanes, multiView, paneConvos, volume, voiceEnabled } = req.body;
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher-config.json");
  let saved = {};
  try { if (fs.existsSync(configPath)) saved = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
  if (maxPanes !== undefined) saved.maxPanes = maxPanes;
  if (multiView !== undefined) saved.multiView = multiView;
  if (paneConvos !== undefined) saved.paneConvos = paneConvos;
  if (volume !== undefined) saved.volume = volume;
  if (voiceEnabled !== undefined) saved.voiceEnabled = voiceEnabled;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(saved, null, 2));
  res.json({ ok: true });
});

// --- Skills API ---

const SKILLS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "skills");

app.get("/api/skills", (req, res) => {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return res.json([]);
    const dirs = fs.readdirSync(SKILLS_DIR).filter(d => fs.statSync(path.join(SKILLS_DIR, d)).isDirectory());
    const skills = dirs.map(name => {
      const skillDir = path.join(SKILLS_DIR, name);
      const skillMd = path.join(skillDir, "SKILL.md");
      let description = "", fullDescription = "";
      try {
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf-8");
          // Parse frontmatter description
          const descMatch = content.match(/description:\s*"?([^"\n]+)"?/);
          description = descMatch ? descMatch[1].slice(0, 120) : "";
          fullDescription = content;
        }
      } catch {}
      // Count files
      let fileCount = 0;
      const countFiles = (dir) => { try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) countFiles(p); else fileCount++; } } catch {} };
      countFiles(skillDir);
      return { name, description, fileCount, hasSkillMd: fs.existsSync(skillMd) };
    });
    res.json(skills);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/skills/:name", (req, res) => {
  try {
    const dir = path.join(SKILLS_DIR, req.params.name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: "Skill not found" });
    const skillMd = path.join(dir, "SKILL.md");
    let content = "";
    try { if (fs.existsSync(skillMd)) content = fs.readFileSync(skillMd, "utf-8"); } catch {}
    // List all files
    const files = [];
    const walk = (d, prefix) => { try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p, prefix + f + "/"); else files.push(prefix + f); } } catch {} };
    walk(dir, "");
    res.json({ name: req.params.name, content, files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/skills/create", (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const dir = path.join(SKILLS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n\nDescribe this skill here.\n`);
    res.json({ ok: true, name: slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/skills/:name", (req, res) => {
  try {
    const dir = path.join(SKILLS_DIR, req.params.name);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Connectors (MCP Registry) API ---

// Default MCP connectors — these show as "available" if not installed
const MCP_REGISTRY = {
  "chrome-devtools-mcp": {
    command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"],
    description: "Browser automation via Chrome DevTools Protocol",
    install: "npm install -g chrome-devtools-mcp",
  },
  "windows-mcp": {
    command: "uvx", args: ["windows-mcp"],
    description: "Windows desktop automation (click, type, screenshots)",
    install: "pip install uv (uvx auto-installs on first run)",
  },
  "excel-mcp": {
    command: "mcp-excel", args: [],
    description: "Live Excel editing via COM (.NET tool)",
    install: "dotnet tool install -g sbroenne.excelmcp.mcpserver",
  },
  "ppt-mcp": {
    command: "mcp-ppt", args: [],
    description: "Live PowerPoint editing via COM (.NET tool)",
    install: "dotnet tool install -g pptmcp.mcpserver",
  },
};

// Claude Code reads MCPs from ~/.claude.json (NOT ~/.claude/settings.json)
const CLAUDE_JSON_PATH = path.join(process.env.USERPROFILE || process.env.HOME, ".claude.json");
function readClaudeJson() {
  try { if (fs.existsSync(CLAUDE_JSON_PATH)) return JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf-8")); } catch {}
  return {};
}
function writeClaudeJson(data) {
  fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(data, null, 2));
}

app.get("/api/connectors", (req, res) => {
  try {
    const config = readClaudeJson();
    const mcpServers = config.mcpServers || {};
    const installed = Object.entries(mcpServers).map(([name, c]) => ({
      name, command: c.command, args: c.args || [],
      description: MCP_REGISTRY[name]?.description || "",
    }));
    const installedNames = new Set(installed.map(c => c.name));
    const available = Object.entries(MCP_REGISTRY)
      .filter(([name]) => !installedNames.has(name))
      .map(([name, info]) => ({ name, ...info }));
    res.json({ installed, available });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/connectors/add", (req, res) => {
  try {
    const { name, command, args } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const config = readClaudeJson();
    if (!config.mcpServers) config.mcpServers = {};
    const info = MCP_REGISTRY[name] || { command: command || name, args: args || [] };
    config.mcpServers[name] = { command: info.command, args: info.args };
    writeClaudeJson(config);
    res.json({ ok: true, note: "Restart Claude Code for MCP changes to take effect" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/connectors/:name", (req, res) => {
  try {
    const config = readClaudeJson();
    if (config.mcpServers) delete config.mcpServers[req.params.name];
    writeClaudeJson(config);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Message Processing (per-conversation queues) ---

// Global conversation processing state
const conversationQueues = new Map(); // conversationId -> { processing, queue[] }

function getConvoQueue(conversationId) {
  if (!conversationQueues.has(conversationId)) {
    conversationQueues.set(conversationId, { processing: false, queue: [] });
  }
  return conversationQueues.get(conversationId);
}

// Track which socket is actively viewing which conversation (for TTS routing)
const activeViews = new Map(); // socketId -> conversationId

async function processMessage(socket, job) {
  const { text, imagePaths, convo, agentConfig } = job;
  const q = getConvoQueue(convo.id);
  q.processing = true;

  try {
    const keepAlive = keepAliveConversations.has(convo.id);

    // Update status to in_progress
    await db.query(
      "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
      [convo.id]
    );
    io.emit("queue:update", { conversationId: convo.id, status: "in_progress", summary: "" });

    io.emit("chat:status", { status: "thinking", conversationId: convo.id });

    // Shared callbacks for both modes — use io.emit so all panes in multi-view update
    const onChunk = (chunk) => {
      io.emit("chat:chunk", { text: chunk, conversationId: convo.id });
    };
    const onComplete = async (fullResponse, sessionId) => {
      memoryManager.appendMessage(convo.id, "assistant", fullResponse);
      await db.query(
        "UPDATE conversations SET claude_session_id = $1, updated_at = NOW() WHERE id = $2",
        [sessionId, convo.id]
      );
      convo.claude_session_id = sessionId;

      const needsInput = /\b(what do you think|please (confirm|let me know|tell me|choose|decide)|waiting for|need your (input|decision|confirmation|approval)|which (one|option)|should I|let me know|your (call|thoughts|preference))\b/i;
      let newStatus = "active";
      let summary = "";
      if (needsInput.test(fullResponse)) {
        newStatus = "waiting_for_user";
        const sentences = fullResponse.split(/[.!?]+/).filter(s => s.trim());
        summary = sentences.slice(-2).join(". ").trim().slice(0, 200);
      }

      await db.query(
        "UPDATE conversations SET status = $1, status_summary = $2, status_updated_at = NOW() WHERE id = $3",
        [newStatus, summary, convo.id]
      );
      io.emit("queue:update", { conversationId: convo.id, status: newStatus, summary });

      io.emit("chat:complete", { text: fullResponse, conversationId: convo.id });

      processNext(convo.id, socket);
    };
    const onError = async (error) => {
      await db.query(
        "UPDATE conversations SET status = 'error', status_summary = $1, status_updated_at = NOW() WHERE id = $2",
        [error.message.slice(0, 200), convo.id]
      );
      io.emit("queue:update", { conversationId: convo.id, status: "error", summary: error.message.slice(0, 200) });
      socket.emit("chat:error", { error: error.message, conversationId: convo.id });
      processNext(convo.id, socket);
    };
    const onActivity = (activity) => {
      io.emit("activity:event", { ...activity, conversationId: convo.id });
    };
    const onRawEvent = (event) => {
      io.emit("cli:event", { ...event, conversationId: convo.id });
    };

    if (keepAlive) {
      // PERSISTENT MODE — process stays alive between messages
      await claudeManager.sendPersistentMessage(
        text || "", imagePaths, convo.id, agentConfig, convo.claude_session_id,
        onChunk, onComplete, onError, onActivity, onRawEvent
      );
    } else {
      // ONE-SHOT MODE — original behavior, process dies after response
      await claudeManager.sendMessage(
        text || "", imagePaths, convo.id, agentConfig, convo.claude_session_id,
        onChunk, onComplete, onError, onActivity, onRawEvent
      );
    }
  } catch (err) {
    console.error("[Chat Error]", err);
    socket.emit("chat:error", { error: err.message, conversationId: convo.id });
    processNext(convo.id, socket);
  }
}

function processNext(conversationId, socket) {
  const q = getConvoQueue(conversationId);
  if (q.queue.length === 0) {
    q.processing = false;
    return;
  }
  const next = q.queue.shift();
  processMessage(socket, next);
}

// --- WebSocket ---

io.on("connection", (socket) => {
  console.log(`[Christopher] Client connected: ${socket.id}`);

  // Track which conversation this client is viewing
  socket.on("view:conversation", ({ conversationId }) => {
    // Leave old PTY rooms
    const oldConvo = activeViews.get(socket.id);
    if (oldConvo && oldConvo !== conversationId) {
      socket.leave(`pty:${oldConvo}`);
    }
    activeViews.set(socket.id, conversationId);
    // Join PTY room for new conversation (if terminal exists)
    if (terminalManager.getTerminal(conversationId)) {
      socket.join(`pty:${conversationId}`);
    }
  });

  // --- PTY Terminal Events (Modes 1 & 2) ---

  socket.on("pty:create", async ({ conversationId, mode, cols, rows, config }) => {
    try {
      const convo = await ensureConversation(conversationId);
      const convId = convo.id;

      // If terminal already exists for this conversation, just reconnect
      if (terminalManager.getTerminal(convId)) {
        socket.join(`pty:${convId}`);
        const existing = terminalManager.getTerminal(convId);
        socket.emit("pty:ready", { conversationId: convId, pid: existing.pid });
        return;
      }

      // Update conversation metadata with mode
      await db.query(
        `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ mode }), convId]
      );

      // Join a socket room for this conversation so output is scoped
      socket.join(`pty:${convId}`);

      // Check if this is the master chat — add master chat CLAUDE.md dir
      const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
      const isMasterConvo = meta.master === true;
      const termConfig = { ...config, sessionId: convo.claude_session_id };
      if (isMasterConvo) {
        termConfig.addDirs = [path.join(CHRISTOPHER_HOME, "config", "master-chat")];
      }

      const agent = convo.agent || memoryManager.getMode();
      const tailerCallback = (role, content, timestamp) => {
        memoryManager.appendMessage(convId, role, content, agent, {
          source: "session-jsonl",
          timestamp,
        });
      };

      const result = await terminalManager.createTerminal(convId, {
        mode,
        config: termConfig,
        cols,
        rows,
        onOutput: (data) => {
          io.emit("pty:output", { conversationId: convId, data });
        },
        onExit: async (exitCode) => {
          io.emit("pty:exit", { conversationId: convId, code: exitCode });
          await db.query(
            "UPDATE conversations SET status = 'active', updated_at = NOW() WHERE id = $1",
            [convId]
          ).catch(() => {});
        },
      });

      socket.emit("pty:ready", { conversationId: convId, pid: result.pid });

      // If session ID is already known (resumed session), attach tailer immediately
      if (convo.claude_session_id) {
        terminalManager.attachSessionTailer(convId, convo.claude_session_id, tailerCallback, true);
      }

      // Detect and save session ID — ONLY if conversation doesn't already have one
      if (!convo.claude_session_id) {
        const detectAndSave = async () => {
          // Re-check DB in case another detection already set it
          const check = await db.query("SELECT claude_session_id FROM conversations WHERE id = $1", [convId]).catch(() => null);
          if (check?.rows?.[0]?.claude_session_id) return true; // already set

          const sid = terminalManager.detectSessionId(convId);
          if (sid) {
            await db.query("UPDATE conversations SET claude_session_id = $1, updated_at = NOW() WHERE id = $2", [sid, convId]).catch(() => {});
            await db.query("INSERT INTO session_history (conversation_id, session_id, source) VALUES ($1, $2, 'auto-detect')", [convId, sid]).catch(() => {});
            console.log(`[Terminal] Detected session ${sid.slice(0, 8)} for ${convId.slice(0, 8)}`);
            io.emit("conversation:updated", { conversationId: convId, claude_session_id: sid });

            // Attach session tailer now that we know the session ID (read from beginning)
            terminalManager.attachSessionTailer(convId, sid, tailerCallback, false);
            return true;
          }
          return false;
        };
        // Retry detection: every 3s for up to 30s (10 attempts)
        let attempts = 0;
        const maxAttempts = 10;
        const retryTimer = setInterval(async () => {
          attempts++;
          if (await detectAndSave() || attempts >= maxAttempts) {
            clearInterval(retryTimer);
            if (attempts >= maxAttempts) {
              console.log(`[Terminal] Session detection gave up after ${maxAttempts} attempts for ${convId.slice(0, 8)}`);
            }
          }
        }, 3000);
      }

      // Mark conversation as in_progress
      await db.query(
        "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
        [convId]
      );
      io.emit("queue:update", { conversationId: convId, status: "in_progress" });
    } catch (err) {
      socket.emit("chat:error", { error: err.message, conversationId });
    }
  });

  // Check if a PTY is active for a conversation
  socket.on("pty:check", ({ conversationId }) => {
    const terminal = terminalManager.getTerminal(conversationId);
    if (terminal) {
      // PTY is running — join the room and tell client to connect
      socket.join(`pty:${conversationId}`);
      socket.emit("pty:active", { conversationId, pid: terminal.pid });
    } else {
      socket.emit("pty:inactive", { conversationId });
    }
  });

  socket.on("pty:input", ({ conversationId, data }) => {
    terminalManager.writeToTerminal(conversationId, data);
  });

  socket.on("pty:resize", ({ conversationId, cols, rows }) => {
    terminalManager.resizeTerminal(conversationId, cols, rows);
  });

  socket.on("pty:destroy", ({ conversationId }) => {
    terminalManager.destroyTerminal(conversationId);
  });

  // --- Chat Events (Modes 3 & 4) ---

  socket.on("chat:message", async (data) => {
    const { text, images, conversationId } = data;
    if ((!text || !text.trim()) && (!images || images.length === 0)) return;

    try {
      // Save uploaded images to disk
      const imagePaths = [];
      if (images && images.length > 0) {
        const uploadsDir = path.join(ROOT, "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        for (let i = 0; i < images.length; i++) {
          const dataUrl = images[i];
          const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
            const base64Data = matches[2];
            const filename = `img_${Date.now()}_${i}.${ext}`;
            const filepath = path.join(uploadsDir, filename);
            fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
            imagePaths.push(filepath);
          }
        }
      }

      // Resolve conversation
      const convo = await ensureConversation(conversationId);

      // Agent-lock: only allow writing to conversations matching current mode
      const currentMode = memoryManager.getMode();
      const convoAgent = convo.agent || currentMode;
      const convoMeta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
      if (!convoMeta.master && convoAgent !== currentMode) {
        socket.emit("chat:error", { error: `Cannot write to ${convoAgent} conversation while in ${currentMode} mode. Switch agent mode first.`, conversationId: convo.id });
        return;
      }

      // Tell frontend the conversationId immediately
      socket.emit("chat:conversation", { conversationId: convo.id });

      // Track this as active view
      activeViews.set(socket.id, convo.id);

      memoryManager.appendMessage(convo.id, "user", text || "(image)", convoAgent);

      // Use master config if this is the master chat
      const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
      const isMaster = meta.master === true;
      const agentConfig = isMaster ? getMasterChatConfig() : getChristopherConfig();
      if (isMaster) keepAliveConversations.add(convo.id);
      const job = { text, imagePaths, convo, agentConfig };
      const q = getConvoQueue(convo.id);

      if (q.processing) {
        console.log(`[Queue] Conversation ${convo.id} busy, queuing: "${(text || "").slice(0, 50)}..."`);
        q.queue.push(job);
      } else {
        processMessage(socket, job);
      }
    } catch (err) {
      console.error("[Chat Error]", err);
      socket.emit("chat:error", { error: err.message });
    }
  });

  socket.on("chat:new-conversation", () => {
    // Just clear active view — new conversation created on first message
    activeViews.delete(socket.id);
  });

  // Raw message — writes directly to persistent CLI stdin (no system prompt wrapping)
  socket.on("chat:raw", async (data) => {
    const { text, conversationId } = data;
    if (!text || !conversationId) return;

    const isPersistent = claudeManager.isPersistent(conversationId);
    if (!isPersistent) {
      socket.emit("chat:error", { error: "Raw input requires an active persistent session (Keep Instance Active)", conversationId });
      return;
    }

    try {
      // Save user message to DB
      memoryManager.appendMessage(conversationId, "user", `[raw] ${text}`);

      // Get the conversation for session ID
      const convoResult = await db.query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
      const convo = convoResult.rows[0];
      if (!convo) return;

      const agentConfig = getChristopherConfig();

      await db.query(
        "UPDATE conversations SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
        [conversationId]
      );
      io.emit("queue:update", { conversationId, status: "in_progress", summary: "" });
      io.emit("chat:status", { status: "thinking", conversationId });

      await claudeManager.sendPersistentMessage(
        text, [], conversationId, agentConfig, convo.claude_session_id,
        // onChunk
        (chunk) => io.emit("chat:chunk", { text: chunk, conversationId }),
        // onComplete
        async (fullResponse, sessionId) => {
          memoryManager.appendMessage(conversationId, "assistant", fullResponse);
          await db.query(
            "UPDATE conversations SET claude_session_id = $1, status = 'active', updated_at = NOW() WHERE id = $2",
            [sessionId, conversationId]
          );
          io.emit("queue:update", { conversationId, status: "active", summary: "" });
          io.emit("chat:complete", { text: fullResponse, conversationId });
        },
        // onError
        async (error) => {
          await db.query(
            "UPDATE conversations SET status = 'error', status_summary = $1, status_updated_at = NOW() WHERE id = $2",
            [error.message.slice(0, 200), conversationId]
          );
          io.emit("chat:error", { error: error.message, conversationId });
        },
        // onActivity
        (activity) => io.emit("activity:event", { ...activity, conversationId }),
        // onRawEvent
        (event) => io.emit("cli:event", { ...event, conversationId })
      );
    } catch (err) {
      socket.emit("chat:error", { error: err.message, conversationId });
    }
  });

  // Raw terminal — attach to persistent session stdout stream
  socket.on("terminal:attach", ({ conversationId }) => {
    if (!conversationId) return;
    claudeManager.setRawStdoutListener(conversationId, (text) => {
      socket.emit("terminal:output", { text, conversationId });
    });
    socket.emit("terminal:attached", { conversationId });
  });

  socket.on("terminal:detach", ({ conversationId }) => {
    if (conversationId) claudeManager.setRawStdoutListener(conversationId, null);
  });

  // Raw terminal stdin — write directly to CLI process
  socket.on("terminal:input", ({ text, conversationId }) => {
    if (!text || !conversationId) return;
    claudeManager.writeRawStdin(conversationId, text);
  });

  socket.on("chat:stop", (data) => {
    const conversationId = data?.conversationId;
    if (conversationId) {
      // Kill the CLI process (or queue for kill if still spawning)
      claudeManager.stopConversation(conversationId);
      // Clear the message queue so nothing re-spawns
      const q = getConvoQueue(conversationId);
      q.queue = [];
      q.processing = false;
      socket.emit("chat:stopped", { conversationId });
    }
  });

  socket.on("screenshot:capture", async (data) => {
    try {
      const monitor = data?.monitor;
      const screens = monitor != null
        ? [await screenshotService.capture(monitor)]
        : await screenshotService.captureAll();
      socket.emit("screenshot:result", { screens });
    } catch (err) {
      socket.emit("screenshot:error", { error: err.message });
    }
  });

  // --- Screen Viewer (live streaming) ---
  let screenInterval = null;

  socket.on("screen:list", async () => {
    try {
      const displays = await screenshotService.listDisplays();
      socket.emit("screen:displays", { displays });
    } catch (err) {
      socket.emit("screen:displays", { displays: [] });
    }
  });

  socket.on("screen:start", async (data) => {
    const displayIndex = data?.displayIndex ?? 0;
    const fps = Math.min(Math.max(data?.fps || 5, 1), 15);
    const quality = Math.min(Math.max(data?.quality || 50, 20), 90);
    const interval = Math.round(1000 / fps);

    // Check for resolution override
    const overrides = getScreenResOverrides();
    const override = overrides[String(displayIndex)];
    const resizeW = override?.width || 0;
    const resizeH = override?.height || 0;

    // Stop any existing stream
    if (screenInterval) clearInterval(screenInterval);

    let capturing = false;
    screenInterval = setInterval(async () => {
      if (capturing) return;
      capturing = true;
      try {
        const frame = await screenshotService.captureJpeg(displayIndex, quality, resizeW, resizeH);
        socket.emit("screen:frame", { image: frame, displayIndex, timestamp: Date.now() });
      } catch {}
      capturing = false;
    }, interval);
  });

  socket.on("screen:stop", () => {
    if (screenInterval) { clearInterval(screenInterval); screenInterval = null; }
  });

  socket.on("disconnect", () => {
    // Stop screen streaming
    if (screenInterval) { clearInterval(screenInterval); screenInterval = null; }
    // Detach any raw terminal listeners this socket had
    const viewedConvo = activeViews.get(socket.id);
    if (viewedConvo) claudeManager.setRawStdoutListener(viewedConvo, null);
    activeViews.delete(socket.id);
    console.log(`[Christopher] Client disconnected: ${socket.id}`);
  });
});

async function ensureConversation(convoId) {
  if (convoId) {
    const result = await db.query("SELECT * FROM conversations WHERE id = $1", [convoId]);
    if (result.rows.length > 0) return result.rows[0];
  }
  const result = await db.query(
    "INSERT INTO conversations (title) VALUES ($1) RETURNING *",
    [`Chat - ${new Date().toLocaleString()}`]
  );
  return result.rows[0];
}

// --- Serve Frontend ---

const distPath = path.join(ROOT, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, { etag: false, maxAge: 0 }));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/socket.io")) {
      res.sendFile(path.join(distPath, "index.html"));
    }
  });
}

// --- Graceful Shutdown ---

async function shutdown() {
  console.log("\n[Christopher] Shutting down...");
  // Kill all running Claude CLI processes
  for (const convoId of claudeManager.getRunningConversations()) {
    claudeManager.stopConversation(convoId);
  }
  // Close database (stops embedded PostgreSQL)
  await db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Cleanup stale statuses on startup + periodic reconciliation ---

async function cleanupStaleConversations() {
  try {
    const running = claudeManager.getRunningConversations();
    const result = await db.query(
      "SELECT id FROM conversations WHERE status = 'in_progress'"
    );
    let cleaned = 0;
    for (const row of result.rows) {
      if (!running.includes(row.id)) {
        await db.query(
          "UPDATE conversations SET status = 'active', status_summary = '', updated_at = NOW() WHERE id = $1",
          [row.id]
        );
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[Cleanup] Reset ${cleaned} stale 'in_progress' conversations to 'active'`);
      io.emit("queue:update", { status: "active", summary: "" }); // trigger sidebar refresh
    }
  } catch (err) {
    console.error("[Cleanup] Error:", err.message);
  }
}

// --- Start ---

server.listen(APP_PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║   Christopher v3 - AI Assistant          ║
║   Running on http://localhost:${APP_PORT}       ║
║   Embedded PostgreSQL on port ${db.port}      ║
║   Global data: ~/.claude/christopher/    ║
║   4 Modes: Terminal + Process            ║
╚══════════════════════════════════════════╝
  `);


  // Clean up on startup
  await cleanupStaleConversations();

  // Sync memory files to DB
  try {
    const synced = await memoryManager.syncFromFiles();
    if (synced > 0) console.log(`[Memory] Initial sync: ${synced} entities`);
  } catch (err) {
    console.error("[Memory] Sync error:", err.message);
  }

  // Reconcile every 30 seconds
  setInterval(cleanupStaleConversations, 30000);
});
