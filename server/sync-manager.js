import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";

const CLAUDE_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude");
const GITHUB_API = "https://api.github.com";

const REPOS = {
  "claude-manager": {
    owner: "techserverbz",
    repo: "claude-manager",
    label: "Claude Manager",
    description: "Web-based manager for Claude Code CLI sessions",
  },
  "karpathy-personal": {
    owner: "techserverbz",
    repo: "karpathy-brain-personal",
    label: "Karpathy Brain — Personal",
    description: "Self-building wiki for solo Claude Code users",
    clonePath: () => path.join(CLAUDE_HOME, "wiki", "karpathy-brain"),
    installCmd: (clonePath) => `cd "${clonePath}" && "C:/Program Files/Git/bin/bash.exe" install.sh`,
  },
  "karpathy-services": {
    owner: "techserverbz",
    repo: "karpathy-brain-services",
    label: "Karpathy Brain — Services",
    description: "Team wiki with skills/candidate tiers",
    // Clone path is flexible — stored per-service in brain registry
  },
};

export class SyncManager {
  constructor(appRoot, db) {
    this.appRoot = appRoot;
    this.db = db;
  }

  // --- Status: what's installed and which version ---

  async getStatus() {
    const results = {};

    // Claude Manager — it IS this running app. Check its own git state.
    results["claude-manager"] = await this._getClaudeManagerStatus();

    // Karpathy Personal — check the clone at ~/.claude/wiki/karpathy-brain/
    results["karpathy-personal"] = await this._getKarpathyPersonalStatus();

    // Karpathy Services — check sync logs from registered service brains
    results["karpathy-services"] = await this._getKarpathyServicesStatus();

    return results;
  }

  async _getClaudeManagerStatus() {
    const info = { ...REPOS["claude-manager"], target: "claude-manager" };
    try {
      const gitDir = path.join(this.appRoot, ".git");
      if (!fs.existsSync(gitDir)) {
        return { ...info, installed: false, note: "Not a git repo — installed via copy" };
      }
      const commit = execSync("git rev-parse HEAD", { cwd: this.appRoot, encoding: "utf-8" }).trim();
      const commitDate = execSync("git log -1 --format=%cI", { cwd: this.appRoot, encoding: "utf-8" }).trim();
      const commitMsg = execSync("git log -1 --format=%s", { cwd: this.appRoot, encoding: "utf-8" }).trim();
      const remote = execSync("git config --get remote.origin.url", { cwd: this.appRoot, encoding: "utf-8" }).trim();
      return {
        ...info,
        installed: true,
        commit: commit.slice(0, 7),
        commitFull: commit,
        commitDate,
        commitMessage: commitMsg,
        remote,
        path: this.appRoot,
      };
    } catch (err) {
      return { ...info, installed: true, error: err.message, path: this.appRoot };
    }
  }

