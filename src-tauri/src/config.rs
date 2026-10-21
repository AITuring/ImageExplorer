//! 应用配置常量
//!
//! 集中管理所有可配置项

// ============================================
// 索引相关配置
// ============================================

/// 索引过期天数（超过此天数将重建索引）
pub const INDEX_EXPIRE_DAYS: i64 = 7;

/// 索引延迟启动秒数（等待 UI 加载完成）
pub const INDEX_BUILD_DELAY_SECS: u64 = 3;

/// 智能分类默认返回数量
#[allow(dead_code)] // 预留供前端使用
pub const SMART_FILES_DEFAULT_LIMIT: usize = 200;

/// 搜索默认返回数量
#[allow(dead_code)] // 预留供前端使用
pub const SEARCH_DEFAULT_LIMIT: usize = 50;

/// 索引进度通知间隔（每 N 个文件）
pub const INDEX_PROGRESS_INTERVAL: usize = 1000;

/// 索引扫描 CPU 降速间隔（每 N 个文件休眠）
pub const INDEX_THROTTLE_INTERVAL: usize = 2000;

/// 索引扫描 CPU 降速时间（毫秒）
pub const INDEX_THROTTLE_MS: u64 = 5;

// ============================================
// 排除目录配置
// ============================================

/// 索引时排除的目录模式
pub const INDEX_EXCLUDE_PATTERNS: &[&str] = &[
    "/Library/Caches/",
    "/Library/Logs/",
    "/.Trash/",
    "/node_modules/",
    "/.git/",
    "/.cargo/",
    "/.npm/",
    "/.pnpm-store/",
    "/target/debug/",
    "/target/release/",
];

/// Index scans and incremental updates must apply the same path exclusions.
/// Hidden entries remain indexable; visibility is a separate file attribute.
pub fn is_index_excluded(path: &std::path::Path) -> bool {
    let path = path.to_string_lossy().replace('\\', "/");
    INDEX_EXCLUDE_PATTERNS
        .iter()
        .any(|pattern| path.contains(pattern) || path.ends_with(pattern.trim_end_matches('/')))
}

#[cfg(test)]
mod tests {
    use super::is_index_excluded;
    use std::path::Path;

    #[test]
    fn excluded_directory_roots_and_descendants_share_the_same_boundary() {
        assert!(is_index_excluded(Path::new("/tmp/project/node_modules")));
        assert!(is_index_excluded(Path::new(
            "/tmp/project/node_modules/pkg/file.js"
        )));
        assert!(!is_index_excluded(Path::new(
            "/tmp/project/my_node_modules/file.js"
        )));
    }
}
