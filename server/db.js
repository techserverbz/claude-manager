import pg from "pg";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { AutoMigrationSystem } from "./auto-migration-system.js";
import { BrainManager } from "./brain-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CHRISTOPHER_HOME = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "christopher");

export class Database {
  constructor(config = {}) {
    this.config = config;
    this.pool = null;
    this.embeddedPostgres = null;
    this.isCloud = false;
    this.dataDir = config.dataDir || path.join(CHRISTOPHER_HOME, "db");
    this.port = config.port || 54331;
    this.user = "christopher";
    this.password = "christopher";
    this.dbName = "christopher";
    this.autoMigration = null;
  }

  async initialize() {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      await this._initCloud(databaseUrl);
    } else {
      await this._initEmbedded();
    }

    // Run schema
    await this._initSchema();

    // Auto-migration
    this.autoMigration = new AutoMigrationSystem(this);
    try {
      const result = await this.autoMigration.runAutoMigrations();
      if (result.applied > 0) {
        console.log(`[DB] Auto-migration: ${result.applied} columns added`);
      }
    } catch (err) {
      console.error("[DB] Auto-migration error:", err.message);
    }

    // Seed built-in Personal brain (idempotent)
    try {
      await this._seedPersonalBrain();
    } catch (err) {
      console.error("[DB] Personal brain seed error:", err.message);
    }

    // One-shot: migrate legacy agent memories → Personal wiki (guarded by sentinel)
    try {
      const brainManager = new BrainManager(this);
      await brainManager.migrateLegacyAgentMemoriesToPersonalWiki();
    } catch (err) {
      console.error("[DB] Legacy memory migration error:", err.message);
    }

