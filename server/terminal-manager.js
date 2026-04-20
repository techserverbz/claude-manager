import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { SessionTailer } from "./session-tailer.js";

const CHRISTOPHER_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher");

// Nesting guard vars to strip
const CLAUDE_NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
];

const MAX_CONCURRENT = 5;
const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");

// Find the original working directory of a session by reading the cwd field from the session file.
// DOES NOT check fs.existsSync on the cwd — Drive paths may not be materialized yet but Claude
// still needs the correct hash. If the path truly doesn't exist, let Claude produce the error
// instead of silently falling back to the wrong directory (which causes "session not found" forever).
function findSessionCwd(sessionId) {
  if (!sessionId || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const fd = fs.openSync(jsonlPath, "r");
        const buf = Buffer.alloc(4096);
        fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const chunk = buf.toString("utf-8");
        const lines = chunk.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.cwd) return evt.cwd; // trust the stored cwd — no existence check
          } catch {}
        }
        return null;
      }
    }
  } catch {}
  return null;
}

// Strip ANSI escape codes from terminal output
function stripAnsi(str) {
  return str
    // Standard CSI sequences: ESC [ ... letter
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // OSC sequences: ESC ] ... BEL or ESC ] ... ESC\
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // DEC private modes: ESC [ ? digits h/l
    .replace(/\x1b\[\?[0-9;]*[hl]/g, "")
    // Any remaining ESC sequences
    .replace(/\x1b[^[]*?[a-zA-Z]/g, "")
    // Control chars (keep \n \r)
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "")
    // Carriage returns
    .replace(/\r/g, "");
}

function cleanResponseText(raw) {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n").map(l => l.trim()).filter(Boolean);
  const cleaned = [];
  let skip = false;

  for (const line of lines) {
    // Skip TUI chrome
    if (line.match(/^[─━═╔╗╚╝║▐▛▜▝▘│┌┐└┘├┤┬┴┼⏵●✻✽✶✢·*]+$/)) continue;
    if (line.match(/^[─]+$/)) continue;
    // Skip prompts
    if (line.match(/^>\s*$/) || line.match(/^>\s.{0,3}$/)) continue;
    // Skip Claude TUI noise
    if (line.includes("bypass permissions")) continue;
    if (line.includes("shift+tab")) continue;
    if (line.includes("esc to interrupt")) continue;
    if (line.includes("Press up to edit")) continue;
    if (line.includes("Bootstrapping")) continue;
    if (line.includes("Cerebrating") || line.includes("Thinking")) continue;
    if (line.includes("trust this folder")) continue;
    if (line.includes("clau.de/desktop")) continue;
    if (line.match(/^Tip:/)) continue;
    if (line.match(/^Claude Code v/i)) continue;
    if (line.match(/^ClaudeCode/)) continue;
    if (line.match(/^Opus|^Sonnet|^Haiku/)) continue;
    if (line.match(/^C:\\/) && line.length < 40) continue;
    if (line.startsWith("[") && line.endsWith("]")) continue;
    if (line.match(/^\* /)) continue;
    // Skip spinner characters only
    if (line.match(/^[✻✽✶✢·●*⎿]+\s*$/)) continue;
    if (line.match(/^[✻✽✶✢·●*]\s*(Bootstrapping|Thinking|Processing)/)) continue;
    // Skip tool output blocks
    if (line.match(/^(Read|Write|Edit|Bash|Grep|Glob|Agent|WebSearch|WebFetch|Skill|TodoWrite)\s/)) { skip = true; continue; }
    if (skip && (line.startsWith("  ") || line.startsWith("\t"))) continue;
    skip = false;
    // Skip very short garbage
    if (line.length < 2) continue;

    cleaned.push(line);
  }

  return cleaned.join(" ").replace(/\s+/g, " ").trim();
}

export class TerminalManager {
  constructor(appRoot, db) {
    this.appRoot = appRoot;
    this.db = db;
    this.terminals = new Map(); // conversationId -> { pty, mode, pid }
    this.assignedSessionIds = new Set(); // session IDs already claimed by a conversation
    this.mcpConfigPath = path.join(CHRISTOPHER_HOME, "config", "mcp-config.json");
    if (!fs.existsSync(this.mcpConfigPath)) {
      this.mcpConfigPath = path.join(CHRISTOPHER_HOME, "config", "mcp-config.json");
    }
  }

  _buildEnv() {
    const env = { ...process.env };
    for (const key of CLAUDE_NESTING_VARS) delete env[key];
    env.CHRISTOPHER_APP_ROOT = this.appRoot;
    return env;
  }

  _buildClaudeArgs(config, mode) {
    const args = [];
    if (config?.skipPermissions !== false) args.push("--dangerously-skip-permissions");
    if (config?.model) args.push("--model", config.model);
    if (config?.maxTurns) args.push("--max-turns", String(config.maxTurns));
    if (config?.sessionId) args.push("--resume", config.sessionId);
    args.push("--add-dir", this.appRoot);
    if (config?.addDirs) {
      for (const dir of config.addDirs) {
        args.push("--add-dir", dir);
      }
    }
    if (fs.existsSync(this.mcpConfigPath)) {
      args.push("--mcp-config", this.mcpConfigPath);
    }
    return args;
  }

  async createTerminal(conversationId, { mode, config, cols, rows, onOutput, onExit, onResponse, onMessage }) {
    if (this.terminals.has(conversationId)) {
      throw new Error("Terminal already exists for this conversation");
    }

    // Lazy-load node-pty (native module)
    const pty = await import("node-pty");

    const env = this._buildEnv();
    // When resuming a session, use the original working directory where the session was created
    let cwd = config?.workingDirectory || process.env.USERPROFILE || "C:/Users/Shubham(Code)";
    if (config?.sessionId) {
      const sessionCwd = findSessionCwd(config.sessionId);
      if (sessionCwd) {
        cwd = sessionCwd;
        console.log(`[Terminal] Resolved session ${config.sessionId.slice(0, 8)} cwd: ${cwd}`);
      }
    }

    // Find Git Bash
    const bashPaths = [
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/bin/bash.exe",
    ];
    const shell = bashPaths.find(p => fs.existsSync(p)) || "bash.exe";

    // Build the claude command to run inside bash
    const claudeArgs = this._buildClaudeArgs(config, mode);
    // Shell-quote each arg to handle paths with spaces/parens
    const quotedArgs = claudeArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`);
    let claudeCmd;

    if (mode === "terminal-oneshot" && config?.initialMessage) {
      const escapedMsg = config.initialMessage.replace(/'/g, "'\\''");
      claudeCmd = `claude -p '${escapedMsg}' --print ${quotedArgs.join(" ")}; echo ""; echo "[Process exited. Press any key to close.]"; read -n 1`;
    } else {
      claudeCmd = `claude ${quotedArgs.join(" ")}`;
    }

    const ptyProcess = pty.default.spawn(shell, ["-l", "-c", claudeCmd], {
      name: "xterm-256color",
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env,
    });

    const terminal = {
      pty: ptyProcess,
      mode,
      pid: ptyProcess.pid,
      config,
      outputBuffer: "",
      sessionTailer: null,
    };

    // Stream raw output to frontend (xterm display)
    const MAX_BUFFER = 50000; // keep last 50KB of output
    ptyProcess.onData((data) => {
      terminal.outputBuffer += data;
      if (terminal.outputBuffer.length > MAX_BUFFER) {
        terminal.outputBuffer = terminal.outputBuffer.slice(-MAX_BUFFER);
      }
      if (onOutput) onOutput(data);
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[Terminal] ${conversationId.slice(0, 8)} exited (code=${exitCode}, signal=${signal})`);
      if (terminal.sessionTailer) {
        terminal.sessionTailer.stop();
        terminal.sessionTailer = null;
      }
      this.terminals.delete(conversationId);
      if (onExit) onExit(exitCode);
    });

    terminal.spawnedAt = Date.now();
    terminal.cwd = cwd;
    terminal.trustAccepted = false;
    this.terminals.set(conversationId, terminal);

    // Auto-accept workspace trust dialog by watching output (strip ANSI before matching)
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0e-\x1f]/g, "");
    const trustCheck = setInterval(() => {
      if (terminal.trustAccepted) { clearInterval(trustCheck); return; }
      const recent = stripAnsi(terminal.outputBuffer.slice(-3000));
      if (recent.includes("trust") && (recent.includes("Yes") || recent.includes("folder"))) {
        console.log(`[Terminal] Auto-accepting trust dialog for ${conversationId.slice(0, 8)}`);
        ptyProcess.write("\r");
        terminal.trustAccepted = true;
        clearInterval(trustCheck);
      }
    }, 500);
    // Stop checking after 15 seconds
    setTimeout(() => { clearInterval(trustCheck); terminal.trustAccepted = true; }, 15000);
    console.log(`[Terminal] Created ${mode} terminal for ${conversationId.slice(0, 8)} (PID ${ptyProcess.pid})`);

    return { pid: ptyProcess.pid };
  }

  writeToTerminal(conversationId, data) {
    const terminal = this.terminals.get(conversationId);
    if (terminal?.pty) {
      terminal.pty.write(data);
      return true;
    }
    return false;
  }

  resizeTerminal(conversationId, cols, rows) {
    const terminal = this.terminals.get(conversationId);
    if (terminal?.pty) {
      terminal.pty.resize(cols, rows);
      return true;
    }
    return false;
  }

  destroyTerminal(conversationId) {
    const terminal = this.terminals.get(conversationId);
    if (terminal?.pty) {
      // Stop session tailer if attached
      if (terminal.sessionTailer) {
        terminal.sessionTailer.stop();
        terminal.sessionTailer = null;
      }
      try {
        const pid = terminal.pty.pid;
        if (pid) {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore", timeout: 5000 });
        }
      } catch {
        try { terminal.pty.kill(); } catch {}
      }
      this.terminals.delete(conversationId);
      console.log(`[Terminal] Destroyed terminal for ${conversationId.slice(0, 8)}`);
      return true;
    }
    return false;
  }

  getTerminal(conversationId) {
    return this.terminals.get(conversationId) || null;
  }

  getActiveCount() {
    return this.terminals.size;
  }

  getActiveTerminals() {
    return Array.from(this.terminals.keys());
  }

  listTerminals() {
    return Array.from(this.terminals.entries()).map(([id, t]) => ({
      conversationId: id,
      pid: t.pid || null,
      mode: t.mode || null,
      hasPty: !!t.pty,
    }));
  }

  // Get the last N chars of terminal output (with ANSI stripped for readability)
  getScreenContent(conversationId, lastChars = 2000) {
    const terminal = this.terminals.get(conversationId);
    if (!terminal) return null;
    const raw = terminal.outputBuffer.slice(-lastChars);
    // Strip ANSI escape codes
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0e-\x1f]/g, "");
    return { raw: raw.slice(-lastChars), clean, bufferSize: terminal.outputBuffer.length };
  }

  /**
   * Attach a SessionTailer to read clean messages from Claude Code's session JSONL.
   * @param {string} conversationId
   * @param {string} sessionId - Claude Code session ID
   * @param {Function} onMessage - (role, content, timestamp) callback
   * @param {boolean} startFromEnd - if true, only capture new messages (for resumed sessions)
   */
  attachSessionTailer(conversationId, sessionId, onMessage, startFromEnd = false) {
    const terminal = this.terminals.get(conversationId);
    if (!terminal) return;

    // Stop existing tailer if any
    if (terminal.sessionTailer) {
      terminal.sessionTailer.stop();
    }

    const tailer = new SessionTailer(sessionId, onMessage);
    tailer.start(startFromEnd);
    terminal.sessionTailer = tailer;
  }

  // Detect the Claude CLI session ID by finding the newest .jsonl across all project dirs
  // Excludes session IDs already assigned to other conversations
  detectSessionId(conversationId) {
    const terminal = this.terminals.get(conversationId);
    if (!terminal) return null;

    const projectsDir = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return null;

    // Collect all candidates sorted by time (newest first)
    const candidates = [];

    try {
      const projects = fs.readdirSync(projectsDir);
      for (const proj of projects) {
        const projDir = path.join(projectsDir, proj);
        try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }
        const files = fs.readdirSync(projDir).filter(f => f.endsWith(".jsonl") && /^[a-f0-9-]{36}\.jsonl$/.test(f));
        for (const f of files) {
          try {
            const mtime = fs.statSync(path.join(projDir, f)).mtimeMs;
            if (mtime > terminal.spawnedAt - 2000) {
              candidates.push({ id: f.replace(".jsonl", ""), mtime });
            }
          } catch {}
        }
      }
    } catch {}

    if (candidates.length === 0) {
      console.log(`[Terminal] No session files found after spawn for ${conversationId.slice(0, 8)}`);
    }

    // Sort newest first, pick the first one not already assigned
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      if (!this.assignedSessionIds.has(c.id)) {
        this.assignedSessionIds.add(c.id);
        return c.id;
      }
    }

    return null;
  }
}