  async _getKarpathyPersonalStatus() {
    const info = { ...REPOS["karpathy-personal"], target: "karpathy-personal" };
    const clonePath = REPOS["karpathy-personal"].clonePath();
    const wikiRoot = path.join(CLAUDE_HOME, "wiki");
    const claudePath = CLAUDE_HOME;

    // Common wiki stats (always computed)
    let wikiStats = {};
    const wikiPagesDir = path.join(wikiRoot, "wiki");
    if (fs.existsSync(wikiPagesDir)) {
      try {
        wikiStats.pageCategories = fs.readdirSync(wikiPagesDir).filter(d => {
          try { return fs.statSync(path.join(wikiPagesDir, d)).isDirectory(); } catch { return false; }
        }).length;
      } catch {}
      try {
        const rawDir = path.join(wikiRoot, "raw");
        wikiStats.rawLogs = fs.existsSync(rawDir)
          ? fs.readdirSync(rawDir).filter(f => f.endsWith(".md")).length : 0;
      } catch {}
      wikiStats.wikiActive = true;
    }

    // Check sync log first (survives .git deletion)
    const syncLog = path.join(wikiRoot, "_state", "karpathy_sync.json");
    if (fs.existsSync(syncLog)) {
      try {
        const log = JSON.parse(fs.readFileSync(syncLog, "utf-8"));
        return {
          ...info,
          installed: true,
          commit: log.git_commit_short || log.git_commit?.slice(0, 7),
          commitFull: log.git_commit,
          commitDate: log.git_commit_date,
          commitMessage: log.git_commit_message,
          installedAt: log.installed_at,
          installedBy: log.installed_by,
          remote: log.git_remote,
          clonePath,
          wikiPath: wikiRoot,
          claudePath,
          syncLogPath: syncLog,
          hasClone: fs.existsSync(path.join(clonePath, ".git")),
          ...wikiStats,
        };
      } catch {}
    }

    // No sync log — check if clone exists
    if (fs.existsSync(path.join(clonePath, ".git"))) {
      try {
        const commit = execSync("git rev-parse HEAD", { cwd: clonePath, encoding: "utf-8" }).trim();
        return {
          ...info,
          installed: true,
          commit: commit.slice(0, 7),
          commitFull: commit,
          clonePath,
          wikiPath: wikiRoot,
          claudePath,
          hasClone: true,
          note: "No sync log — run install.sh to create one",
          ...wikiStats,
        };
      } catch {}
    }

    // No clone and no sync log — but check if the wiki structure itself exists
    // (user may have set it up manually via hooks, not via install.sh)
    const wikiRoot = path.join(CLAUDE_HOME, "wiki");
    const wikiPagesDir = path.join(wikiRoot, "wiki");
    if (fs.existsSync(wikiPagesDir)) {
      try {
        const categories = fs.readdirSync(wikiPagesDir).filter(d => {
          try { return fs.statSync(path.join(wikiPagesDir, d)).isDirectory(); } catch { return false; }
        });
        const rawCount = fs.existsSync(path.join(wikiRoot, "raw"))
          ? fs.readdirSync(path.join(wikiRoot, "raw")).filter(f => f.endsWith(".md")).length
          : 0;
        return {
          ...info,
          installed: true,
          commit: null,
          clonePath,
          wikiPath: wikiRoot,
          hasClone: false,
          wikiActive: true,
          pageCategories: categories.length,
          rawLogs: rawCount,
          note: "Wiki is active (set up manually). Click Install to connect to GitHub for sync tracking + updates.",
        };
      } catch {}
    }

    return { ...info, installed: false, clonePath, wikiPath: wikiRoot };
  }

  async _getKarpathyServicesStatus() {
    const info = { ...REPOS["karpathy-services"], target: "karpathy-services" };

    // Check registered service brains from DB
    let brains = [];
    try {
      const { rows } = await this.db.query(
        "SELECT name, claude_path FROM brains WHERE type = 'service' ORDER BY created_at"
      );
      brains = rows;
    } catch {}

    const services = [];
    for (const brain of brains) {
      const wikiRoot = path.join(brain.claude_path, "wiki");
      const wikiPagesDir = path.join(wikiRoot, "wiki");
      const syncLog = path.join(wikiRoot, "_state", "karpathy_sync.json");

      const svc = {
        name: brain.name,
        claudePath: brain.claude_path,
        wikiPath: wikiRoot,
      };

      // Count wiki data
      if (fs.existsSync(wikiPagesDir)) {
        try {
          svc.pageCategories = fs.readdirSync(wikiPagesDir).filter(d => {
            try { return fs.statSync(path.join(wikiPagesDir, d)).isDirectory(); } catch { return false; }
          }).length;
        } catch {}
        try {
          const rawDir = path.join(wikiRoot, "raw");
          svc.rawLogs = fs.existsSync(rawDir)
            ? fs.readdirSync(rawDir).filter(f => f.endsWith(".md")).length
            : 0;
        } catch {}
        svc.wikiActive = true;
      }

      // Sync log
      if (fs.existsSync(syncLog)) {
        try {
          const log = JSON.parse(fs.readFileSync(syncLog, "utf-8"));
          svc.commit = log.git_commit_short || log.git_commit?.slice(0, 7);
          svc.commitDate = log.git_commit_date;
          svc.commitMessage = log.git_commit_message;
          svc.installedAt = log.installed_at;
          svc.installedBy = log.installed_by;
        } catch {
          svc.note = "sync log unreadable";
        }
      } else {
        svc.commit = null;
        svc.note = svc.wikiActive ? "Wiki active but no sync log — click Install to connect" : "no sync log";
      }

      services.push(svc);
    }

    return { ...info, installed: services.length > 0, services };
  }

