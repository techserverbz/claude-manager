import fs from "fs";
import path from "path";
import readline from "readline";

const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "projects");

export class SessionReader {
  constructor() {
    this.projectsDir = CLAUDE_PROJECTS_DIR;
  }

  // Find the JSONL file for a given session ID across all project directories
  findSessionFile(sessionId) {
    if (!fs.existsSync(this.projectsDir)) return null;

    const projectDirs = fs.readdirSync(this.projectsDir).filter(d => {
      return fs.statSync(path.join(this.projectsDir, d)).isDirectory();
    });

    let bestPath = null;
    let bestSize = -1;
    for (const dir of projectDirs) {
      const jsonlPath = path.join(this.projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const size = fs.statSync(jsonlPath).size;
        if (size > bestSize) {
          bestSize = size;
          bestPath = jsonlPath;
        }
      }
    }

    return bestPath;
  }

  // Read and parse a session JSONL file, returning all events
  async readSession(sessionId) {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return null;

    const events = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {}
    }

    return events;
  }

  // Get a summary of a session (first/last event, message count)
  async getSessionSummary(sessionId) {
    const events = await this.readSession(sessionId);
    if (!events || events.length === 0) return null;

    let userMessages = 0;
    let assistantMessages = 0;

    for (const event of events) {
      if (event.type === "user" || event.type === "queue-operation") userMessages++;
      if (event.type === "assistant" || event.type === "result") assistantMessages++;
    }

    return {
      sessionId,
      eventCount: events.length,
      userMessages,
      assistantMessages,
      firstEvent: events[0],
      lastEvent: events[events.length - 1],
    };
  }

  // List ALL sessions across ALL projects on this computer
  listAllSessions({ limit = 50 } = {}) {
    if (!fs.existsSync(this.projectsDir)) return [];

    const allSessions = [];
    const projectDirs = fs.readdirSync(this.projectsDir).filter(d => {
      const p = path.join(this.projectsDir, d);
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });

    for (const dir of projectDirs) {
      const dirPath = path.join(this.projectsDir, dir);
      let files;
      try { files = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

      for (const f of files) {
        const fullPath = path.join(dirPath, f);
        try {
          const stat = fs.statSync(fullPath);
          // Decode project path from directory name
          const projectPath = dir.replace(/--/g, ":\\").replace(/-/g, "/");
          allSessions.push({
            sessionId: f.replace(".jsonl", ""),
            project: dir,
            projectPath,
            size: stat.size,
            modified: stat.mtime,
            sizeKb: Math.round(stat.size / 1024),
          });
        } catch {}
      }
    }

    // Sort by modified time, most recent first
    allSessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return allSessions.slice(0, limit);
  }

  // List all sessions for a given project path hash
  listSessions(projectPathHash) {
    const projectDir = path.join(this.projectsDir, projectPathHash);
    if (!fs.existsSync(projectDir)) return [];

    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({
        sessionId: f.replace(".jsonl", ""),
        path: path.join(projectDir, f),
        size: fs.statSync(path.join(projectDir, f)).size,
        modified: fs.statSync(path.join(projectDir, f)).mtime,
      }))
      .sort((a, b) => b.modified - a.modified);
  }
}
