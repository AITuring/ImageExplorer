use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CD_SIGNATURE: u32 = 0x0201_4b50;
const MAX_PREVIEW_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipArchivePreview {
    pub total_entries: usize,
    pub total_compressed: u64,
    pub total_uncompressed: u64,
    pub truncated: bool,
    pub entries: Vec<ZipEntryInfo>,
}

fn read_u16_le(buf: &[u8], offset: usize) -> Option<u16> {
    let slice: [u8; 2] = buf.get(offset..offset + 2)?.try_into().ok()?;
    Some(u16::from_le_bytes(slice))
}

fn read_u32_le(buf: &[u8], offset: usize) -> Option<u32> {
    let slice: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(slice))
}

pub fn parse_zip_central_directory(path: &Path) -> Result<ZipArchivePreview, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open ZIP archive: {e}"))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("Failed to inspect ZIP archive: {e}"))?
        .len();
    if file_len < 22 {
        return Err("File is too small to be a valid ZIP archive".to_string());
    }

    // Search tail (up to 64 KiB + 22 bytes) for the End-of-Central-Directory record.
    let tail_len = file_len.min(65_557) as usize;
    let tail_start = file_len - tail_len as u64;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("Failed to seek ZIP archive: {e}"))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("Failed to read ZIP trailer: {e}"))?;

    let mut eocd_pos: Option<usize> = None;
    for pos in (0..=tail.len() - 22).rev() {
        if read_u32_le(&tail, pos) == Some(EOCD_SIGNATURE) {
            let comment_len = read_u16_le(&tail, pos + 20).unwrap_or(0) as usize;
            if pos + 22 + comment_len == tail.len() {
                eocd_pos = Some(pos);
                break;
            }
        }
    }
    let eocd_pos = eocd_pos.ok_or_else(|| "Not a valid ZIP archive (EOCD missing)".to_string())?;

    let cd_size = read_u32_le(&tail, eocd_pos + 12).unwrap_or(0) as u64;
    let cd_offset = read_u32_le(&tail, eocd_pos + 16).unwrap_or(0) as u64;

    if cd_offset == u32::MAX as u64 || cd_size == u32::MAX as u64 {
        return Err("ZIP64 archives are not supported for inline preview".to_string());
    }
    if cd_offset.saturating_add(cd_size) > file_len || cd_size > 64 * 1024 * 1024 {
        return Err("ZIP central directory bounds are invalid".to_string());
    }

    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("Failed to seek ZIP directory: {e}"))?;
    let mut cd_buf = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd_buf)
        .map_err(|e| format!("Failed to read ZIP directory: {e}"))?;

    let mut offset = 0usize;
    let mut entries = Vec::new();
    let mut total_entries = 0usize;
    let mut total_compressed = 0u64;
    let mut total_uncompressed = 0u64;

    while offset + 46 <= cd_buf.len() {
        if read_u32_le(&cd_buf, offset) != Some(CD_SIGNATURE) {
            break;
        }
        let compressed = read_u32_le(&cd_buf, offset + 20).unwrap_or(0) as u64;
        let uncompressed = read_u32_le(&cd_buf, offset + 24).unwrap_or(0) as u64;
        let name_len = read_u16_le(&cd_buf, offset + 28).unwrap_or(0) as usize;
        let extra_len = read_u16_le(&cd_buf, offset + 30).unwrap_or(0) as usize;
        let comment_len = read_u16_le(&cd_buf, offset + 32).unwrap_or(0) as usize;

        let name_start = offset + 46;
        let name_end = name_start + name_len;
        if name_end > cd_buf.len() {
            break;
        }
        let raw_name = String::from_utf8_lossy(&cd_buf[name_start..name_end]).into_owned();
        let next_offset = name_end
            .saturating_add(extra_len)
            .saturating_add(comment_len);
        offset = next_offset;

        // Skip macOS __MACOSX resource fork clutter in preview listing
        if raw_name.starts_with("__MACOSX/") {
            continue;
        }
        let is_dir = raw_name.ends_with('/');
        total_entries += 1;
        total_compressed = total_compressed.saturating_add(compressed);
        total_uncompressed = total_uncompressed.saturating_add(uncompressed);

        if entries.len() < MAX_PREVIEW_ENTRIES {
            entries.push(ZipEntryInfo {
                name: raw_name,
                is_dir,
                compressed_size: compressed,
                uncompressed_size: uncompressed,
            });
        }
    }

    entries.sort_by_key(|a| a.name.to_lowercase());

    Ok(ZipArchivePreview {
        total_entries,
        total_compressed,
        total_uncompressed,
        truncated: total_entries > entries.len(),
        entries,
    })
}

#[tauri::command]
pub async fn list_zip_entries(path: String) -> Result<ZipArchivePreview, String> {
    tauri::async_runtime::spawn_blocking(move || parse_zip_central_directory(Path::new(&path)))
        .await
        .map_err(|e| format!("ZIP preview task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn build_minimal_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();

        for (name, data) in files {
            let local_offset = out.len() as u32;
            let name_bytes = name.as_bytes();
            let size = data.len() as u32;

            // Local file header (stored, method 0)
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // crc
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(data);

            // Central directory header
            cd.extend_from_slice(&CD_SIGNATURE.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u32.to_le_bytes());
            cd.extend_from_slice(&size.to_le_bytes());
            cd.extend_from_slice(&size.to_le_bytes());
            cd.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u32.to_le_bytes());
            cd.extend_from_slice(&local_offset.to_le_bytes());
            cd.extend_from_slice(name_bytes);
        }

        let cd_offset = out.len() as u32;
        let cd_size = cd.len() as u32;
        out.extend_from_slice(&cd);

        // EOCD
        out.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn parses_zip_central_directory_and_filters_macosx_metadata() {
        let zip_bytes = build_minimal_zip(&[
            ("photos/", b""),
            ("photos/shot1.jpg", b"hello-world-12345"),
            ("__MACOSX/._shot1.jpg", b"junk"),
            ("readme.txt", b"readme"),
        ]);
        let unique = format!(
            "ie_zip_preview_{}_{}.zip",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        let mut f = File::create(&path).unwrap();
        f.write_all(&zip_bytes).unwrap();
        drop(f);

        let preview = parse_zip_central_directory(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(preview.total_entries, 3);
        assert_eq!(preview.total_uncompressed, 23);
        assert!(!preview.truncated);
        assert_eq!(
            preview
                .entries
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            vec!["photos/", "photos/shot1.jpg", "readme.txt"]
        );
    }
}
