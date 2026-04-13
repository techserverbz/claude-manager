import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CHRISTOPHER_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher");

// Nesting guard vars to strip (prevents "cannot launch inside session" errors)
const CLAUDE_NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
];

const MAX_CONCURRENT = 5;

const CDP_PORT = 9222;
const CHROME_PROFILE = path.join(CHRISTOPHER_HOME, "browser");

export class ClaudeManager {
  constructor(appRoot, db, memoryManager) {
    this.appRoot = appRoot;
    this.db = db;
    this.memoryManager = memoryManager;
    this.oneShotProcesses = new Map();    // conversationId -> { child, sessionId }
    this.persistentSessions = new Map();  // conversationId -> PersistentSession
    this.pendingStops = new Set();        // conversationIds that should be killed on spawn
    this.claudeDir = path.join(CHRISTOPHER_HOME, "config");
    this.chromeProcess = null;
    this.mcpConfigPath = path.join(CHRISTOPHER_HOME, "config", "mcp-config.json");
  }

  // Launch persistent Chrome with remote debugging
  async launchPersistentChrome() {
    // Check if Chrome is already listening on CDP port
    try {
      const net = await import("net");
      const inUse = await new Promise((resolve) => {
        const s = net.default.createConnection({ port: CDP_PORT, host: "localhost" });
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
      });
      if (inUse) {
        console.log(`[Chrome] Already running on CDP port ${CDP_PORT}`);
        return;
      }
    } catch {}

    // Find Chrome
    const chromePaths = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ];
    const chromePath = chromePaths.find(p => fs.existsSync(p));
    if (!chromePath) {
      console.log("[Chrome] Chrome not found, Playwright will use its own browser");
      return;
    }