  // --- Check: compare local version with GitHub latest ---

  async checkForUpdates(target) {
    const repoKey = target === "karpathy-services" ? "karpathy-services" : target;
    const repoInfo = REPOS[repoKey];
    if (!repoInfo) throw new Error(`Unknown target: ${target}`);

    // Fetch latest commit from GitHub
    const latest = await this._fetchLatestCommit(repoInfo.owner, repoInfo.repo);
    if (!latest) throw new Error("Failed to fetch latest commit from GitHub");

    // Get local status
    const status = (await this.getStatus())[target];
    const localCommit = status?.commitFull || status?.commit || null;

    const isUpToDate = localCommit && latest.sha.startsWith(localCommit.replace(/\.\.\.$/, ""));

    return {
      target,
      local: {
        commit: status?.commit || null,
        commitDate: status?.commitDate || null,
        commitMessage: status?.commitMessage || null,
        installed: status?.installed || false,
      },
      remote: {
        commit: latest.sha.slice(0, 7),
        commitFull: latest.sha,
        commitDate: latest.date,
        commitMessage: latest.message,
      },
      upToDate: isUpToDate,
      behind: !isUpToDate,
    };
  }

  async _fetchLatestCommit(owner, repo) {
    try {
      const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=1`;
      const res = await fetch(url, {
        headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "claude-manager" },
      });
      if (!res.ok) return null;
      const [commit] = await res.json();
      return {
        sha: commit.sha,
        date: commit.commit.committer.date,
        message: commit.commit.message.split("\n")[0],
        author: commit.commit.author.name,
      };
    } catch {
      return null;
    }
  }

  // --- Install / Update ---

  async install(target, options = {}) {
    switch (target) {
      case "claude-manager":
        return this._updateClaudeManager();
      case "karpathy-personal":
        return this._installOrUpdateKarpathyPersonal();
      case "karpathy-services":
        return this._installOrUpdateKarpathyServices(options);
      default:
        throw new Error(`Unknown target: ${target}`);
    }
  }

  async _updateClaudeManager() {
    try {
      const gitDir = path.join(this.appRoot, ".git");
      if (!fs.existsSync(gitDir)) {
        throw new Error("Claude Manager is not a git repo — cannot auto-update. Clone it first.");
      }

      const pullOutput = execSync("git pull origin master", {
        cwd: this.appRoot,
        encoding: "utf-8",
        timeout: 30000,
      }).trim();

      // Check if package.json changed (needs npm install)
      let npmOutput = "";
      if (pullOutput.includes("package.json") || pullOutput.includes("package-lock.json")) {
        npmOutput = execSync("npm install --production", {
          cwd: this.appRoot,
          encoding: "utf-8",
          timeout: 120000,
        }).trim();
      }

      // Rebuild frontend
      let buildOutput = "";
      try {
        buildOutput = execSync("npm run build", {
          cwd: this.appRoot,
          encoding: "utf-8",
          timeout: 60000,
        }).trim();
      } catch (e) {
        buildOutput = `Build warning: ${e.message}`;
      }

      const commit = execSync("git rev-parse --short HEAD", { cwd: this.appRoot, encoding: "utf-8" }).trim();

      return {
        success: true,
        commit,
        pullOutput: pullOutput.slice(0, 500),
        npmOutput: npmOutput.slice(0, 300),
        buildOutput: buildOutput.slice(-200),
        note: "Restart Christopher to apply server-side changes.",
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _installOrUpdateKarpathyPersonal() {
    const clonePath = REPOS["karpathy-personal"].clonePath();
    const repoUrl = `https://github.com/${REPOS["karpathy-personal"].owner}/${REPOS["karpathy-personal"].repo}.git`;

    try {
      if (fs.existsSync(path.join(clonePath, ".git"))) {
        // Update: git pull + run install.sh
        const pullOutput = execSync("git pull", { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();
        const installOutput = execSync("\"C:/Program Files/Git/bin/bash.exe\" install.sh", { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();
        const commit = execSync("git rev-parse --short HEAD", { cwd: clonePath, encoding: "utf-8" }).trim();

        return {
          success: true,
          action: "updated",
          commit,
          pullOutput: pullOutput.slice(0, 500),
          installOutput: installOutput.slice(-500),
        };
      } else {
        // Fresh install: clone + run install.sh
        const wikiDir = path.join(CLAUDE_HOME, "wiki");
        fs.mkdirSync(wikiDir, { recursive: true });
        const cloneOutput = execSync(
          `git clone "${repoUrl}" "${path.basename(clonePath)}"`,
          { cwd: wikiDir, encoding: "utf-8", timeout: 60000 }
        ).trim();
        const installOutput = execSync("\"C:/Program Files/Git/bin/bash.exe\" install.sh", { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();
        const commit = execSync("git rev-parse --short HEAD", { cwd: clonePath, encoding: "utf-8" }).trim();

        return {
          success: true,
          action: "installed",
          commit,
          cloneOutput: cloneOutput.slice(0, 300),
          installOutput: installOutput.slice(-500),
        };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _installOrUpdateKarpathyServices(options = {}) {
    const { servicePath, clonePath: customClonePath } = options;
    const repoUrl = `https://github.com/${REPOS["karpathy-services"].owner}/${REPOS["karpathy-services"].repo}.git`;

    // We need to know where the clone lives + where to install
    // If no servicePath given, just update the clone
    const defaultClone = path.join(process.env.USERPROFILE || process.env.HOME, "Desktop", "Github", "karpathy-brain-services");
    const clonePath = customClonePath || defaultClone;

    try {
      if (fs.existsSync(path.join(clonePath, ".git"))) {
        // Update clone
        const pullOutput = execSync("git pull", { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();

        // If servicePath given, run install.sh
        let installOutput = "";
        if (servicePath) {
          installOutput = execSync(`"C:/Program Files/Git/bin/bash.exe" install.sh "${servicePath}"`, { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();
        }

        const commit = execSync("git rev-parse --short HEAD", { cwd: clonePath, encoding: "utf-8" }).trim();

        return {
          success: true,
          action: "updated",
          commit,
          clonePath,
          servicePath: servicePath || null,
          pullOutput: pullOutput.slice(0, 500),
          installOutput: installOutput.slice(-500),
        };
      } else {
        // Fresh clone
        fs.mkdirSync(path.dirname(clonePath), { recursive: true });
        const cloneOutput = execSync(
          `git clone "${repoUrl}" "${path.basename(clonePath)}"`,
          { cwd: path.dirname(clonePath), encoding: "utf-8", timeout: 60000 }
        ).trim();

        let installOutput = "";
        if (servicePath) {
          installOutput = execSync(`"C:/Program Files/Git/bin/bash.exe" install.sh "${servicePath}"`, { cwd: clonePath, encoding: "utf-8", timeout: 30000 }).trim();
        }

        const commit = execSync("git rev-parse --short HEAD", { cwd: clonePath, encoding: "utf-8" }).trim();

        return {
          success: true,
          action: "installed",
          commit,
          clonePath,
          servicePath: servicePath || null,
          cloneOutput: cloneOutput.slice(0, 300),
          installOutput: installOutput.slice(-500),
          note: servicePath ? null : "Clone ready. Provide a service path to install hooks.",
        };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}
