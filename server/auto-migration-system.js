// Auto Migration System for Christopher
// Safely adds new columns on startup, never destructive actions

export class AutoMigrationSystem {
  constructor(db) {
    this.db = db;
  }

  // Define the expected schema - this is the "source of truth"
  getExpectedSchema() {
    return {
      conversations: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        title: { type: 'TEXT', default: "''" },
        claude_session_id: { type: 'TEXT', nullable: true },
        status: { type: 'TEXT', default: "'active'", check: "status IN ('active', 'in_progress', 'waiting_for_user', 'completed', 'error')" },
        status_summary: { type: 'TEXT', default: "''" },
        status_updated_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        agent: { type: 'TEXT', default: "'coding'" },
        metadata: { type: 'JSONB', default: "'{}'::jsonb" },
        last_message_text: { type: 'TEXT', nullable: true },
        last_message_role: { type: 'TEXT', nullable: true },
        last_message_at: { type: 'TIMESTAMPTZ', nullable: true },
        last_message_session_id: { type: 'TEXT', nullable: true },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        updated_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      messages: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        conversation_id: { type: 'UUID', references: 'conversations(id)', cascade: true },
        role: { type: 'TEXT', check: "role IN ('user', 'assistant', 'system')" },
        content: { type: 'TEXT' },
        metadata: { type: 'JSONB', default: "'{}'::jsonb" },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      memories: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        category: { type: 'TEXT', default: "'general'" },
        title: { type: 'TEXT' },
        content: { type: 'TEXT' },
        metadata: { type: 'JSONB', default: "'{}'::jsonb" },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        updated_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      memory_entities: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        entity_id: { type: 'TEXT', unique: true },
        file_path: { type: 'TEXT' },
        entity_type: { type: 'TEXT' },
        summary: { type: 'TEXT', nullable: true },
        agent: { type: 'TEXT', default: "'coding'" },
        brain_id: { type: 'UUID', nullable: true },       // ← brain this memory belongs to
        wiki_path: { type: 'TEXT', nullable: true },      // ← relative path inside {claude_path}/wiki/wiki/
        category: { type: 'TEXT', nullable: true },       // ← codebases|people|decisions|...
        last_updated: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        metadata: { type: 'JSONB', default: "'{}'::jsonb" }
      },

      brains: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        name: { type: 'TEXT', unique: true },
        type: { type: 'TEXT', default: "'service'", check: "type IN ('personal','service')" },
        claude_path: { type: 'TEXT' },
        is_active: { type: 'BOOLEAN', default: 'FALSE' },
        is_builtin: { type: 'BOOLEAN', default: 'FALSE' },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      memory_connections: {
        id: { type: 'UUID', default: 'gen_random_uuid()', primary: true },
        from_entity: { type: 'TEXT' },
        to_entity: { type: 'TEXT' },
        relationship_type: { type: 'TEXT' },
        context: { type: 'TEXT', nullable: true },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      session_history: {
        id: { type: 'SERIAL', primary: true },
        conversation_id: { type: 'UUID', references: 'conversations(id)', cascade: true },
        session_id: { type: 'TEXT' },
        set_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        source: { type: 'TEXT', default: "'auto'" }
      },

      tasks: {
        id: { type: 'SERIAL', primary: true },
        title: { type: 'VARCHAR(255)' },
        description: { type: 'TEXT', nullable: true },
        priority: { type: 'VARCHAR(20)', default: "'medium'", check: "priority IN ('low', 'medium', 'high', 'urgent')" },
        status: { type: 'VARCHAR(20)', default: "'incomplete'", check: "status IN ('incomplete', 'in_progress', 'completed', 'cancelled')" },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        updated_at: { type: 'TIMESTAMPTZ', default: 'NOW()' },
        deadline: { type: 'TIMESTAMPTZ', nullable: true },
        parent_task_id: { type: 'INTEGER', references: 'tasks(id)', cascade: true, nullable: true },
        conversation_id: { type: 'TEXT', nullable: true },
        tags: { type: 'TEXT[]', default: "'{}'" },
        estimated_duration: { type: 'INTEGER', nullable: true },
        actual_duration: { type: 'INTEGER', nullable: true },
        para_memory_file: { type: 'TEXT', nullable: true },
        category: { type: 'VARCHAR(50)', default: "'personal'" }, // ← This will be auto-added!
        assignee: { type: 'TEXT', nullable: true }, // ← Future column example
        project_id: { type: 'INTEGER', nullable: true } // ← Another future column
      },

      task_history: {
        id: { type: 'SERIAL', primary: true },
        task_id: { type: 'INTEGER', references: 'tasks(id)', cascade: true },
        action: { type: 'VARCHAR(50)' },
        previous_value: { type: 'TEXT', nullable: true },
        new_value: { type: 'TEXT', nullable: true },
        reason: { type: 'TEXT', nullable: true },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      saved_directories: {
        id: { type: 'SERIAL', primary: true },
        name: { type: 'VARCHAR(100)' },
        path: { type: 'TEXT' },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      },

      task_attachments: {
        id: { type: 'SERIAL', primary: true },
        task_id: { type: 'INTEGER', references: 'tasks(id)', cascade: true },
        file_path: { type: 'TEXT', nullable: true },
        url: { type: 'TEXT', nullable: true },
        attachment_type: { type: 'VARCHAR(50)', nullable: true },
        description: { type: 'TEXT', nullable: true },
        created_at: { type: 'TIMESTAMPTZ', default: 'NOW()' }
      }
    };
  }

  // Get current database schema
  async getCurrentSchema() {
    const result = await this.db.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const schema = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) schema[row.table_name] = {};
      schema[row.table_name][row.column_name] = {
        type: row.data_type.toUpperCase(),
        nullable: row.is_nullable === 'YES',
        default: row.column_default
      };
    }
    return schema;
  }

  // Generate safe migration SQL (only ADD COLUMN)
  async generateMigrations() {
    const expected = this.getExpectedSchema();
    const current = await this.getCurrentSchema();
    const migrations = [];

    for (const [tableName, expectedColumns] of Object.entries(expected)) {
      // If table doesn't exist at all, create it
      if (!current[tableName]) {
        const cols = [];
        for (const [colName, colDef] of Object.entries(expectedColumns)) {
          let col = `${colName} ${colDef.type}`;
          if (colDef.primary) col += colDef.type === 'SERIAL' ? ' PRIMARY KEY' : ' PRIMARY KEY DEFAULT ' + colDef.default;
          else {
            if (colDef.default) col += ` DEFAULT ${colDef.default}`;
            if (colDef.nullable) col += '';
            else if (!colDef.default && !colDef.references) col += '';
            if (colDef.check) col += ` CHECK (${colDef.check})`;
            if (colDef.references) col += ` REFERENCES ${colDef.references}${colDef.cascade ? ' ON DELETE CASCADE' : ''}`;
            if (colDef.unique) col += ' UNIQUE';
          }
          cols.push(col);
        }
        migrations.push({
          table: tableName,
          column: '*',
          sql: `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.join(', ')});`,
          safe: true
        });
        continue;
      }

      const currentColumns = current[tableName] || {};

      for (const [columnName, columnDef] of Object.entries(expectedColumns)) {
        // Skip system columns and columns that already exist
        if (currentColumns[columnName] ||
            columnDef.primary ||
            columnDef.references ||
            columnDef.unique) {
          continue;
        }

        // Generate ADD COLUMN statement
        let sql = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${columnDef.type}`;

        if (columnDef.default) {
          sql += ` DEFAULT ${columnDef.default}`;
        }

        if (!columnDef.nullable && !columnDef.default) {
          sql += ` NOT NULL`;
        }

        if (columnDef.check) {
          sql += ` CHECK (${columnDef.check})`;
        }

        migrations.push({
          table: tableName,
          column: columnName,
          sql: sql + ';',
          safe: true
        });
      }
    }

    return migrations;
  }

  // Run safe migrations
  async runAutoMigrations() {
    console.log('[AUTO-MIGRATION] Checking for schema updates...');

    try {
      const migrations = await this.generateMigrations();

      if (migrations.length === 0) {
        console.log('[AUTO-MIGRATION] ✅ Schema is up to date');
        return { applied: 0, migrations: [] };
      }

      console.log(`[AUTO-MIGRATION] 🔄 Found ${migrations.length} safe migrations to apply:`);

      const applied = [];
      for (const migration of migrations) {
        try {
          console.log(`[AUTO-MIGRATION] Adding column: ${migration.table}.${migration.column}`);
          await this.db.query(migration.sql);
          applied.push(migration);
          console.log(`[AUTO-MIGRATION] ✅ ${migration.table}.${migration.column} added successfully`);
        } catch (error) {
          // Column might already exist, that's OK
          if (error.message.includes('already exists')) {
            console.log(`[AUTO-MIGRATION] ⚠️  ${migration.table}.${migration.column} already exists, skipping`);
          } else {
            console.error(`[AUTO-MIGRATION] ❌ Failed to add ${migration.table}.${migration.column}:`, error.message);
          }
        }
      }

      console.log(`[AUTO-MIGRATION] ✅ Applied ${applied.length} migrations successfully`);
      return { applied: applied.length, migrations: applied };

    } catch (error) {
      console.error('[AUTO-MIGRATION] ❌ Migration check failed:', error.message);
      return { applied: 0, migrations: [], error: error.message };
    }
  }

  // Validate that no destructive operations are attempted
  validateSafety(sql) {
    const destructiveKeywords = [
      'DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'DROP INDEX',
      'TRUNCATE', 'DELETE', 'MODIFY COLUMN', 'CHANGE COLUMN'
    ];

    const upperSQL = sql.toUpperCase();
    for (const keyword of destructiveKeywords) {
      if (upperSQL.includes(keyword)) {
        throw new Error(`SAFETY VIOLATION: Destructive operation detected: ${keyword}`);
      }
    }
  }
}