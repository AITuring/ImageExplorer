//! Adobe Lightroom / Capture One compatible `.xmp` sidecar exporter.
//!
//! Writes or merges `xmp:Rating` and `xmp:Label` without disturbing any
//! existing Lightroom develop adjustments (`crs:*`) in an existing sidecar file.

use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Map macOS Finder color tag names (English or Chinese) to standard Adobe XMP
/// color labels recognized by Lightroom and Capture One.
pub fn finder_tags_to_xmp_label(tags: &[String]) -> Option<&'static str> {
    for tag in tags {
        let normalized = tag.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "red" | "红色" => return Some("Red"),
            "yellow" | "黄色" => return Some("Yellow"),
            "green" | "绿色" => return Some("Green"),
            "blue" | "蓝色" => return Some("Blue"),
            "purple" | "紫色" => return Some("Purple"),
            _ => {}
        }
    }
    None
}

fn upsert_rdf_attr(xml: &str, attr_name: &str, value: Option<&str>) -> String {
    let attr_pattern = format!(r#"\s+{}=\"[^\"]*\""#, regex::escape(attr_name));
    let attr_re = Regex::new(&attr_pattern).expect("valid attr regex");

    if let Some(val) = value {
        let replacement = format!(r#" {attr_name}="{val}""#);
        if attr_re.is_match(xml) {
            return attr_re.replace(xml, replacement.as_str()).into_owned();
        }
        static DESC_OPEN_RE: OnceLock<Regex> = OnceLock::new();
        let desc_re = DESC_OPEN_RE.get_or_init(|| {
            Regex::new(r"<rdf:Description\b").expect("valid rdf:Description regex")
        });
        if desc_re.is_match(xml) {
            return desc_re
                .replace(xml, format!("<rdf:Description{replacement}").as_str())
                .into_owned();
        }
    } else if attr_re.is_match(xml) {
        return attr_re.replace(xml, "").into_owned();
    }

    xml.to_string()
}

/// Build a fresh standards-compliant XMP packet or merge `xmp:Rating` /
/// `xmp:Label` into an existing `.xmp` document.
pub fn build_or_merge_xmp(
    existing_xml: Option<&str>,
    rating: u8,
    flag: &str,
    label: Option<&str>,
) -> String {
    // Lightroom convention: rejected photos can use rating -1 when unrated.
    let rating_str = if flag == "reject" && rating == 0 {
        Some("-1".to_string())
    } else if rating > 0 {
        Some(rating.min(5).to_string())
    } else {
        None
    };

    if let Some(existing) = existing_xml.filter(|s| s.contains("<rdf:Description")) {
        let with_rating = upsert_rdf_attr(existing, "xmp:Rating", rating_str.as_deref());
        let with_label = upsert_rdf_attr(&with_rating, "xmp:Label", label);
        return with_label;
    }

    let mut attrs = Vec::new();
    if let Some(ref rating_val) = rating_str {
        attrs.push(format!(r#"xmp:Rating="{rating_val}""#));
    }
    if let Some(label_val) = label {
        attrs.push(format!(r#"xmp:Label="{label_val}""#));
    }
    let attr_block = if attrs.is_empty() {
        String::new()
    } else {
        format!("\n    {}", attrs.join("\n    "))
    };

    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="ImageExplorer">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"{attr_block}/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
    )
}

pub fn sidecar_path_for(photo_path: &Path) -> PathBuf {
    photo_path.with_extension("xmp")
}

/// Atomically write or update `<stem>.xmp` next to `photo_path`.
pub fn write_xmp_sidecar(
    photo_path: &Path,
    rating: u8,
    flag: &str,
    label: Option<&str>,
) -> Result<PathBuf, String> {
    let xmp_path = sidecar_path_for(photo_path);
    let existing = fs::read_to_string(&xmp_path).ok();
    let content = build_or_merge_xmp(existing.as_deref(), rating, flag, label);

    let parent = xmp_path
        .parent()
        .ok_or_else(|| format!("Invalid sidecar path {}", xmp_path.display()))?;
    let file_name = xmp_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid sidecar filename".to_string())?;
    let tmp_path = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));

    fs::write(&tmp_path, content.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", tmp_path.display()))?;
    fs::rename(&tmp_path, &xmp_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to finalize {}: {error}", xmp_path.display())
    })?;

    Ok(xmp_path)
}

#[cfg(test)]
mod tests {
    use super::{build_or_merge_xmp, finder_tags_to_xmp_label, write_xmp_sidecar};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn maps_english_and_chinese_finder_tags_to_xmp_labels() {
        assert_eq!(
            finder_tags_to_xmp_label(&["绿色".to_string()]),
            Some("Green")
        );
        assert_eq!(finder_tags_to_xmp_label(&["Red".to_string()]), Some("Red"));
        assert_eq!(finder_tags_to_xmp_label(&["Custom".to_string()]), None);
    }

    #[test]
    fn generates_fresh_xmp_and_merges_without_clobbering_lightroom_edits() {
        let fresh = build_or_merge_xmp(None, 4, "pick", Some("Green"));
        assert!(fresh.contains(r#"xmp:Rating="4""#));
        assert!(fresh.contains(r#"xmp:Label="Green""#));

        let existing = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmp:Rating="2" crs:Exposure2012="+0.50"/>
 </rdf:RDF>
</x:xmpmeta>"#;

        let merged = build_or_merge_xmp(Some(existing), 5, "pick", Some("Blue"));
        assert!(merged.contains(r#"xmp:Rating="5""#));
        assert!(merged.contains(r#"xmp:Label="Blue""#));
        assert!(merged.contains(r#"crs:Exposure2012="+0.50""#));
    }

    #[test]
    fn writes_sidecar_next_to_raw_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("imageexplorer-xmp-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        let raw_path = dir.join("DSC0010.ARW");
        fs::write(&raw_path, b"raw").expect("write raw");

        let written = write_xmp_sidecar(&raw_path, 5, "pick", Some("Green")).expect("write xmp");
        assert_eq!(written, dir.join("DSC0010.xmp"));
        let xml = fs::read_to_string(&written).expect("read xmp");
        assert!(xml.contains(r#"xmp:Rating="5""#));
        assert!(xml.contains(r#"xmp:Label="Green""#));

        fs::remove_dir_all(dir).expect("cleanup temp dir");
    }
}
