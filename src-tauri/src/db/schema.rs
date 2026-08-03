//! 数据库 Schema 定义

use rusqlite::Connection;

const CURRENT_SCHEMA_VERSION: i64 = 2;

/// 初始化数据库 schema
pub fn init(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );

        -- 主表：文件索引
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            name_lower TEXT NOT NULL,
            extension TEXT,
            size INTEGER DEFAULT 0,
            modified_at INTEGER,
            is_dir INTEGER DEFAULT 0,
            parent_path TEXT
        );

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_path);
        CREATE INDEX IF NOT EXISTS idx_files_name_lower ON files(name_lower);
        CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);

        -- FTS5 全文搜索虚拟表
        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
            name,
            content='files',
            content_rowid='id',
            tokenize='unicode61'
        );

        -- 元数据表
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        "#,
    )?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if version < CURRENT_SCHEMA_VERSION {
        if version < 1 {
            record_migration(conn, 1)?;
        }

        if version < 2 {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_files_parent_name ON files(parent_path, name_lower);",
            )?;
            record_migration(conn, 2)?;
        }
    }

    // 检查并创建 FTS 触发器
    setup_fts_triggers(conn)?;

    Ok(())
}

fn record_migration(conn: &Connection, version: i64) -> Result<(), rusqlite::Error> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
        rusqlite::params![version, now],
    )?;
    Ok(())
}

/// 设置 FTS 同步触发器
fn setup_fts_triggers(conn: &Connection) -> Result<(), rusqlite::Error> {
    // 检查触发器是否存在
    let trigger_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='trigger' AND name='files_ai'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !trigger_exists {
        conn.execute_batch(
            r#"
            -- 插入触发器
            CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
            END;

            -- 删除触发器
            CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name) VALUES('delete', old.id, old.name);
            END;

            -- 更新触发器
            CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name) VALUES('delete', old.id, old.name);
                INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
            END;
            "#,
        )?;
    }

    Ok(())
}
