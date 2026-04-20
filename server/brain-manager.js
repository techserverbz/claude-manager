import fs from "fs";
import path from "path";

const CLAUDE_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude");

// Fixed wiki category list. When migrating / writing, unknown categories land in a sensible default.
const WIKI_CATEGORIES = [
  "codebases", "business", "people", "decisions", "ideas", "patterns",
  "systems", "tools", "research", "meetings", "clients", "finance", "credentials"
];

// Map legacy agent-memory frontmatter `type` to a wiki category.
const TYPE_TO_CATEGORY = {
  project: "codebases",
  user: "people",
  feedback: "ideas",
  reference: "research"
};

export class BrainManager {
  constructor(db) {
    this.db = db;
  }

  // --- Brain CRUD ---

  async listBrains() {
    const { rows } = await this.db.query(
      "SELECT id, name, type, claude_path, is_active, is_builtin, created_at FROM brains ORDER BY is_builtin DESC, created_at ASC"
    );
    return rows;
  }

  async getActiveBrain() {
    const { rows } = await this.db.query(
      "SELECT id, name, type, claude_path, is_active, is_builtin, created_at FROM brains WHERE is_active = TRUE LIMIT 1"
    );
    if (rows[0]) return rows[0];
    // Fallback: if no active brain, look up Personal
    const { rows: personalRows } = await this.db.query(
      "SELECT id, name, type, claude_path, is_active, is_builtin, created_at FROM brains WHERE name = 'Personal' LIMIT 1"
    );
    return personalRows[0] || null;
  }

  async getBrainById(id) {
    const { rows } = await this.db.query(
      "SELECT id, name, type, claude_path, is_active, is_builtin, created_at FROM brains WHERE id = $1",
      [id]
    );
    return rows[0] || null;
  }

  async setActiveBrain(id) {
    const brain = await this.getBrainById(id);
    if (!brain) throw new Error(`Brain not found: ${id}`);

    await this.db.query("BEGIN");
    try {
      await this.db.query("UPDATE brains SET is_active = FALSE WHERE is_active = TRUE");
      await this.db.query("UPDATE brains SET is_active = TRUE WHERE id = $1", [id]);
      await this.db.query("COMMIT");
    } catch (err) {
      await this.db.query("ROLLBACK");
      throw err;
    }
    return brain;
  }

  async addBrain({ name, claude_path, initIfMissing = false }) {
    if (!name || !claude_path) throw new Error("name and claude_path are required");

    // Expand ~/ and normalize
    const normalized = this._normalizePath(claude_path);

    // Folder must exist
    if (!fs.existsSync(normalized)) {
      const err = new Error(`Folder does not exist: ${normalized}`);
      err.code = "FOLDER_NOT_FOUND";
      throw err;
    }

    // Wiki must exist OR initIfMissing must be true
    const wikiRoot = path.join(normalized, "wiki");
    if (!fs.existsSync(wikiRoot)) {
      if (!initIfMissing) {
        const err = new Error(`No wiki/ folder at ${normalized}. Pass initIfMissing: true to create one.`);
        err.code = "NEEDS_INIT";
        err.claude_path = normalized;
        throw err;
      }
      this._initWikiStructure(normalized);
    }

    const { rows } = await this.db.query(
      `INSERT INTO brains (name, type, claude_path, is_builtin, is_active)
       VALUES ($1, 'service', $2, FALSE, FALSE)
       RETURNING *`,
      [name, normalized]
    );
    return rows[0];
  }

  async removeBrain(id) {
    const brain = await this.getBrainById(id);
    if (!brain) throw new Error(`Brain not found: ${id}`);
    if (brain.is_builtin) throw new Error("Cannot remove built-in brain");

    // If removing the active brain, fall back to Personal
    if (brain.is_active) {
      const { rows: personal } = await this.db.query("SELECT id FROM brains WHERE name = 'Personal' LIMIT 1");
      if (personal[0]) {
        await this.db.query("UPDATE brains SET is_active = TRUE WHERE id = $1", [personal[0].id]);
      }
    }

    await this.db.query("DELETE FROM brains WHERE id = $1", [id]);
    // Note: memory_entities rows with this brain_id become orphans (brain_id still set, just no matching brain).
    // That's fine — they stay addressable by wiki_path if the folder still exists.
    return { removed: true };
  }

