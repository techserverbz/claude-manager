import fs from "fs";
import path from "path";

const CLAUDE_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude");

export class HealthChecker {
  constructor(db, brainManager) {
    this.db = db;
    this.brainManager = brainManager;
  }

  async runAll() {
    const results = [];

    results.push(await this._checkHooksConfigured("personal"));
    results.push(await this._checkRawLogCapture("personal"));
    results.push(await this._checkSessionIdInjection("personal"));
    results.push(await this._checkJsonlExtraction("personal"));

    // Service brains
    const brains = await this.brainManager.listBrains();
    for (const brain of brains) {
      if (brain.type === "service") {
        results.push(await this._checkBrainConnectivity(brain));
        results.push(await this._checkHooksConfigured("service", brain));
        results.push(await this._checkRawLogCapture("service", brain));
        results.push(await this._checkSessionIdInjection("service", brain));
      }
    }

    results.push(await this._checkBrainsTable());

    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    const warn = results.filter(r => r.status === "warn").length;

    return { results, summary: { total: results.length, passed, failed, warn } };
  }

  async _checkHooksConfigured(scope, brain = null) {
    const check = {
      name: `Hooks configured (${scope}${brain ? ": " + brain.name : ""})`,
      category: "hooks",
      scope,
    };

    try {
      let settingsPath;
      if (scope === "personal") {
        settingsPath = path.join(CLAUDE_HOME, "settings.json");
      } else {
        settingsPath = path.join(brain.claude_path, "settings.json");
      }

      if (!fs.existsSync(settingsPath)) {
        return { ...check, status: "fail", detail: `settings.json not found at ${settingsPath}` };
      }

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const hooks = settings.hooks || {};
      const required = ["SessionStart", "Stop"];
      const optional = ["PostToolUse"];
      const missing = required.filter(h => !hooks[h] || hooks[h].length === 0);
      const hasPostTool = hooks.PostToolUse && hooks.PostToolUse.length > 0;

      if (missing.length > 0) {
        return { ...check, status: "fail", detail: `Missing hooks: ${missing.join(", ")}` };
      }
      if (!hasPostTool) {
        return { ...check, status: "warn", detail: "PostToolUse hook not configured — tool calls won't be logged to raw logs" };
      }
      return { ...check, status: "pass", detail: `All hooks configured: ${Object.keys(hooks).join(", ")}` };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkRawLogCapture(scope, brain = null) {
    const check = {
      name: `Raw log capture (${scope}${brain ? ": " + brain.name : ""})`,
      category: "rawlog",
      scope,
    };

    try {
      let wikiRaw;
      if (scope === "personal") {
        wikiRaw = path.join(CLAUDE_HOME, "wiki", "raw");
      } else {
        wikiRaw = path.join(brain.claude_path, "wiki", "raw");
      }

      if (!fs.existsSync(wikiRaw)) {
        return { ...check, status: "fail", detail: `raw/ directory not found at ${wikiRaw}` };
      }

      const files = fs.readdirSync(wikiRaw).filter(f => f.endsWith(".md")).sort().reverse();
      if (files.length === 0) {
        return { ...check, status: "warn", detail: "No raw logs yet — start a session to generate one" };
      }

      const latest = files[0];
      const latestPath = path.join(wikiRaw, latest);
      const stat = fs.statSync(latestPath);
      const ageMs = Date.now() - stat.mtime.getTime();
      const ageHours = Math.round(ageMs / 3600000);
      const content = fs.readFileSync(latestPath, "utf-8");
      const hasToolCalls = content.includes("Tool:");
      const lineCount = content.split("\n").length;

      if (ageHours > 48) {
        return { ...check, status: "warn", detail: `Latest raw log is ${ageHours}h old (${latest}). ${files.length} total logs.` };
      }

      return {
        ...check,
        status: "pass",
        detail: `Latest: ${latest} (${ageHours}h ago, ${lineCount} lines${hasToolCalls ? ", has tool calls" : ", no tool calls yet"}). ${files.length} total logs.`,
      };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkSessionIdInjection(scope, brain = null) {
    const check = {
      name: `Session ID injection (${scope}${brain ? ": " + brain.name : ""})`,
      category: "session_id",
      scope,
    };

    try {
      let wikiRaw;
      if (scope === "personal") {
        wikiRaw = path.join(CLAUDE_HOME, "wiki", "raw");
      } else {
        wikiRaw = path.join(brain.claude_path, "wiki", "raw");
      }

      if (!fs.existsSync(wikiRaw)) {
        return { ...check, status: "fail", detail: "raw/ directory not found" };
      }

      const files = fs.readdirSync(wikiRaw).filter(f => f.endsWith(".md")).sort().reverse();
      // Check last 3 raw logs for session_id
      let found = 0, checked = 0;
      for (const f of files.slice(0, 3)) {
        checked++;
        const content = fs.readFileSync(path.join(wikiRaw, f), "utf-8");
        if (content.includes("session_id:")) found++;
      }

      if (checked === 0) {
        return { ...check, status: "warn", detail: "No raw logs to check" };
      }
      if (found === 0) {
        return { ...check, status: "fail", detail: `0/${checked} recent raw logs have session_id. wiki-logger hook may not be injecting.` };
      }
      if (found < checked) {
        return { ...check, status: "warn", detail: `${found}/${checked} recent raw logs have session_id. Some sessions may have been too short.` };
      }
      return { ...check, status: "pass", detail: `${found}/${checked} recent raw logs have session_id` };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkJsonlExtraction(scope, brain = null) {
    const check = {
      name: `JSONL conversation extraction (${scope}${brain ? ": " + brain.name : ""})`,
      category: "jsonl",
      scope,
    };

    try {
      let wikiRaw;
      if (scope === "personal") {
        wikiRaw = path.join(CLAUDE_HOME, "wiki", "raw");
      } else {
        wikiRaw = path.join(brain.claude_path, "wiki", "raw");
      }

      if (!fs.existsSync(wikiRaw)) {
        return { ...check, status: "fail", detail: "raw/ directory not found" };
      }

      const files = fs.readdirSync(wikiRaw).filter(f => f.endsWith(".md")).sort().reverse();
      let found = 0, checked = 0;
      for (const f of files.slice(0, 5)) {
        checked++;
        const content = fs.readFileSync(path.join(wikiRaw, f), "utf-8");
        if (content.includes("Conversation (live)") || content.includes("Conversation (auto-extracted)")) found++;
      }

      if (checked === 0) {
        return { ...check, status: "warn", detail: "No raw logs to check" };
      }
      if (found === 0) {
        return { ...check, status: "warn", detail: `0/${checked} recent raw logs have extracted conversations. Sessions may have been too short (< 5 tool calls).` };
      }
      return { ...check, status: "pass", detail: `${found}/${checked} recent raw logs have extracted conversations` };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkWikiSync(scope) {
    const check = {
      name: "Wiki → DB sync (memory_entities)",
      category: "sync",
      scope,
    };

    try {
      const activeBrain = await this.brainManager.getActiveBrain();
      if (!activeBrain) {
        return { ...check, status: "fail", detail: "No active brain" };
      }

      const { rows } = await this.db.query(
        "SELECT COUNT(*)::int AS count FROM memory_entities WHERE brain_id = $1",
        [activeBrain.id]
      );
      const count = rows[0]?.count || 0;

      if (count === 0) {
        return { ...check, status: "warn", detail: "No memory_entities for active brain. Run POST /api/memory/sync." };
      }
      return { ...check, status: "pass", detail: `${count} entities synced for ${activeBrain.name}` };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkBrainConnectivity(brain) {
    const check = {
      name: `Brain path accessible: ${brain.name}`,
      category: "brain",
      scope: "service",
    };

    try {
      if (!fs.existsSync(brain.claude_path)) {
        return { ...check, status: "fail", detail: `Path not accessible: ${brain.claude_path}` };
      }
      const wikiExists = fs.existsSync(path.join(brain.claude_path, "wiki"));
      const skillsExists = fs.existsSync(path.join(brain.claude_path, "skills"));
      const hooksExists = fs.existsSync(path.join(brain.claude_path, "hooks"));

      const parts = [];
      parts.push(wikiExists ? "wiki ✓" : "wiki ✗");
      parts.push(skillsExists ? "skills ✓" : "skills ✗");
      parts.push(hooksExists ? "hooks ✓" : "hooks ✗");

      if (!wikiExists) {
        return { ...check, status: "fail", detail: `Path exists but no wiki/. ${parts.join(", ")}` };
      }
      return { ...check, status: "pass", detail: parts.join(", ") };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkMemoryEntities() {
    const check = {
      name: "Memory entities DB table",
      category: "db",
      scope: "global",
    };

    try {
      const { rows } = await this.db.query("SELECT COUNT(*)::int AS count FROM memory_entities");
      const total = rows[0]?.count || 0;
      const { rows: brainRows } = await this.db.query(
        "SELECT COUNT(*)::int AS count FROM memory_entities WHERE brain_id IS NOT NULL"
      );
      const withBrain = brainRows[0]?.count || 0;

      return {
        ...check,
        status: total > 0 ? "pass" : "warn",
        detail: `${total} total entities (${withBrain} with brain_id, ${total - withBrain} legacy)`,
      };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }

  async _checkBrainsTable() {
    const check = {
      name: "Brains registry",
      category: "db",
      scope: "global",
    };

    try {
      const brains = await this.brainManager.listBrains();
      const active = brains.find(b => b.is_active);
      const services = brains.filter(b => b.type === "service");

      return {
        ...check,
        status: brains.length > 0 ? "pass" : "fail",
        detail: `${brains.length} brain(s): ${active?.name || "none"} active, ${services.length} service(s)`,
      };
    } catch (err) {
      return { ...check, status: "fail", detail: err.message };
    }
  }
}