    // Create profile dir
    fs.mkdirSync(CHROME_PROFILE, { recursive: true });

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
    ];

    this.chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    this.chromeProcess.unref();
    console.log(`[Chrome] Launched persistent Chrome on CDP port ${CDP_PORT} (PID ${this.chromeProcess.pid})`);

    // Wait for CDP to be ready
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const net = await import("net");
        const ready = await new Promise((resolve) => {
          const s = net.default.createConnection({ port: CDP_PORT, host: "localhost" });
          s.on("connect", () => { s.destroy(); resolve(true); });
          s.on("error", () => resolve(false));
        });
        if (ready) { console.log("[Chrome] CDP ready"); return; }
      } catch {}
    }
    console.log("[Chrome] CDP not ready after 5s, continuing anyway");
  }

  // --- Session CWD resolution ---

  /**
   * Find the original working directory for a session by scanning all project dirs.
   * Claude Code's --resume only works when run from the same cwd (project hash) as the original session.
   */
  _resolveSessionCwd(sessionId) {
    if (!sessionId) return null;
    const projectsDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return null;
    try {
      const dirs = fs.readdirSync(projectsDir).filter(d => {
        try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath)) {
          // Read first few lines to find the cwd field
          const fd = fs.openSync(jsonlPath, "r");
          const buf = Buffer.alloc(4096);
          fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          const chunk = buf.toString("utf-8");
          const lines = chunk.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (evt.cwd && fs.existsSync(evt.cwd)) return evt.cwd;
            } catch {}
          }
          return null;
        }
      }
    } catch {}
    return null;
  }

  // --- Args builders ---

  _commonArgs(agentConfig, sessionId) {
    const args = [];
    if (sessionId) args.push("--resume", sessionId);
    if (agentConfig?.skipPermissions !== false) args.push("--dangerously-skip-permissions");
    if (agentConfig?.model) args.push("--model", agentConfig.model);
    if (agentConfig?.maxTurns) args.push("--max-turns", String(agentConfig.maxTurns));
    args.push("--add-dir", this.appRoot);
    // Use persistent Chrome via CDP
    if (fs.existsSync(this.mcpConfigPath)) {
      args.push("--mcp-config", `"${this.mcpConfigPath}"`);
    }
    return args;
  }

  buildOneShotArgs(agentConfig, sessionId) {
    return ["--print", "-", "--output-format", "stream-json", "--verbose", ...this._commonArgs(agentConfig, sessionId)];
  }

  buildPersistentArgs(agentConfig, sessionId) {
    return ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...this._commonArgs(agentConfig, sessionId)];
  }

  buildEnv() {
    const env = { ...process.env };
    for (const key of CLAUDE_NESTING_VARS) delete env[key];
    env.CHRISTOPHER_APP_ROOT = this.appRoot;
    return env;
  }

  async buildFullPrompt(userText, imagePaths, agentConfig, conversationId) {
    // v3: On-demand memory — CLI queries APIs when needed via CLAUDE.md instructions
    // We only inject system prompt + user text. No more PARA/task/queue dumping.
    let prompt = "";
    if (agentConfig?.systemPrompt) prompt += agentConfig.systemPrompt + "\n\n";

    if (imagePaths && imagePaths.length > 0) {
      prompt += `The user has sent ${imagePaths.length} image(s). Read these files FIRST:\n`;
      for (const imgPath of imagePaths) prompt += `- ${imgPath.replace(/\\/g, "/")}\n`;
      prompt += `\n`;
    }

    prompt += userText;
    return prompt;
  }

  // ============================================================
  // ONE-SHOT MODE — original behavior, --print, process dies
  // ============================================================

  async sendMessage(text, imagePaths, conversationId, agentConfig, sessionId, onChunk, onComplete, onError, onActivity, onRawEvent) {
    const totalActive = this.oneShotProcesses.size + this.persistentSessions.size;
    if (totalActive >= MAX_CONCURRENT) {
      onError(new Error(`Too many concurrent conversations (max ${MAX_CONCURRENT}).`));
      return;
    }

    try {
      const prompt = await this.buildFullPrompt(text, imagePaths, agentConfig, conversationId);
      const args = this.buildOneShotArgs(agentConfig, sessionId);
      const env = this.buildEnv();
      // Resolve cwd from session file when resuming — Claude --resume requires matching project hash
      const sessionCwd = sessionId ? this._resolveSessionCwd(sessionId) : null;
      const cwd = sessionCwd || agentConfig?.workingDirectory || "C:/Users/Shubham(Code)";
      if (sessionCwd) console.log(`[OneShot] Resolved session ${sessionId.slice(0, 8)} cwd: ${sessionCwd}`);

      const activity = onActivity || (() => {});
      const rawEvent = onRawEvent || (() => {});
      activity({ type: "start", message: "Spawning Claude CLI...", timestamp: Date.now() });
      rawEvent({ type: "user_message", text: text || "", imagePaths: imagePaths || [], timestamp: Date.now() });

      const child = spawn("claude", args, { cwd, env, shell: true, stdio: ["pipe", "pipe", "pipe"] });
      this.oneShotProcesses.set(conversationId, { child, sessionId });

      // Check if stop was requested while we were setting up
      if (this.pendingStops.has(conversationId)) {
        this.pendingStops.delete(conversationId);
        this._forceKillProcess(child);
        this.oneShotProcesses.delete(conversationId);
        onError(new Error("Stopped by user"));
        return;
      }

      let stderr = "", lastSessionId = sessionId, fullResponse = "", lineBuffer = "";

      child.stdin.write(prompt);
      child.stdin.end();

      activity({ type: "status", message: "Processing...", timestamp: Date.now() });

      child.stdout.on("data", (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            rawEvent({ ...event, _ts: Date.now() });
            this.handleStreamEvent(event, onChunk, (sid) => { lastSessionId = sid; }, activity);

            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") fullResponse += block.text;
              }
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              fullResponse += event.delta.text;
              onChunk(event.delta.text);
            }
            if (event.type === "result") {
              if (event.session_id) lastSessionId = event.session_id;
              if (event.result) fullResponse = event.result;
              activity({ type: "done", message: "Task complete", timestamp: Date.now() });
            }
          } catch {}
        }
      });

      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", async (code) => {
        this.oneShotProcesses.delete(conversationId);
        if (code === 0 || fullResponse) {
          activity({ type: "done", message: "Complete", timestamp: Date.now() });
          await onComplete(fullResponse || "(no response)", lastSessionId);
        } else {
          activity({ type: "error", message: `Exited with code ${code}`, timestamp: Date.now() });
          onError(new Error(`Claude exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      child.on("error", (err) => {
        this.oneShotProcesses.delete(conversationId);
        activity({ type: "error", message: err.message, timestamp: Date.now() });
        onError(err);
      });
    } catch (err) {
      onError(err);
    }
  }

  // ============================================================
  // PERSISTENT MODE — no --print, process stays alive
  // ============================================================

  isPersistent(conversationId) {
    const s = this.persistentSessions.get(conversationId);
    return s && !s.child.killed;
  }

  async sendPersistentMessage(text, imagePaths, conversationId, agentConfig, sessionId, onChunk, onComplete, onError, onActivity, onRawEvent) {
    const activity = onActivity || (() => {});
    const rawEvent = onRawEvent || (() => {});

    rawEvent({ type: "user_message", text: text || "", imagePaths: imagePaths || [], timestamp: Date.now() });

    let session = this.persistentSessions.get(conversationId);

    // If no session or process died, spawn a new one
    if (!session || session.child.killed) {
      const totalActive = this.oneShotProcesses.size + this.persistentSessions.size;
      if (totalActive >= MAX_CONCURRENT) {
        onError(new Error(`Too many concurrent conversations (max ${MAX_CONCURRENT}).`));
        return;
      }

      activity({ type: "start", message: "Starting persistent session...", timestamp: Date.now() });

      const args = this.buildPersistentArgs(agentConfig, sessionId);
      const env = this.buildEnv();
      // Resolve cwd from session file when resuming — Claude --resume requires matching project hash
      const sessionCwd = sessionId ? this._resolveSessionCwd(sessionId) : null;
      const cwd = sessionCwd || agentConfig?.workingDirectory || "C:/Users/Shubham(Code)";
      if (sessionCwd) console.log(`[Persistent] Resolved session ${sessionId.slice(0, 8)} cwd: ${sessionCwd}`);

      console.log(`[Persistent] Spawning: claude ${args.join(" ")}`);
      const child = spawn("claude", args, { cwd, env, shell: true, stdio: ["pipe", "pipe", "pipe"] });

      session = {
        child,
        sessionId,
        busy: false,
        lineBuffer: "",
        fullResponse: "",
        busyTimer: null,
        cb: { onChunk, onComplete, onError, onActivity, onRawEvent },
      };

      // stdout handler — parses NDJSON stream events + emits raw text
      child.stdout.on("data", (chunk) => {
        const raw = chunk.toString();
        // Emit raw stdout for terminal view
        if (session.onRawStdout) session.onRawStdout(raw);

        session.lineBuffer += raw;
        const lines = session.lineBuffer.split("\n");
        session.lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            this._handlePersistentEvent(session, event, conversationId);
          } catch {}
        }
      });

      child.stderr.on("data", (chunk) => {
        const t = chunk.toString();
        if (session.onRawStdout) session.onRawStdout(t);
        // Log all stderr for debugging
        console.log(`[Persistent ${conversationId.slice(0, 8)}] STDERR: ${t.slice(0, 300)}`);
      });

      child.on("close", (code) => {
        console.log(`[Persistent] Session ${conversationId.slice(0, 8)} closed (code ${code})`);
        this.persistentSessions.delete(conversationId);
        if (session.busy) {
          session.busy = false;
          if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }
          if (session.cb.onError) session.cb.onError(new Error(`Session ended unexpectedly (code ${code})`));
        }
      });

      child.on("error", (err) => {
        console.error(`[Persistent] Session error:`, err.message);
        this.persistentSessions.delete(conversationId);
        if (session.cb.onError) session.cb.onError(err);
      });

      this.persistentSessions.set(conversationId, session);
      console.log(`[Persistent] Spawned stream-json session for ${conversationId.slice(0, 8)}`);

      // Check if stop was requested while we were spawning
      if (this.pendingStops.has(conversationId)) {
        this.pendingStops.delete(conversationId);
        this._forceKillProcess(child);
        this.persistentSessions.delete(conversationId);
        onError(new Error("Stopped by user"));
        return;
      }
    }

    if (session.busy) {
      onError(new Error("Session is busy processing another message. Please wait."));
      return;
    }

    // Swap callbacks for this message
    session.busy = true;
    session.fullResponse = "";
    session.cb = { onChunk, onComplete, onError, onActivity, onRawEvent };

    // Safety timeout (2 minutes for long tasks)
    session.busyTimer = setTimeout(() => {
      if (session.busy) {
        console.log(`[Persistent] Session ${conversationId.slice(0, 8)} timeout after 120s`);
        const response = session.fullResponse || "Response timed out after 2 minutes";
        session.busy = false;
        session.busyTimer = null;
        session.fullResponse = "";
        session.cb.onComplete(response, session.sessionId);
      }
    }, 120000);

    // Build the prompt text
    const prompt = await this.buildFullPrompt(text, imagePaths, agentConfig, conversationId);

    activity({ type: "status", message: "Processing...", timestamp: Date.now() });

    // Send as NDJSON stream-json message
    const stdinMsg = JSON.stringify({
      type: "user",
      session_id: session.sessionId || "",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    });

    try {
      session.child.stdin.write(stdinMsg + "\n");
    } catch (err) {
      session.busy = false;
      if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }
      this.persistentSessions.delete(conversationId);
      onError(new Error(`Write failed: ${err.message}. Session may have died.`));
    }
  }

  _handlePersistentEvent(session, event, conversationId) {
    const { onChunk, onActivity, onRawEvent } = session.cb;
    const rawEvent = onRawEvent || (() => {});
    const activity = onActivity || (() => {});

    rawEvent({ ...event, _ts: Date.now() });
    this.handleStreamEvent(event, onChunk, (sid) => { session.sessionId = sid; }, activity);

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text") session.fullResponse += block.text;
      }
    }

    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      session.fullResponse += event.delta.text;
      if (onChunk) onChunk(event.delta.text);
    }

    // "result" event = turn complete
    if (event.type === "result") {
      if (event.session_id) session.sessionId = event.session_id;
      if (event.result) session.fullResponse = event.result;

      if (session.busyTimer) { clearTimeout(session.busyTimer); session.busyTimer = null; }
      const response = session.fullResponse || "(no response)";
      const sid = session.sessionId;
      session.busy = false;
      session.fullResponse = "";

      activity({ type: "done", message: "Task complete", timestamp: Date.now() });
      if (session.cb.onComplete) session.cb.onComplete(response, sid);
    }
  }

  // ============================================================
  // SHARED
  // ============================================================

  handleStreamEvent(event, onChunk, onSessionId, activity) {
    const act = activity || (() => {});

    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id) onSessionId(event.session_id);
      act({ type: "status", message: "Session initialized", timestamp: Date.now() });
    }

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          let detail = "";
          if (block.input) {
            if (block.input.command) detail = block.input.command.slice(0, 80);
            else if (block.input.file_path) detail = block.input.file_path.split("/").pop();
            else if (block.input.pattern) detail = block.input.pattern;
          }
          act({ type: "tool", tool: toolName, detail, message: `Using ${toolName}${detail ? ": " + detail : ""}`, timestamp: Date.now() });
        }
      }
    }
  }

  _forceKillProcess(child) {
    const pid = child.pid;
    if (!pid) return;
    try {
      // On Windows, taskkill /T kills the entire process tree
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore", timeout: 5000 });
      console.log(`[ClaudeManager] Force killed process tree (PID ${pid})`);
    } catch {
      // Fallback
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  stopConversation(conversationId) {
    // Try one-shot
    const proc = this.oneShotProcesses.get(conversationId);
    if (proc?.child) {
      this._forceKillProcess(proc.child);
      this.oneShotProcesses.delete(conversationId);
      this.pendingStops.delete(conversationId);
      return true;
    }
    // Try persistent
    const session = this.persistentSessions.get(conversationId);
    if (session?.child) {
      if (session.busyTimer) {
        clearTimeout(session.busyTimer);
        session.busyTimer = null;
      }
      this._forceKillProcess(session.child);
      this.persistentSessions.delete(conversationId);
      this.pendingStops.delete(conversationId);
      return true;
    }
    // Process not spawned yet — mark for kill on spawn
    this.pendingStops.add(conversationId);
    console.log(`[ClaudeManager] Stop queued for ${conversationId} (process not yet spawned)`);
    setTimeout(() => this.pendingStops.delete(conversationId), 30000);
    return true;
  }

  getRunningConversations() {
    return [
      ...Array.from(this.oneShotProcesses.keys()),
      ...Array.from(this.persistentSessions.keys()).filter(id => {
        const s = this.persistentSessions.get(id);
        return s && !s.child.killed;
      }),
    ];
  }

  getPersistentConversations() {
    return Array.from(this.persistentSessions.keys()).filter(id => {
      const s = this.persistentSessions.get(id);
      return s && !s.child.killed;
    });
  }

  // --- Raw terminal access ---

  setRawStdoutListener(conversationId, listener) {
    const session = this.persistentSessions.get(conversationId);
    if (session) session.onRawStdout = listener || null;
  }

  writeRawStdin(conversationId, text) {
    const session = this.persistentSessions.get(conversationId);
    if (session?.child && !session.child.killed) {
      try {
        session.child.stdin.write(text);
        return true;
      } catch { return false; }
    }
    return false;
  }
}