  // --- Path helpers ---

  getWikiRoot(brain) {
    return path.join(brain.claude_path, "wiki");
  }

  getWikiPagesRoot(brain) {
    return path.join(brain.claude_path, "wiki", "wiki");
  }

  getSkillsRoot(brain) {
    return path.join(brain.claude_path, "skills");
  }

  // --- Wiki file I/O ---

  readHot(brain) {
    return this._readFile(path.join(this.getWikiPagesRoot(brain), "hot.md"));
  }

  readIndex(brain) {
    return this._readFile(path.join(this.getWikiPagesRoot(brain), "index.md"));
  }

  readLog(brain) {
    return this._readFile(path.join(this.getWikiPagesRoot(brain), "log.md"));
  }

  listPages(brain, category = null) {
    const pagesRoot = this.getWikiPagesRoot(brain);
    if (!fs.existsSync(pagesRoot)) return [];

    const categories = category ? [category] : this._listCategoryFolders(pagesRoot);
    const pages = [];

    for (const cat of categories) {
      const catDir = path.join(pagesRoot, cat);
      if (!fs.existsSync(catDir)) continue;
      // Recursive scan — finds .md files at any depth under category
      this._walkMdFiles(catDir, (full, relPath) => {
        try {
          const stat = fs.statSync(full);
          const content = fs.readFileSync(full, "utf-8");
          const meta = this._parseFrontmatter(content);
          const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();
          const slug = relPath.replace(/\.md$/, "").replace(/\\/g, "/");
          pages.push({
            category: cat,
            slug,
            name: meta.name || slug.split("/").pop().replace(/-/g, " "),
            type: meta.type || meta.category || null,
            last_modified: stat.mtime.toISOString(),
            excerpt: body.slice(0, 200),
            frontmatter: meta,
            subpath: relPath.includes("/") || relPath.includes("\\") ? relPath.replace(/\\/g, "/") : null,
          });
        } catch {}
      });
    }

    pages.sort((a, b) => (a.last_modified < b.last_modified ? 1 : -1));
    return pages;
  }

  readPage(brain, category, slug) {
    const p = path.join(this.getWikiPagesRoot(brain), category, `${slug}.md`);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf-8");
    return {
      category,
      slug,
      content,
      frontmatter: this._parseFrontmatter(content),
      body: content.replace(/^---[\s\S]*?---\n*/, "")
    };
  }

  writePage(brain, category, slug, frontmatter, body) {
    const cat = this._normalizeCategory(category);
    const dir = path.join(this.getWikiPagesRoot(brain), cat);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${this._slugify(slug)}.md`);

    const fmLines = [];
    for (const [k, v] of Object.entries(frontmatter || {})) {
      if (v === undefined || v === null) continue;
      fmLines.push(`${k}: ${v}`);
    }
    const fmBlock = fmLines.length ? `---\n${fmLines.join("\n")}\n---\n\n` : "";
    fs.writeFileSync(filePath, fmBlock + (body || ""), "utf-8");

    return { filePath, category: cat, slug: this._slugify(slug) };
  }

  appendRaw(brain, text) {
    const rawDir = path.join(this.getWikiRoot(brain), "raw");
    fs.mkdirSync(rawDir, { recursive: true });

    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const filePath = path.join(rawDir, `${ts}.md`);

    const timeOnly = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (!fs.existsSync(filePath)) {
      const header = `---\nsession: ${ts}\nsource: brain-manager\n---\n\n`;
      fs.writeFileSync(filePath, header, "utf-8");
    }
    fs.appendFileSync(filePath, `\n## [${timeOnly}] ${text}\n`, "utf-8");

    return { filePath, ts };
  }

  // --- Planner files (tasks.md, reminders.md, calendar.md, short-term.md) ---

