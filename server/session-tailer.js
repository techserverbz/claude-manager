import fs from "fs";
import path from "path";

const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");

/**
 * Tails a Claude Code session JSONL file and extracts clean user/assistant messages.
 * Replaces the terminal-scraping approach with structured data from the source of truth.
 */
export class SessionTailer {
  constructor(sessionId, onMessage) {
    this.sessionId = sessionId;
    this.onMessage = onMessage;
    this.filePath = null;
    this.byteOffset = 0;
    this.lineBuffer = "";
    this.processedUuids = new Set();
    this.watching = false;
    this.findRetryTimer = null;
  }

  /**
   * Find the session JSONL file across all project directories.
   */
  _findFile() {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
    try {
      const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, dir, `${this.sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath)) return jsonlPath;
      }
    } catch {}
    return null;
  }

  /**
   * Start tailing. If startFromEnd=true, only capture new messages (for resumed sessions).
   */
  start(startFromEnd = false) {
    this.filePath = this._findFile();

    if (!this.filePath) {
      // File doesn't exist yet — poll every 2s until it appears
      console.log(`[SessionTailer] Session file not found yet for ${this.sessionId.slice(0, 8)}, polling...`);
      this.findRetryTimer = setInterval(() => {
        this.filePath = this._findFile();
        if (this.filePath) {
          clearInterval(this.findRetryTimer);
          this.findRetryTimer = null;
          this._startWatching(startFromEnd);
        }
      }, 2000);
      return;
    }

    this._startWatching(startFromEnd);
  }

  _startWatching(startFromEnd) {
    if (startFromEnd) {
      try {
        this.byteOffset = fs.statSync(this.filePath).size;
      } catch {
        this.byteOffset = 0;
      }
    }

    console.log(`[SessionTailer] Tailing ${this.sessionId.slice(0, 8)} from byte ${this.byteOffset}`);

    // Read any existing content first (catches messages from before detection)
    this._readNewLines();

    // Watch for appends
    this.watching = true;
    fs.watchFile(this.filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.size > this.byteOffset) {
        this._readNewLines();
      }
    });
  }

  _readNewLines() {
    if (!this.filePath) return;

    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch { return; }

    if (stat.size <= this.byteOffset) return;

    const bytesToRead = stat.size - this.byteOffset;
    const buffer = Buffer.alloc(bytesToRead);

    let fd;
    try {
      fd = fs.openSync(this.filePath, "r");
      fs.readSync(fd, buffer, 0, bytesToRead, this.byteOffset);
      fs.closeSync(fd);
    } catch (err) {
      if (fd) try { fs.closeSync(fd); } catch {}
      return;
    }

    this.byteOffset = stat.size;

    const chunk = buffer.toString("utf-8");
    this.lineBuffer += chunk;

    const lines = this.lineBuffer.split("\n");
    // Last element is either empty (line ended with \n) or a partial line
    this.lineBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        this._processEvent(event);
      } catch {}
    }
  }

  _processEvent(event) {
    // Dedup by UUID
    if (event.uuid) {
      if (this.processedUuids.has(event.uuid)) return;
      this.processedUuids.add(event.uuid);
    }

    const timestamp = event.timestamp || new Date().toISOString();

    // User messages
    if (event.type === "human" || event.type === "user") {
      const content = event.message?.content;

      // Only capture string content (actual user input)
      // Skip array content (tool_result responses) and system/command messages
      if (typeof content === "string" && content.length > 0) {
        // Skip internal command messages
        if (content.startsWith("<local-command") || content.startsWith("<command-name")) return;
        // Skip system-reminder only messages
        if (content.startsWith("<system-reminder>") && !content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()) return;

        // Strip system-reminder tags from user messages that contain actual text
        let cleanContent = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (!cleanContent) return;

        this.onMessage("user", cleanContent, timestamp);
      }
    }

    // Assistant messages — only final responses (end_turn), not tool-calling turns
    if (event.type === "assistant") {
      const stopReason = event.message?.stop_reason;
      if (stopReason !== "end_turn") return;

      const blocks = event.message?.content;
      if (!Array.isArray(blocks)) return;

      const textParts = blocks
        .filter(b => b.type === "text")
        .map(b => b.text)
        .filter(Boolean);

      const fullText = textParts.join("\n");
      if (fullText.length > 0) {
        this.onMessage("assistant", fullText, timestamp);
      }
    }
  }

  stop() {
    if (this.findRetryTimer) {
      clearInterval(this.findRetryTimer);
      this.findRetryTimer = null;
    }
    if (this.filePath && this.watching) {
      fs.unwatchFile(this.filePath);
      this.watching = false;
    }
    console.log(`[SessionTailer] Stopped tailing ${this.sessionId.slice(0, 8)}`);
  }
}
