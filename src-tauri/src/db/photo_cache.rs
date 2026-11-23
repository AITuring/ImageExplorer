//! 照片分析特征与清晰度判定的 SQLite 持久化缓存
//!
//! 独立于 `files` 索引表存储，全盘重建索引时不会清空缓存；
//! 通过 `(path, modified, file_size, version)` 精确校验有效性，实现二次进入大目录零解码秒开。

use base64::Engine as _;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const LOOKUP_CHUNK_SIZE: usize = 500;
const MAX_CACHED_ROWS: i64 = 50_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoCacheLookup {
    pub path: String,
    pub modified: i64,
    pub file_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPhotoFeatureRecord {
    pub path: String,
    pub modified: i64,
    pub file_size: i64,
    pub image_width: u32,
    pub image_height: u32,
    /// Packed binary TypedArray payload encoded as compact Base64 for IPC.
    pub features_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPhotoSharpnessRecord {
    pub path: String,
    pub modified: i64,
    pub file_size: i64,
    pub verdict: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPhotoMetadataRecord {
    pub path: String,
    pub modified: i64,
    pub file_size: i64,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhotoCullingRecord {
    pub path: String,
    pub rating: u8,
    /// `"none"`, `"pick"`, or `"reject"`
    pub flag: String,
}

pub struct PhotoCacheStore {
    read_conn: Arc<Mutex<Connection>>,
    write_conn: Arc<Mutex<Connection>>,
}

impl PhotoCacheStore {
    pub fn new(read_conn: Arc<Mutex<Connection>>, write_conn: Arc<Mutex<Connection>>) -> Self {
        Self {
            read_conn,
            write_conn,
        }
    }

    pub fn get_features(
        &self,
        items: &[PhotoCacheLookup],
        analysis_version: i64,
    ) -> Result<Vec<CachedPhotoFeatureRecord>, String> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let expected: HashMap<&str, (i64, i64)> = items
            .iter()
            .map(|item| (item.path.as_str(), (item.modified, item.file_size)))
            .collect();

        let conn = self
            .read_conn
            .lock()
            .map_err(|error| format!("Failed to acquire photo cache read lock: {error}"))?;
        let mut results = Vec::new();

        for chunk in items.chunks(LOOKUP_CHUNK_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT path, modified, file_size, image_width, image_height, features_blob
                 FROM photo_analysis_cache
                 WHERE analysis_version = ?1 AND path IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql).map_err(|error| {
                format!("Failed to prepare photo feature cache lookup: {error}")
            })?;

            let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(chunk.len() + 1);
            params.push(Box::new(analysis_version));
            for item in chunk {
                params.push(Box::new(item.path.clone()));
            }
            let param_refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();

            let rows = stmt
                .query_map(param_refs.as_slice(), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                    ))
                })
                .map_err(|error| format!("Failed to query photo feature cache: {error}"))?;

            for row in rows {
                let (path, modified, file_size, image_width, image_height, blob) = row
                    .map_err(|error| format!("Failed to read photo feature cache row: {error}"))?;
                if expected.get(path.as_str()) == Some(&(modified, file_size)) {
                    results.push(CachedPhotoFeatureRecord {
                        path,
                        modified,
                        file_size,
                        image_width,
                        image_height,
                        features_base64: base64::engine::general_purpose::STANDARD.encode(blob),
                    });
                }
            }
        }

        Ok(results)
    }

    pub fn save_features(
        &self,
        records: &[CachedPhotoFeatureRecord],
        analysis_version: i64,
    ) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }

        let now = now_seconds();
        let mut conn = self
            .write_conn
            .lock()
            .map_err(|error| format!("Failed to acquire photo cache write lock: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("Failed to start photo feature cache transaction: {error}"))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO photo_analysis_cache
                     (path, modified, file_size, analysis_version, image_width, image_height, features_blob, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|error| format!("Failed to prepare photo feature insert: {error}"))?;

            for record in records {
                let Ok(blob) =
                    base64::engine::general_purpose::STANDARD.decode(&record.features_base64)
                else {
                    continue;
                };
                stmt.execute(rusqlite::params![
                    record.path,
                    record.modified,
                    record.file_size,
                    analysis_version,
                    record.image_width,
                    record.image_height,
                    blob,
                    now,
                ])
                .map_err(|error| format!("Failed to save photo feature cache: {error}"))?;
            }
        }

        prune_table_if_needed(&tx, "photo_analysis_cache")?;
        tx.commit()
            .map_err(|error| format!("Failed to commit photo feature cache: {error}"))
    }

    pub fn get_sharpness(
        &self,
        items: &[PhotoCacheLookup],
        sharpness_version: i64,
    ) -> Result<Vec<CachedPhotoSharpnessRecord>, String> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let expected: HashMap<&str, (i64, i64)> = items
            .iter()
            .map(|item| (item.path.as_str(), (item.modified, item.file_size)))
            .collect();

        let conn = self
            .read_conn
            .lock()
            .map_err(|error| format!("Failed to acquire sharpness cache read lock: {error}"))?;
        let mut results = Vec::new();

        for chunk in items.chunks(LOOKUP_CHUNK_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT path, modified, file_size, verdict
                 FROM photo_sharpness_cache
                 WHERE sharpness_version = ?1 AND path IN ({placeholders})"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|error| format!("Failed to prepare sharpness cache lookup: {error}"))?;

            let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(chunk.len() + 1);
            params.push(Box::new(sharpness_version));
            for item in chunk {
                params.push(Box::new(item.path.clone()));
            }
            let param_refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();

            let rows = stmt
                .query_map(param_refs.as_slice(), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("Failed to query sharpness cache: {error}"))?;

            for row in rows {
                let (path, modified, file_size, verdict) =
                    row.map_err(|error| format!("Failed to read sharpness cache row: {error}"))?;
                if expected.get(path.as_str()) == Some(&(modified, file_size)) {
                    results.push(CachedPhotoSharpnessRecord {
                        path,
                        modified,
                        file_size,
                        verdict,
                    });
                }
            }
        }

        Ok(results)
    }

    pub fn save_sharpness(
        &self,
        records: &[CachedPhotoSharpnessRecord],
        sharpness_version: i64,
    ) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }

        let now = now_seconds();
        let mut conn = self
            .write_conn
            .lock()
            .map_err(|error| format!("Failed to acquire sharpness cache write lock: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("Failed to start sharpness cache transaction: {error}"))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO photo_sharpness_cache
                     (path, modified, file_size, sharpness_version, verdict, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|error| format!("Failed to prepare sharpness cache insert: {error}"))?;

            for record in records {
                stmt.execute(rusqlite::params![
                    record.path,
                    record.modified,
                    record.file_size,
                    sharpness_version,
                    record.verdict,
                    now,
                ])
                .map_err(|error| format!("Failed to save sharpness cache: {error}"))?;
            }
        }

        prune_table_if_needed(&tx, "photo_sharpness_cache")?;
        tx.commit()
            .map_err(|error| format!("Failed to commit sharpness cache: {error}"))
    }

    pub fn get_metadata(
        &self,
        items: &[PhotoCacheLookup],
        metadata_version: i64,
    ) -> Result<Vec<CachedPhotoMetadataRecord>, String> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let expected: HashMap<&str, (i64, i64)> = items
            .iter()
            .map(|item| (item.path.as_str(), (item.modified, item.file_size)))
            .collect();

        let conn = self
            .read_conn
            .lock()
            .map_err(|error| format!("Failed to acquire metadata cache read lock: {error}"))?;
        let mut results = Vec::new();

        for chunk in items.chunks(LOOKUP_CHUNK_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT path, modified, file_size, metadata_json
                 FROM photo_metadata_cache
                 WHERE metadata_version = ?1 AND path IN ({placeholders})"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|error| format!("Failed to prepare metadata cache lookup: {error}"))?;

            let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(chunk.len() + 1);
            params.push(Box::new(metadata_version));
            for item in chunk {
                params.push(Box::new(item.path.clone()));
            }
            let param_refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();

            let rows = stmt
                .query_map(param_refs.as_slice(), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("Failed to query metadata cache: {error}"))?;

            for row in rows {
                let (path, modified, file_size, metadata_json) =
                    row.map_err(|error| format!("Failed to read metadata cache row: {error}"))?;
                if expected.get(path.as_str()) == Some(&(modified, file_size)) {
                    results.push(CachedPhotoMetadataRecord {
                        path,
                        modified,
                        file_size,
                        metadata_json,
                    });
                }
            }
        }

        Ok(results)
    }

    pub fn save_metadata(
        &self,
        records: &[CachedPhotoMetadataRecord],
        metadata_version: i64,
    ) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }

        let now = now_seconds();
        let mut conn = self
            .write_conn
            .lock()
            .map_err(|error| format!("Failed to acquire metadata cache write lock: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("Failed to start metadata cache transaction: {error}"))?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO photo_metadata_cache
                     (path, modified, file_size, metadata_version, metadata_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|error| format!("Failed to prepare metadata cache insert: {error}"))?;

            for record in records {
                stmt.execute(rusqlite::params![
                    record.path,
                    record.modified,
                    record.file_size,
                    metadata_version,
                    record.metadata_json,
                    now,
                ])
                .map_err(|error| format!("Failed to save metadata cache: {error}"))?;
            }
        }

        prune_table_if_needed(&tx, "photo_metadata_cache")?;
        tx.commit()
            .map_err(|error| format!("Failed to commit metadata cache: {error}"))
    }

    pub fn get_culling_states(&self, paths: &[String]) -> Result<Vec<PhotoCullingRecord>, String> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self
            .read_conn
            .lock()
            .map_err(|error| format!("Failed to acquire culling state read lock: {error}"))?;
        let mut results = Vec::new();

        for chunk in paths.chunks(LOOKUP_CHUNK_SIZE) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT path, rating, flag FROM photo_culling_state WHERE path IN ({placeholders})"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|error| format!("Failed to prepare culling state query: {error}"))?;
            let params: Vec<&dyn rusqlite::ToSql> = chunk
                .iter()
                .map(|path| path as &dyn rusqlite::ToSql)
                .collect();

            let rows = stmt
                .query_map(params.as_slice(), |row| {
                    let rating: i64 = row.get(1)?;
                    Ok(PhotoCullingRecord {
                        path: row.get(0)?,
                        rating: rating.clamp(0, 5) as u8,
                        flag: row.get(2)?,
                    })
                })
                .map_err(|error| format!("Failed to query culling states: {error}"))?;

            for row in rows {
                results
                    .push(row.map_err(|error| format!("Failed to decode culling state: {error}"))?);
            }
        }

        Ok(results)
    }

    pub fn set_culling_states(&self, records: &[PhotoCullingRecord]) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }

        let now = now_seconds();
        let mut conn = self
            .write_conn
            .lock()
            .map_err(|error| format!("Failed to acquire culling state write lock: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("Failed to start culling state transaction: {error}"))?;

        {
            let mut upsert = tx
                .prepare(
                    "INSERT OR REPLACE INTO photo_culling_state (path, rating, flag, updated_at)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|error| format!("Failed to prepare culling upsert: {error}"))?;
            let mut delete = tx
                .prepare("DELETE FROM photo_culling_state WHERE path = ?1")
                .map_err(|error| format!("Failed to prepare culling delete: {error}"))?;

            for record in records {
                let rating = record.rating.min(5);
                let flag = match record.flag.as_str() {
                    "pick" => "pick",
                    "reject" => "reject",
                    _ => "none",
                };

                if rating == 0 && flag == "none" {
                    delete
                        .execute([&record.path])
                        .map_err(|error| format!("Failed to delete culling state: {error}"))?;
                } else {
                    upsert
                        .execute(rusqlite::params![record.path, i64::from(rating), flag, now])
                        .map_err(|error| format!("Failed to save culling state: {error}"))?;
                }
            }
        }

        tx.commit()
            .map_err(|error| format!("Failed to commit culling states: {error}"))
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn prune_table_if_needed(tx: &rusqlite::Transaction<'_>, table: &str) -> Result<(), String> {
    let count: i64 = tx
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Failed to count {table}: {error}"))?;
    if count > MAX_CACHED_ROWS {
        let excess = count - MAX_CACHED_ROWS;
        tx.execute(
            &format!(
                "DELETE FROM {table} WHERE path IN (
                    SELECT path FROM {table} ORDER BY updated_at ASC LIMIT ?1
                 )"
            ),
            [excess],
        )
        .map_err(|error| format!("Failed to prune {table}: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        CachedPhotoFeatureRecord, CachedPhotoMetadataRecord, CachedPhotoSharpnessRecord,
        PhotoCacheLookup, PhotoCacheStore,
    };
    use crate::db::schema;
    use base64::Engine as _;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn store() -> PhotoCacheStore {
        let conn = Connection::open_in_memory().expect("in-memory database");
        schema::init(&conn).expect("init schema");
        let shared = Arc::new(Mutex::new(conn));
        PhotoCacheStore::new(shared.clone(), shared)
    }

    #[test]
    fn feature_cache_round_trips_and_invalidates_on_metadata_or_version_change() {
        let store = store();
        let payload = base64::engine::general_purpose::STANDARD.encode(vec![1_u8, 2, 3, 4]);
        store
            .save_features(
                &[CachedPhotoFeatureRecord {
                    path: "/photos/a.arw".to_string(),
                    modified: 100,
                    file_size: 2048,
                    image_width: 6000,
                    image_height: 4000,
                    features_base64: payload.clone(),
                }],
                8,
            )
            .expect("save feature record");

        let hit = store
            .get_features(
                &[PhotoCacheLookup {
                    path: "/photos/a.arw".to_string(),
                    modified: 100,
                    file_size: 2048,
                }],
                8,
            )
            .expect("read feature cache");
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].features_base64, payload);
        assert_eq!(hit[0].image_width, 6000);

        let stale_mtime = store
            .get_features(
                &[PhotoCacheLookup {
                    path: "/photos/a.arw".to_string(),
                    modified: 101,
                    file_size: 2048,
                }],
                8,
            )
            .expect("read stale mtime");
        assert!(stale_mtime.is_empty());

        let stale_version = store
            .get_features(
                &[PhotoCacheLookup {
                    path: "/photos/a.arw".to_string(),
                    modified: 100,
                    file_size: 2048,
                }],
                9,
            )
            .expect("read stale version");
        assert!(stale_version.is_empty());
    }

    #[test]
    fn sharpness_cache_round_trips_and_overwrites_modified_files() {
        let store = store();
        store
            .save_sharpness(
                &[CachedPhotoSharpnessRecord {
                    path: "/photos/b.jpg".to_string(),
                    modified: 200,
                    file_size: 4096,
                    verdict: "sharp".to_string(),
                }],
                1,
            )
            .expect("save sharpness record");

        let hit = store
            .get_sharpness(
                &[PhotoCacheLookup {
                    path: "/photos/b.jpg".to_string(),
                    modified: 200,
                    file_size: 4096,
                }],
                1,
            )
            .expect("query sharpness");
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].verdict, "sharp");

        store
            .save_sharpness(
                &[CachedPhotoSharpnessRecord {
                    path: "/photos/b.jpg".to_string(),
                    modified: 250,
                    file_size: 5000,
                    verdict: "soft".to_string(),
                }],
                1,
            )
            .expect("overwrite sharpness");

        let updated = store
            .get_sharpness(
                &[PhotoCacheLookup {
                    path: "/photos/b.jpg".to_string(),
                    modified: 250,
                    file_size: 5000,
                }],
                1,
            )
            .expect("query overwritten sharpness");
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].verdict, "soft");
    }

    #[test]
    fn metadata_cache_round_trips_and_invalidates_on_file_change() {
        let store = store();
        let json = r#"{"width":6000,"height":4000,"iso":"100","aperture":"2.8"}"#.to_string();
        store
            .save_metadata(
                &[CachedPhotoMetadataRecord {
                    path: "/photos/c.arw".to_string(),
                    modified: 500,
                    file_size: 40_000_000,
                    metadata_json: json.clone(),
                }],
                1,
            )
            .expect("save metadata");

        let hit = store
            .get_metadata(
                &[PhotoCacheLookup {
                    path: "/photos/c.arw".to_string(),
                    modified: 500,
                    file_size: 40_000_000,
                }],
                1,
            )
            .expect("get metadata");
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].metadata_json, json);

        let stale = store
            .get_metadata(
                &[PhotoCacheLookup {
                    path: "/photos/c.arw".to_string(),
                    modified: 501,
                    file_size: 40_000_000,
                }],
                1,
            )
            .expect("get stale metadata");
        assert!(stale.is_empty());
    }

    #[test]
    fn culling_state_round_trips_and_clears_default_entries() {
        let store = store();
        store
            .set_culling_states(&[
                super::PhotoCullingRecord {
                    path: "/photos/keep.arw".to_string(),
                    rating: 5,
                    flag: "pick".to_string(),
                },
                super::PhotoCullingRecord {
                    path: "/photos/drop.arw".to_string(),
                    rating: 1,
                    flag: "reject".to_string(),
                },
            ])
            .expect("save culling states");

        let loaded = store
            .get_culling_states(&[
                "/photos/keep.arw".to_string(),
                "/photos/drop.arw".to_string(),
            ])
            .expect("load culling states");
        assert_eq!(loaded.len(), 2);

        store
            .set_culling_states(&[super::PhotoCullingRecord {
                path: "/photos/drop.arw".to_string(),
                rating: 0,
                flag: "none".to_string(),
            }])
            .expect("clear default culling state");

        let after_clear = store
            .get_culling_states(&[
                "/photos/keep.arw".to_string(),
                "/photos/drop.arw".to_string(),
            ])
            .expect("reload culling states");
        assert_eq!(after_clear.len(), 1);
        assert_eq!(after_clear[0].path, "/photos/keep.arw");
        assert_eq!(after_clear[0].rating, 5);
        assert_eq!(after_clear[0].flag, "pick");
    }
}