  readPlanner(brain, file) {
    const allowed = new Set(["tasks.md", "reminders.md", "calendar.md", "short-term.md"]);
    if (!allowed.has(file)) throw new Error(`Unknown planner file: ${file}`);
    return this._readFile(path.join(this.getWikiRoot(brain), file));
  }

  writePlanner(brain, file, content) {
    const allowed = new Set(["tasks.md", "reminders.md", "calendar.md", "short-term.md"]);
    if (!allowed.has(file)) throw new Error(`Unknown planner file: ${file}`);
    const filePath = path.join(this.getWikiRoot(brain), file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return { filePath };
  }

  // --- Skills ---

  listSkills(brain) {
    const skillsDir = this.getSkillsRoot(brain);
    if (!fs.existsSync(skillsDir)) return [];
    try {
      const items = fs.readdirSync(skillsDir);
      const skills = [];
      for (const it of items) {
        const full = path.join(skillsDir, it);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            // Skill dir — look for SKILL.md
            const skillFile = path.join(full, "SKILL.md");
            let description = "";
            if (fs.existsSync(skillFile)) {
              const head = fs.readFileSync(skillFile, "utf-8").slice(0, 400);
              description = head.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---")) || "";
            }
            skills.push({ name: it, type: "folder", description, path: full });
          } else if (it.endsWith(".md") || it.endsWith(".skill")) {
            const content = fs.readFileSync(full, "utf-8").slice(0, 400);
            const description = content.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---")) || "";
            skills.push({ name: it, type: "file", description, path: full });
          }
        } catch {}
      }
      return skills;
    } catch {
      return [];
    }
  }

  // --- Sync: wiki files → DB memory_entities ---

  async syncFromWiki(brain) {
    let synced = 0;
    const pagesRoot = this.getWikiPagesRoot(brain);
    if (!fs.existsSync(pagesRoot)) return 0;

    for (const cat of this._listCategoryFolders(pagesRoot)) {
      const catDir = path.join(pagesRoot, cat);
      let files;
      try { files = fs.readdirSync(catDir).filter(f => f.endsWith(".md")); } catch { continue; }

      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(catDir, f), "utf-8");
          const meta = this._parseFrontmatter(content);
          const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();
          const slug = f.replace(/\.md$/, "");
          const entityId = `${brain.name}/${cat}/${slug}`;
          const wikiRelPath = `${cat}/${f}`;

          await this.db.query(
            `INSERT INTO memory_entities (entity_id, file_path, entity_type, summary, agent, brain_id, wiki_path, category, last_updated)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (entity_id) DO UPDATE SET
               file_path = $2,
               entity_type = $3,
               summary = $4,
               brain_id = $6,
               wiki_path = $7,
               category = $8,
               last_updated = NOW()`,
            [
              entityId,
              wikiRelPath,
              meta.type || "page",
              (meta.name || slug) + ": " + body.slice(0, 200),
              "wiki",            // legacy agent column — placeholder value
              brain.id,
              wikiRelPath,
              cat
            ]
          );
          synced++;
        } catch {}
      }
    }

    if (synced > 0) console.log(`[Brain:${brain.name}] Synced ${synced} wiki pages → memory_entities`);
    return synced;
  }

  // --- One-shot legacy migration ---

  async migrateLegacyAgentMemoriesToPersonalWiki() {
    const personal = await this.db.query("SELECT * FROM brains WHERE name = 'Personal' LIMIT 1");
    const brain = personal.rows[0];
    if (!brain) {
      console.warn("[Migration] No Personal brain found — skipping legacy migration");
      return { migrated: 0, skipped: 0 };
    }

    const sentinel = path.join(this.getWikiRoot(brain), "_state", "migration_v1.done");
    if (fs.existsSync(sentinel)) {
      // Already migrated
      return { migrated: 0, skipped: 0, alreadyDone: true };
    }

    const AGENTS_DIR = path.join(CLAUDE_HOME, "agents");
    if (!fs.existsSync(AGENTS_DIR)) {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, new Date().toISOString(), "utf-8");
      return { migrated: 0, skipped: 0, note: "no agents dir" };
    }

    let migrated = 0, skipped = 0;
    const agents = fs.readdirSync(AGENTS_DIR).filter(d => {
      try { return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory(); } catch { return false; }
    });

    for (const agent of agents) {
      const memDir = path.join(AGENTS_DIR, agent, "memory");
      if (!fs.existsSync(memDir)) continue;

      const dates = fs.readdirSync(memDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      for (const date of dates) {
        const dateDir = path.join(memDir, date);
        let files;
        try { files = fs.readdirSync(dateDir).filter(f => f.endsWith(".md")); } catch { continue; }

        for (const f of files) {
          try {
            const srcPath = path.join(dateDir, f);
            const content = fs.readFileSync(srcPath, "utf-8");
            const meta = this._parseFrontmatter(content);
            const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();

            const category = TYPE_TO_CATEGORY[meta.type] || "research";
            const originalSlug = f.replace(/\.md$/, "");
            let slug = originalSlug;

            // Collision handling
            const targetDir = path.join(this.getWikiPagesRoot(brain), category);
            fs.mkdirSync(targetDir, { recursive: true });
            let targetPath = path.join(targetDir, `${slug}.md`);
            if (fs.existsSync(targetPath)) {
              slug = `${originalSlug}-${agent}-${date}`;
              targetPath = path.join(targetDir, `${slug}.md`);
              if (fs.existsSync(targetPath)) {
                // Final resort — skip if still collides
                skipped++;
                continue;
              }
            }

            // Rewrite frontmatter
            const newFm = [
              `name: ${meta.name || originalSlug}`,
              `type: ${meta.type || "project"}`,
              `brain: Personal`,
              `source: legacy-agent`,
              `original_agent: ${agent}`,
              `original_date: ${date}`,
              meta.time ? `time: ${meta.time}` : null,
              `category: ${category}`
            ].filter(Boolean).join("\n");

            const breadcrumb = `> Migrated from agents/${agent}/memory/${date}/${f}\n\n`;
            const newContent = `---\n${newFm}\n---\n\n${breadcrumb}${body}\n`;

            fs.writeFileSync(targetPath, newContent, "utf-8");
            migrated++;
          } catch (err) {
            console.warn(`[Migration] Failed ${f}:`, err.message);
            skipped++;
          }
        }
      }
    }

    // Sync wiki pages into DB so they appear in memory_entities with brain_id
    try {
      await this.syncFromWiki(brain);
    } catch (err) {
      console.warn("[Migration] syncFromWiki error:", err.message);
    }

    // Write sentinel last so we can re-run if anything above failed mid-way
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, new Date().toISOString(), "utf-8");

    console.log(`[Migration] ${migrated} legacy agent memories → Personal wiki (${skipped} skipped)`);
    return { migrated, skipped };
  }

  // --- Shortcut actions (disb, sisb, scsb, slsb, srsb) ---

  async disb(brain, text) {
    // Dump In Second Brain — appends to short-term.md and today's raw log
    const stPath = path.join(this.getWikiRoot(brain), "short-term.md");
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const line = `- [${stamp}] ${text}\n`;

    if (fs.existsSync(stPath)) {
      fs.appendFileSync(stPath, line, "utf-8");
    } else {
      fs.mkdirSync(path.dirname(stPath), { recursive: true });
      fs.writeFileSync(stPath, `# Short-Term Big Things\n\n${line}`, "utf-8");
    }

    this.appendRaw(brain, `disb: ${text}`);
    return { saved: true, stPath };
  }

  async sisb(brain, query) {
    // Search In Second Brain — grep raw/ and wiki/wiki/**/*.md
    const results = [];
    const q = query.toLowerCase();

    // Raw files
    const rawDir = path.join(this.getWikiRoot(brain), "raw");
    if (fs.existsSync(rawDir)) {
      try {
        const files = fs.readdirSync(rawDir).filter(f => f.endsWith(".md"));
        for (const f of files) {
          try {
            const content = fs.readFileSync(path.join(rawDir, f), "utf-8");
            if (content.toLowerCase().includes(q)) {
              const idx = content.toLowerCase().indexOf(q);
              results.push({
                source: "raw",
                file: f,
                snippet: content.slice(Math.max(0, idx - 80), idx + 200)
              });
            }
          } catch {}
        }
      } catch {}
    }

    // Wiki pages
    for (const p of this.listPages(brain)) {
      const page = this.readPage(brain, p.category, p.slug);
      if (!page) continue;
      if (page.content.toLowerCase().includes(q)) {
        const idx = page.content.toLowerCase().indexOf(q);
        results.push({
          source: "wiki",
          category: p.category,
          slug: p.slug,
          name: p.name,
          snippet: page.content.slice(Math.max(0, idx - 80), idx + 200)
        });
      }
    }

    return { query, hits: results.slice(0, 50), total: results.length };
  }

  // scsb/slsb/srsb stubs — full compile/lint/restructure is heavy and
  // runs via the CLI hook. These endpoints just expose current wiki state
  // and let the front-end or a scheduled job trigger the real compile.

  async slsb(brain) {
    // Scan/List: return grouping stats
    const pages = this.listPages(brain);
    const byCategory = {};
    for (const p of pages) {
      byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    }
    return { total: pages.length, byCategory, recent: pages.slice(0, 10) };
  }

  async srsb(brain) {
    // Same as slsb for now — placeholder for future restructure
    return this.slsb(brain);
  }

  async scsb(brain) {
    // Return raw log count so UI can decide whether to run the compile hook
    const rawDir = path.join(this.getWikiRoot(brain), "raw");
    let pending = 0;
    if (fs.existsSync(rawDir)) {
      try {
        pending = fs.readdirSync(rawDir).filter(f => f.endsWith(".md")).length;
      } catch {}
    }
    return { pendingRawLogs: pending, wikiRoot: this.getWikiRoot(brain) };
  }

  // --- Private helpers ---

  _normalizePath(p) {
    if (!p) return p;
    let out = p.trim();
    // Expand ~/
    if (out.startsWith("~/") || out === "~") {
      out = path.join(process.env.USERPROFILE || process.env.HOME, out.slice(1));
    }
    return path.resolve(out);
  }

  _initWikiStructure(claudePath) {
    const wiki = path.join(claudePath, "wiki");
    const dirs = [
      path.join(wiki, "raw", "processed"),
      path.join(wiki, "_state"),
      path.join(wiki, "wiki")
    ];
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });

    const seed = (p, body) => { if (!fs.existsSync(p)) fs.writeFileSync(p, body, "utf-8"); };
    seed(path.join(wiki, "wiki", "index.md"), "# Wiki Index\n");
    seed(path.join(wiki, "wiki", "hot.md"), "# Recent Context\n");
    seed(path.join(wiki, "wiki", "log.md"), "# Wiki Operations Log\n");
    seed(path.join(wiki, "_state", "counter.txt"), "0");
    seed(path.join(wiki, "_state", "total_counter.txt"), "0");
  }

  _walkMdFiles(dir, callback, prefix = "") {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            this._walkMdFiles(full, callback, prefix ? `${prefix}/${entry}` : entry);
          } else if (entry.endsWith(".md")) {
            callback(full, prefix ? `${prefix}/${entry}` : entry);
          }
        } catch {}
      }
    } catch {}
  }

  _listCategoryFolders(pagesRoot) {
    try {
      return fs.readdirSync(pagesRoot).filter(d => {
        try {
          return fs.statSync(path.join(pagesRoot, d)).isDirectory();
        } catch { return false; }
      });
    } catch { return []; }
  }

  _normalizeCategory(cat) {
    if (!cat) return "research";
    const lower = String(cat).toLowerCase().trim();
    return WIKI_CATEGORIES.includes(lower) ? lower : lower.replace(/[^a-z0-9-]+/g, "-");
  }

  _slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  _readFile(p) {
    try { return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""; } catch { return ""; }
  }

  _parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const meta = {};
    for (const line of match[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    return meta;
  }
}

export const WIKI_CATEGORY_LIST = WIKI_CATEGORIES;