    // Backup on startup (only for embedded)
    if (!this.isCloud) {
      await this._backupDbOnStartup();
      this._scheduleDailyBackup();
    }
  }

  async _initCloud(databaseUrl) {
    console.log("[DB] Connecting to cloud PostgreSQL (Supabase)...");
    this.isCloud = true;

    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      ssl: { rejectUnauthorized: false },
    });

    await this.pool.query("SELECT 1");
    console.log("[DB] Connected to Supabase PostgreSQL");

    try {
      const url = new URL(databaseUrl);
      this.port = url.port || 6543;
    } catch {}
  }

  async _initEmbedded() {
    // Start embedded PostgreSQL
    console.log("[DB] Starting embedded PostgreSQL...");
    console.log("[DB] Data directory:", this.dataDir);

    // Kill any existing postgres processes and clean up stale locks
    this._cleanupPostgres();

    const mod = await import("embedded-postgres");
    const EmbeddedPostgres = mod.default || mod.EmbeddedPostgres;

    const isFirstRun = !fs.existsSync(path.join(this.dataDir, "PG_VERSION")) &&
                       !fs.existsSync(path.join(this.dataDir, "data", "PG_VERSION"));

    this.embeddedPostgres = new EmbeddedPostgres({
      databaseDir: this.dataDir,
      user: this.user,
      password: this.password,
      port: this.port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: (msg) => {
        // Only log errors, not routine messages
        if (msg.toLowerCase().includes("error") || msg.toLowerCase().includes("fatal")) {
          console.error("[PG]", msg);
        }
      },
      onError: (msg) => console.error("[PG Error]", msg),
    });

    if (isFirstRun) {
      console.log("[DB] First run — initializing PostgreSQL cluster...");
      await this.embeddedPostgres.initialise();
    }

    await this.embeddedPostgres.start();
    console.log(`[DB] Embedded PostgreSQL running on port ${this.port}`);

    // Create database if it doesn't exist
    try {
      const tempPool = new pg.Pool({
        host: "localhost",
        port: this.port,
        user: this.user,
        password: this.password,
        database: "postgres",
        max: 2,
      });
      const res = await tempPool.query(
        "SELECT 1 FROM pg_database WHERE datname = $1", [this.dbName]
      );
      if (res.rows.length === 0) {
        await tempPool.query(`CREATE DATABASE ${this.dbName}`);
        console.log(`[DB] Created database '${this.dbName}'`);
      }
      await tempPool.end();
    } catch (err) {
      console.error("[DB] Error creating database:", err.message);
    }

    // Connect pool to the christopher database
    this.pool = new pg.Pool({
      host: "localhost",
      port: this.port,
      user: this.user,
      password: this.password,
      database: this.dbName,
      max: 10,
    });

    await this.pool.query("SELECT 1");
    console.log("[DB] Connected to christopher database");
  }

  async _initSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT DEFAULT '',
        claude_session_id TEXT,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'in_progress', 'waiting_for_user', 'completed', 'error')),
        status_summary TEXT DEFAULT '',
        status_updated_at TIMESTAMPTZ DEFAULT NOW(),
        agent TEXT DEFAULT 'coding',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category TEXT DEFAULT 'general',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS session_history (
        id SERIAL PRIMARY KEY,
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        set_at TIMESTAMPTZ DEFAULT NOW(),
        source TEXT DEFAULT 'auto'
      );

      CREATE INDEX IF NOT EXISTS idx_session_history_convo ON session_history(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

      CREATE TABLE IF NOT EXISTS memory_entities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_id TEXT UNIQUE NOT NULL,
        file_path TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        summary TEXT,
        agent TEXT DEFAULT 'coding',
        last_updated TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS memory_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_entity TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        context TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_memory_connections_from ON memory_connections(from_entity);

      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        status VARCHAR(20) DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'in_progress', 'completed', 'cancelled')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deadline TIMESTAMPTZ,
        parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        conversation_id TEXT,
        tags TEXT[] DEFAULT '{}',
        estimated_duration INTEGER,
        actual_duration INTEGER,
        para_memory_file TEXT,
        category VARCHAR(50) DEFAULT 'personal'
      );

      CREATE TABLE IF NOT EXISTS task_history (
        id SERIAL PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS task_attachments (
        id SERIAL PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        file_path TEXT,
        url TEXT,
        attachment_type VARCHAR(50),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_memory_connections_to ON memory_connections(to_entity);
    `;

    try {
      await this.pool.query(schema);
      console.log("[DB] Schema ready");

      // Add metadata column to existing conversations table if it doesn't exist
      try {
        await this.pool.query(`
          ALTER TABLE conversations
          ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'
        `);
      } catch (err) {
        // Ignore error if column already exists
        if (!err.message.includes('already exists')) {
          console.error("[DB] Migration error:", err.message);
        }
      }
    } catch (err) {
      console.error("[DB] Schema error:", err.message);
    }
  }

  async _seedPersonalBrain() {
    // Personal brain = ~/.claude/ (built-in, always active by default)
    const claudeHome = path.join(process.env.USERPROFILE || process.env.HOME, ".claude");

    // Upsert: insert if not there, do not overwrite existing row's claude_path or is_active
    await this.pool.query(
      `INSERT INTO brains (name, type, claude_path, is_builtin, is_active)
       VALUES ($1, 'personal', $2, TRUE, TRUE)
       ON CONFLICT (name) DO UPDATE SET is_builtin = TRUE
       `,
      ["Personal", claudeHome]
    );

    // Ensure at least one brain is active: if no brain has is_active = TRUE, flip Personal on
    const { rows } = await this.pool.query(
      "SELECT COUNT(*)::int AS active_count FROM brains WHERE is_active = TRUE"
    );
    if (rows[0].active_count === 0) {
      await this.pool.query(
        "UPDATE brains SET is_active = TRUE WHERE name = 'Personal'"
      );
    }

    console.log("[DB] Personal brain ready");
  }

  async _backupDbOnStartup() {
    await this._exportTablesAsJson("startup");
  }

  _scheduleDailyBackup() {
    setInterval(() => this._exportTablesAsJson("daily"), 24 * 60 * 60 * 1000);
  }

  async _exportTablesAsJson(prefix) {
    const backupRoot = path.join(CHRISTOPHER_HOME, "backups", "db");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(backupRoot, `${prefix}-${timestamp}`);

    try {
      const tables = ["conversations", "messages", "memories", "memory_entities", "memory_connections", "tasks", "task_history", "task_attachments"];
      fs.mkdirSync(backupPath, { recursive: true });

      for (const table of tables) {
        try {
          const result = await this.pool.query(`SELECT * FROM ${table}`);
          fs.writeFileSync(path.join(backupPath, `${table}.json`), JSON.stringify(result.rows, null, 2));
        } catch {}
      }

      console.log(`[DB Backup] ${prefix} backup saved to ${backupPath}`);
    } catch (err) {
      console.error(`[DB Backup] ${prefix} backup failed:`, err.message);
    }
  }

  _cleanupPostgres() {
    // 1. Kill any postgres processes that belong to our data directory
    //    We find the PID from the postmaster.pid file
    const pidFile = path.join(this.dataDir, "data", "postmaster.pid");
    const pidFileAlt = path.join(this.dataDir, "postmaster.pid");

    for (const f of [pidFile, pidFileAlt]) {
      if (fs.existsSync(f)) {
        try {
          const content = fs.readFileSync(f, "utf-8");
          const pid = content.split("\n")[0].trim();
          if (pid && /^\d+$/.test(pid)) {
            try {
              execSync(`taskkill /F /PID ${pid} /T`, { shell: "cmd.exe", stdio: "ignore", timeout: 5000 });
              console.log(`[DB] Killed old postgres (PID ${pid} from postmaster.pid)`);
            } catch {}
          }
        } catch {}
      }
    }

    // 2. Also kill by port
    try {
      const result = execSync(
        `netstat -ano | findstr :${this.port} | findstr LISTENING`,
        { encoding: "utf-8", shell: "cmd.exe", timeout: 5000 }
      );
      const pids = new Set();
      for (const line of result.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0" && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid} /T`, { shell: "cmd.exe", stdio: "ignore", timeout: 5000 });
          console.log(`[DB] Killed process on port ${this.port} (PID ${pid})`);
        } catch {}
      }
    } catch {}

    // 3. Remove stale lock/pid files so embedded-postgres doesn't choke
    for (const f of [pidFile, pidFileAlt]) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
          console.log(`[DB] Removed stale ${path.basename(f)}`);
        } catch {}
      }
    }

    // Brief pause to let processes fully terminate
    try {
      execSync("timeout /t 2 /nobreak >nul 2>&1", { shell: "cmd.exe", stdio: "ignore" });
    } catch {}
  }

  async query(text, params) {
    if (!this.pool) throw new Error("Database not initialized");
    return this.pool.query(text, params);
  }

  async getClient() {
    if (!this.pool) throw new Error("Database not initialized");
    return this.pool.connect();
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.embeddedPostgres && !this.isCloud) {
      await this.embeddedPostgres.stop();
      this.embeddedPostgres = null;
      console.log("[DB] Embedded PostgreSQL stopped");
    }
  }
}
