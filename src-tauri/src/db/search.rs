//! 搜索引擎
//!
//! 提供基于 SQLite FTS5 的文件搜索

use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Arc, Mutex};

/// 搜索结果
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub name: String,
    pub name_lower: String,
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub modified: Option<i64>,
    pub extension: Option<String>,
    pub is_hidden: bool,
}

/// 搜索引擎
pub struct SearchEngine {
    conn: Arc<Mutex<Connection>>,
}

impl SearchEngine {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// FTS5 全文搜索
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
        if query.is_empty() {
            return Ok(vec![]);
        }

        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(e) => {
                return Err(format!("Failed to acquire index database lock: {e}"));
            }
        };

        // 使用 FTS5 MATCH 语法，支持前缀匹配
        // 清理 FTS5 特殊字符，防止注入
        let sanitized: String = query
            .chars()
            .filter(|c| {
                c.is_alphanumeric() || c.is_whitespace() || *c == '_' || *c == '-' || *c == '.'
            })
            .collect();
        if sanitized.is_empty() {
            return Ok(vec![]);
        }
        // FTS syntax treats punctuation such as `-` as operators unless the
        // user input is tokenized and quoted. Query each literal token as a
        // prefix, preserving the existing AND semantics without exposing the
        // FTS query grammar to file names.
        let fts_terms = sanitized
            .split_whitespace()
            .flat_map(|part| {
                part.split(|character: char| !character.is_alphanumeric() && character != '_')
            })
            .filter(|term| !term.is_empty())
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>();
        if fts_terms.is_empty() {
            return Ok(vec![]);
        }
        let fts_query = fts_terms.join(" AND ");

        let query_lower = sanitized.to_lowercase();

        let mut stmt = match conn.prepare(
            "SELECT f.name, f.name_lower, f.path, f.is_dir, f.size, f.modified_at, f.extension
             FROM files f
             JOIN files_fts fts ON f.id = fts.rowid
             WHERE files_fts MATCH ?1
             ORDER BY
               CASE
                 WHEN f.name_lower = ?3 THEN 0
                 WHEN f.name_lower LIKE ?3 || '%' THEN 1
                 WHEN f.name_lower LIKE '%' || ?3 || '%' THEN 2
                 ELSE 3
               END,
               rank
             LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(e) => return Err(format!("Failed to prepare indexed search: {e}")),
        };

        let rows = stmt
            .query_map(
                rusqlite::params![fts_query, limit as i64, query_lower],
                |row| {
                    Ok(SearchResult {
                        name: row.get(0)?,
                        name_lower: row.get(1)?,
                        path: row.get(2)?,
                        is_dir: row.get::<_, i32>(3)? != 0,
                        size: row.get(4)?,
                        modified: row.get(5)?,
                        extension: row.get(6)?,
                        is_hidden: row.get::<_, String>(1)?.starts_with('.'),
                    })
                },
            )
            .map_err(|e| format!("Failed to execute indexed search: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read indexed search results: {e}"))
    }

    /// LIKE 模糊搜索（备用方案，兼容原有逻辑）
    #[allow(dead_code)]
    pub fn search_like(&self, query: &str, limit: usize) -> Vec<SearchResult> {
        if query.is_empty() {
            return vec![];
        }

        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let like_query = format!("%{}%", query.to_lowercase());

        let mut stmt = match conn.prepare(
            "SELECT name, name_lower, path, is_dir, size, modified_at, extension
             FROM files
             WHERE name_lower LIKE ?1
             LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let results = stmt
            .query_map(rusqlite::params![like_query, limit as i64], |row| {
                Ok(SearchResult {
                    name: row.get(0)?,
                    name_lower: row.get(1)?,
                    path: row.get(2)?,
                    is_dir: row.get::<_, i32>(3)? != 0,
                    size: row.get(4)?,
                    modified: row.get(5)?,
                    extension: row.get(6)?,
                    is_hidden: row.get::<_, String>(0)?.starts_with('.'),
                })
            })
            .ok();

        match results {
            Some(rows) => rows.filter_map(|r| r.ok()).collect(),
            None => vec![],
        }
    }

    /// 按扩展名过滤
    pub fn filter_by_extensions(&self, extensions: &[String], limit: usize) -> Vec<SearchResult> {
        if extensions.is_empty() {
            return vec![];
        }

        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        // 构建 IN 子句
        let placeholders: Vec<String> = extensions.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "SELECT name, name_lower, path, is_dir, size, modified_at, extension
             FROM files
             WHERE is_dir = 0 AND LOWER(extension) IN ({})
             LIMIT ?",
            placeholders.join(", ")
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        // 构建参数
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = extensions
            .iter()
            .map(|e| Box::new(e.to_lowercase()) as Box<dyn rusqlite::ToSql>)
            .collect();
        params.push(Box::new(limit as i64));

        let params_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let results = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(SearchResult {
                    name: row.get(0)?,
                    name_lower: row.get(1)?,
                    path: row.get(2)?,
                    is_dir: row.get::<_, i32>(3)? != 0,
                    size: row.get(4)?,
                    modified: row.get(5)?,
                    extension: row.get(6)?,
                    is_hidden: row.get::<_, String>(0)?.starts_with('.'),
                })
            })
            .ok();

        match results {
            Some(rows) => rows.filter_map(|r| r.ok()).collect(),
            None => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SearchEngine;
    use crate::db::schema;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn engine() -> (SearchEngine, Arc<Mutex<Connection>>) {
        let conn = Connection::open_in_memory().expect("in-memory database");
        schema::init(&conn).expect("initialize schema");
        let conn = Arc::new(Mutex::new(conn));
        (SearchEngine::new(conn.clone()), conn)
    }

    #[test]
    fn empty_search_results_are_distinct_from_database_errors() {
        let (engine, conn) = engine();
        assert!(engine
            .search("not-present", 10)
            .expect("valid query")
            .is_empty());

        conn.lock()
            .expect("database lock")
            .execute("DROP TABLE files_fts", [])
            .expect("remove FTS table to simulate an index error");
        assert!(engine.search("not-present", 10).is_err());
    }
}
