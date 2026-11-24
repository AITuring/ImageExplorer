//! Zero-copy multi-brand RAW embedded JPEG preview extractor.
//!
//! Extracts the largest camera-embedded JPEG preview directly from RAW files
//! without invoking full sensor demosaicing:
//! - TIFF-based RAWs (ARW, CR2, NEF, NRW, DNG, PEF, SRW, DCR, KDC, 3FR, IIQ)
//!   including chained IFDs, `SubIFDs` (`0x014A`), `JPEGInterchangeFormat`
//!   (`0x0201`/`0x0202`), and single-strip JPEG (`0x0111`/`0x0117`).
//! - Olympus `.ORF` (`0x4F52`/`0x5352` TIFF magic) and Panasonic `.RW2`
//!   (`0x0055` TIFF magic + `JpgFromRaw` tag `0x002E`).
//! - Fujifilm `.RAF` (`"FUJIFILMCCD-RAW "` container header).
//! - Canon `.CR3` (ISO-BMFF / MP4 `PRVW`, `THMB`, and `mdat` JPEG preview track).

use std::collections::HashSet;
use std::fs::File;
use std::path::Path;

/// Minimum byte length for a camera-embedded preview to be preferred over a
/// tiny 160x120 EXIF thumbnail in real files.
pub const DEFAULT_MIN_PREVIEW_BYTES: usize = 32 * 1024;

const MAX_IFDS_VISITED: usize = 128;
const MAX_ISO_BOX_DEPTH: usize = 16;

pub fn is_supported_raw_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "arw"
            | "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "dcr"
            | "kdc"
            | "3fr"
            | "iiq"
            | "x3f"
            | "dng"
    )
}

#[cfg(unix)]
struct MappedFile {
    ptr: *mut libc::c_void,
    len: usize,
}

#[cfg(unix)]
impl MappedFile {
    fn open(path: &Path) -> Option<Self> {
        use std::os::unix::io::AsRawFd;

        let file = File::open(path).ok()?;
        let len = usize::try_from(file.metadata().ok()?.len()).ok()?;
        if len < 16 {
            return None;
        }
        // SAFETY: Mapping an open read-only file descriptor with MAP_PRIVATE
        // does not mutate the file; the pointer stays valid until `munmap` in Drop.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_PRIVATE,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        Some(Self { ptr, len })
    }

    fn as_slice(&self) -> &[u8] {
        // SAFETY: `self.ptr` was successfully mapped for `self.len` bytes.
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

#[cfg(unix)]
impl Drop for MappedFile {
    fn drop(&mut self) {
        // SAFETY: `self.ptr` and `self.len` came from a successful `libc::mmap`.
        unsafe {
            libc::munmap(self.ptr, self.len);
        }
    }
}

/// Extract the largest embedded JPEG preview from a RAW file on disk.
/// Uses `mmap` on Unix so large 50–100MB sensor payloads are never copied into heap RAM.
pub fn extract_embedded_jpeg_from_path(path: &Path) -> Option<Vec<u8>> {
    let ext = path.extension().and_then(|e| e.to_str())?;
    if !is_supported_raw_extension(ext) {
        return None;
    }

    #[cfg(unix)]
    {
        let mapped = MappedFile::open(path)?;
        let jpeg = extract_embedded_jpeg(mapped.as_slice(), DEFAULT_MIN_PREVIEW_BYTES)?;
        Some(jpeg.to_vec())
    }

    #[cfg(not(unix))]
    {
        let bytes = std::fs::read(path).ok()?;
        let jpeg = extract_embedded_jpeg(&bytes, DEFAULT_MIN_PREVIEW_BYTES)?;
        Some(jpeg.to_vec())
    }
}

/// Extract the largest valid embedded JPEG slice from raw file bytes.
pub fn extract_embedded_jpeg(data: &[u8], min_length: usize) -> Option<&[u8]> {
    if data.len() < 16 {
        return None;
    }

    // 1. Fujifilm RAF
    if data.starts_with(b"FUJIFILMCCD-RAW ") {
        return extract_raf_jpeg(data, min_length);
    }

    // 2. Canon CR3 (ISO-BMFF container)
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return extract_cr3_jpeg(data, min_length);
    }

    // 3. TIFF-based RAWs (ARW, CR2, NEF, NRW, DNG, ORF, RW2, PEF, SRW, 3FR, IIQ, ...)
    extract_tiff_jpeg(data, min_length)
}

/// Maximum number of leading header bytes scanned to verify a candidate JPEG's
/// SOF marker without faulting megabytes of mmap'd RAW sensor data from disk.
const MAX_JPEG_HEADER_SCAN_BYTES: usize = 64 * 1024;

/// Verify that `slice` is a standard 8-bit displayable preview JPEG (SOF0/SOF1/SOF2
/// with 1 or 3 color components) and NOT a Lossless JPEG (SOF3 `0xFFC3`, etc.)
/// Bayer RAW sensor strip such as Sony ILCE-7M4 lossless ARW, Canon CR2, or DNG.
fn is_valid_jpeg_slice(slice: &[u8], min_length: usize) -> bool {
    if slice.len() < min_length.max(16) || slice[0] != 0xFF || slice[1] != 0xD8 || slice[2] != 0xFF
    {
        return false;
    }

    let scan_limit = slice.len().min(MAX_JPEG_HEADER_SCAN_BYTES);
    let mut pos = 2usize;
    while pos + 1 < scan_limit {
        // Advance to marker prefix 0xFF
        if slice[pos] != 0xFF {
            return false;
        }
        while pos < scan_limit && slice[pos] == 0xFF {
            pos += 1;
        }
        if pos >= scan_limit {
            return false;
        }
        let marker = slice[pos];
        pos += 1;

        match marker {
            // Standalone markers with no length payload
            0x00 | 0x01 | 0xD0..=0xD8 => continue,
            // Start of Scan or End of Image before seeing an acceptable SOF
            0xD9 | 0xDA => return false,
            // Displayable DCT Start-of-Frame markers: Baseline / Extended / Progressive
            0xC0..=0xC2 => {
                if pos + 8 > scan_limit {
                    return false;
                }
                let seg_len = u16::from_be_bytes([slice[pos], slice[pos + 1]]) as usize;
                let precision = slice[pos + 2];
                let height = u16::from_be_bytes([slice[pos + 3], slice[pos + 4]]);
                let width = u16::from_be_bytes([slice[pos + 5], slice[pos + 6]]);
                let components = slice[pos + 7];
                return seg_len >= 8
                    && precision == 8
                    && width > 0
                    && height > 0
                    && matches!(components, 1 | 3);
            }
            // Lossless / hierarchical / arithmetic SOF markers (e.g. SOF3 0xC3 Bayer RAW)
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return false,
            // Any other marker segment (APPn, DQT, DHT, DRI, COM, etc.)
            _ => {
                if pos + 2 > scan_limit {
                    return false;
                }
                let seg_len = u16::from_be_bytes([slice[pos], slice[pos + 1]]) as usize;
                if seg_len < 2 {
                    return false;
                }
                pos = match pos.checked_add(seg_len) {
                    Some(next) => next,
                    None => return false,
                };
            }
        }
    }

    false
}

fn read_u16(data: &[u8], offset: usize, little_endian: bool) -> Option<u16> {
    let bytes: [u8; 2] = data.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(if little_endian {
        u16::from_le_bytes(bytes)
    } else {
        u16::from_be_bytes(bytes)
    })
}

fn read_u32(data: &[u8], offset: usize, little_endian: bool) -> Option<u32> {
    let bytes: [u8; 4] = data.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(if little_endian {
        u32::from_le_bytes(bytes)
    } else {
        u32::from_be_bytes(bytes)
    })
}

fn read_be_u32(data: &[u8], offset: usize) -> Option<u32> {
    read_u32(data, offset, false)
}

fn read_be_u64(data: &[u8], offset: usize) -> Option<u64> {
    let bytes: [u8; 8] = data.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
}

fn extract_raf_jpeg(data: &[u8], min_length: usize) -> Option<&[u8]> {
    let jpeg_offset = read_be_u32(data, 84)? as usize;
    let jpeg_length = read_be_u32(data, 88)? as usize;
    let slice = data.get(jpeg_offset..jpeg_offset.checked_add(jpeg_length)?)?;
    is_valid_jpeg_slice(slice, min_length).then_some(slice)
}

fn consider_candidate<'a>(
    best: &mut Option<&'a [u8]>,
    data: &'a [u8],
    offset: usize,
    length: usize,
    min_length: usize,
) {
    let Some(end) = offset.checked_add(length) else {
        return;
    };
    let Some(slice) = data.get(offset..end) else {
        return;
    };
    if !is_valid_jpeg_slice(slice, min_length) {
        return;
    }
    if best.is_none_or(|current| slice.len() > current.len()) {
        *best = Some(slice);
    }
}

fn read_tiff_scalar_u32(
    data: &[u8],
    tag_offset: usize,
    field_type: u16,
    count: u32,
    little_endian: bool,
) -> Option<u32> {
    if count != 1 {
        return None;
    }
    match field_type {
        // SHORT (2 bytes)
        3 => read_u16(data, tag_offset + 8, little_endian).map(u32::from),
        // LONG (4 bytes) or IFD (13)
        4 | 13 => read_u32(data, tag_offset + 8, little_endian),
        _ => None,
    }
}

fn extract_tiff_jpeg(data: &[u8], min_length: usize) -> Option<&[u8]> {
    let little_endian = match data.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };

    let magic = read_u16(data, 2, little_endian)?;
    // 42 = standard TIFF (ARW, CR2, NEF, DNG, PEF, SRW, ...)
    // 0x4F52 ("RO") / 0x5352 ("RS") = Olympus ORF
    // 0x0055 (85) = Panasonic RW2
    if !matches!(magic, 42 | 0x4F52 | 0x5352 | 0x0055) {
        return None;
    }

    let first_ifd = read_u32(data, 4, little_endian)?;
    let mut stack = vec![first_ifd];
    let mut visited = HashSet::new();
    let mut best: Option<&[u8]> = None;

    while let Some(ifd_offset_u32) = stack.pop() {
        if ifd_offset_u32 == 0 || visited.len() >= MAX_IFDS_VISITED {
            continue;
        }
        if !visited.insert(ifd_offset_u32) {
            continue;
        }
        let ifd_offset = ifd_offset_u32 as usize;
        let Some(entry_count) = read_u16(data, ifd_offset, little_endian) else {
            continue;
        };
        let entries_start = ifd_offset.saturating_add(2);
        let Some(entries_bytes) = (entry_count as usize).checked_mul(12) else {
            continue;
        };
        let Some(next_ifd_pos) = entries_start.checked_add(entries_bytes) else {
            continue;
        };
        if next_ifd_pos > data.len() {
            continue;
        }

        let mut jpeg_offset: Option<usize> = None;
        let mut jpeg_length: Option<usize> = None;
        let mut strip_offset: Option<usize> = None;
        let mut strip_length: Option<usize> = None;
        let mut photometric: Option<u32> = None;

        for idx in 0..entry_count as usize {
            let tag_offset = entries_start + idx * 12;
            let Some(tag_id) = read_u16(data, tag_offset, little_endian) else {
                continue;
            };
            let Some(field_type) = read_u16(data, tag_offset + 2, little_endian) else {
                continue;
            };
            let Some(count) = read_u32(data, tag_offset + 4, little_endian) else {
                continue;
            };

            match tag_id {
                // JPEGInterchangeFormat / Length
                0x0201 => {
                    if let Some(v) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        jpeg_offset = Some(v as usize);
                    }
                }
                0x0202 => {
                    if let Some(v) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        jpeg_length = Some(v as usize);
                    }
                }
                // PhotometricInterpretation (32803 = CFA Bayer, 34892 = LinearRaw)
                0x0106 => {
                    if let Some(v) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        photometric = Some(v);
                    }
                }
                // Single-strip JPEG (used by Nikon NEF, Canon CR2, DNG)
                0x0111 => {
                    if let Some(v) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        strip_offset = Some(v as usize);
                    }
                }
                0x0117 => {
                    if let Some(v) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        strip_length = Some(v as usize);
                    }
                }
                // Panasonic RW2 JpgFromRaw (type BYTE=1 or UNDEFINED=7)
                0x002E if matches!(field_type, 1 | 7) && count as usize >= min_length => {
                    if let Some(val_offset) = read_u32(data, tag_offset + 8, little_endian) {
                        consider_candidate(
                            &mut best,
                            data,
                            val_offset as usize,
                            count as usize,
                            min_length,
                        );
                    }
                }
                // SubIFDs (0x014A) — may hold 1 or multiple u32 offsets
                0x014A if matches!(field_type, 4 | 13) && count > 0 && count <= 32 => {
                    if count == 1 {
                        if let Some(sub) = read_u32(data, tag_offset + 8, little_endian) {
                            stack.push(sub);
                        }
                    } else if let Some(arr_offset) = read_u32(data, tag_offset + 8, little_endian) {
                        for sub_idx in 0..count as usize {
                            if let Some(sub) =
                                read_u32(data, arr_offset as usize + sub_idx * 4, little_endian)
                            {
                                stack.push(sub);
                            }
                        }
                    }
                }
                // ExifIFD (0x8769)
                0x8769 => {
                    if let Some(sub) =
                        read_tiff_scalar_u32(data, tag_offset, field_type, count, little_endian)
                    {
                        stack.push(sub);
                    }
                }
                _ => {}
            }
        }

        if let (Some(off), Some(len)) = (jpeg_offset, jpeg_length) {
            consider_candidate(&mut best, data, off, len, min_length);
        }
        let is_raw_sensor_ifd = matches!(photometric, Some(32803 | 34892));
        if !is_raw_sensor_ifd {
            if let (Some(off), Some(len)) = (strip_offset, strip_length) {
                consider_candidate(&mut best, data, off, len, min_length);
            }
        }

        if let Some(next_ifd) = read_u32(data, next_ifd_pos, little_endian) {
            if next_ifd != 0 {
                stack.push(next_ifd);
            }
        }
    }

    best
}

const CANON_CR3_UUID_PREVIEW: [u8; 16] = [
    0xEA, 0xF4, 0x2B, 0x5E, 0x1C, 0x98, 0x4B, 0x88, 0xB9, 0xFB, 0xB7, 0xDC, 0x40, 0x6E, 0x4D, 0x16,
];
const CANON_CR3_UUID_META: [u8; 16] = [
    0x85, 0xC0, 0xB6, 0x87, 0x82, 0x0F, 0x11, 0xE0, 0x81, 0x11, 0xF4, 0xCE, 0x46, 0x2B, 0x6A, 0x48,
];

fn extract_cr3_jpeg(data: &[u8], min_length: usize) -> Option<&[u8]> {
    let mut best: Option<&[u8]> = None;
    scan_iso_boxes(data, 0, data.len(), 0, min_length, &mut best);
    best
}

fn scan_iso_boxes<'a>(
    data: &'a [u8],
    start: usize,
    end: usize,
    depth: usize,
    min_length: usize,
    best: &mut Option<&'a [u8]>,
) {
    if depth >= MAX_ISO_BOX_DEPTH || start >= end || end > data.len() {
        return;
    }

    let mut pos = start;
    while pos + 8 <= end {
        let Some(size32) = read_be_u32(data, pos) else {
            break;
        };
        let box_type = &data[pos + 4..pos + 8];
        let (header_len, box_size) = if size32 == 1 {
            let Some(size64) = read_be_u64(data, pos + 8) else {
                break;
            };
            let Ok(size_usize) = usize::try_from(size64) else {
                break;
            };
            (16usize, size_usize)
        } else if size32 == 0 {
            (8usize, end - pos)
        } else {
            (8usize, size32 as usize)
        };

        if box_size < header_len || pos + box_size > end {
            break;
        }

        let payload_start = pos + header_len;
        let payload_end = pos + box_size;

        match box_type {
            b"moov" | b"trak" | b"mdia" | b"minf" => {
                scan_iso_boxes(
                    data,
                    payload_start,
                    payload_end,
                    depth + 1,
                    min_length,
                    best,
                );
            }
            b"stbl" => {
                scan_cr3_stbl_for_jpeg(data, payload_start, payload_end, min_length, best);
            }
            b"uuid" if payload_end - payload_start >= 16 => {
                let uuid = &data[payload_start..payload_start + 16];
                if uuid == CANON_CR3_UUID_PREVIEW || uuid == CANON_CR3_UUID_META {
                    let inner_start = payload_start + 16;
                    // Canon preview UUID wraps a PRVW box at +8 bytes after the UUID
                    // (or directly nested boxes). Check both layouts safely.
                    scan_iso_boxes(data, inner_start, payload_end, depth + 1, min_length, best);
                    if inner_start + 8 < payload_end {
                        scan_iso_boxes(
                            data,
                            inner_start + 8,
                            payload_end,
                            depth + 1,
                            min_length,
                            best,
                        );
                    }
                }
            }
            b"PRVW" | b"THMB" => {
                // Canon PRVW/THMB boxes start with a small fixed header (16 bytes)
                // followed immediately by JPEG bytes (FF D8 FF).
                let probe_end = (payload_start + 32).min(payload_end);
                for offset in payload_start..probe_end.saturating_sub(2) {
                    if data[offset] == 0xFF && data[offset + 1] == 0xD8 && data[offset + 2] == 0xFF
                    {
                        consider_candidate(best, data, offset, payload_end - offset, min_length);
                        break;
                    }
                }
            }
            _ => {}
        }

        pos = payload_end;
    }
}

/// Inspect a `stbl` box inside Canon CR3 (`stco`/`co64` + `stsz`) to locate
/// full-resolution JPEG frames stored in `mdat`.
fn scan_cr3_stbl_for_jpeg<'a>(
    data: &'a [u8],
    start: usize,
    end: usize,
    min_length: usize,
    best: &mut Option<&'a [u8]>,
) {
    let mut chunk_offset: Option<usize> = None;
    let mut sample_size: Option<usize> = None;

    let mut pos = start;
    while pos + 8 <= end {
        let Some(size32) = read_be_u32(data, pos) else {
            break;
        };
        let box_size = size32 as usize;
        if box_size < 8 || pos + box_size > end {
            break;
        }
        let box_type = &data[pos + 4..pos + 8];
        let payload = pos + 8;

        match box_type {
            // stco: version(1)+flags(3)+entry_count(4)+offset0(4)
            b"stco" if box_size >= 20 => {
                if read_be_u32(data, payload + 4).unwrap_or(0) >= 1 {
                    if let Some(off) = read_be_u32(data, payload + 8) {
                        chunk_offset = Some(off as usize);
                    }
                }
            }
            // co64: version(1)+flags(3)+entry_count(4)+offset0(8)
            b"co64" if box_size >= 24 => {
                if read_be_u32(data, payload + 4).unwrap_or(0) >= 1 {
                    if let Some(off) = read_be_u64(data, payload + 8) {
                        chunk_offset = usize::try_from(off).ok();
                    }
                }
            }
            // stsz: version(1)+flags(3)+sample_size(4)+sample_count(4)+entry0(4)
            b"stsz" if box_size >= 20 => {
                let uniform = read_be_u32(data, payload + 4).unwrap_or(0);
                if uniform > 0 {
                    sample_size = Some(uniform as usize);
                } else if box_size >= 24 && read_be_u32(data, payload + 8).unwrap_or(0) >= 1 {
                    if let Some(first_size) = read_be_u32(data, payload + 12) {
                        sample_size = Some(first_size as usize);
                    }
                }
            }
            _ => {}
        }

        pos += box_size;
    }

    if let (Some(off), Some(len)) = (chunk_offset, sample_size) {
        consider_candidate(best, data, off, len, min_length);
    }
}

#[cfg(test)]
mod tests {
    use super::extract_embedded_jpeg;

    fn fake_jpeg(payload_len: usize, fill: u8) -> Vec<u8> {
        // Minimal valid 8-bit 3-component baseline JPEG (SOI + SOF0 + padding + EOI)
        let mut out = vec![
            0xFF, 0xD8, // SOI
            0xFF, 0xC0, // SOF0 (Baseline DCT)
            0x00, 0x11, // length = 17
            0x08, // 8-bit precision
            0x00, 0x10, // height = 16
            0x00, 0x10, // width = 16
            0x03, // 3 components (YCbCr)
            0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        ];
        let target_body = payload_len.saturating_sub(2).max(out.len());
        out.resize(target_body, fill);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    fn fake_lossless_sof3_raw_strip(payload_len: usize, fill: u8) -> Vec<u8> {
        // Mirrors Sony ILCE-7M4 lossless-compressed ARW Bayer strip:
        // SOI + SOF3 (0xFFC3), 14-bit precision (0x0E), 4 CFA components.
        let mut out = vec![
            0xFF, 0xD8, // SOI
            0xFF, 0xC3, // SOF3 (Lossless Huffman)
            0x00, 0x14, // length = 20
            0x0E, // 14-bit precision
            0x01, 0x00, // height = 256
            0x01, 0x00, // width = 256
            0x04, // 4 CFA components
            0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0x04, 0x11, 0x00,
        ];
        let target_body = payload_len.saturating_sub(2).max(out.len());
        out.resize(target_body, fill);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    fn push_le_tag(buf: &mut Vec<u8>, tag_id: u16, field_type: u16, count: u32, value: u32) {
        buf.extend_from_slice(&tag_id.to_le_bytes());
        buf.extend_from_slice(&field_type.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&value.to_le_bytes());
    }

    fn iso_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(&((8 + payload.len()) as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn extracts_largest_jpeg_from_tiff_and_subifds() {
        let small_jpeg = fake_jpeg(64, 0x11);
        let full_jpeg = fake_jpeg(256, 0x22);

        // Layout:
        // 0..8: TIFF header (II, 42, ifd0=8)
        // 8..46: IFD0 (3 entries: 0x0201, 0x0202, 0x014A -> sub_ifd) + next_ifd=0
        // 64..94: SubIFD (2 entries: 0x0111, 0x0117 -> full_jpeg) + next_ifd=0
        // 128..: small_jpeg, then full_jpeg
        let mut data = vec![0u8; 128];
        data[0..2].copy_from_slice(b"II");
        data[2..4].copy_from_slice(&42u16.to_le_bytes());
        data[4..8].copy_from_slice(&8u32.to_le_bytes());

        let small_offset = data.len() as u32;
        data.extend_from_slice(&small_jpeg);
        let full_offset = data.len() as u32;
        data.extend_from_slice(&full_jpeg);

        let mut ifd0 = Vec::new();
        ifd0.extend_from_slice(&3u16.to_le_bytes());
        push_le_tag(&mut ifd0, 0x0201, 4, 1, small_offset);
        push_le_tag(&mut ifd0, 0x0202, 4, 1, small_jpeg.len() as u32);
        push_le_tag(&mut ifd0, 0x014A, 4, 1, 64);
        ifd0.extend_from_slice(&0u32.to_le_bytes());
        data[8..8 + ifd0.len()].copy_from_slice(&ifd0);

        let mut sub_ifd = Vec::new();
        sub_ifd.extend_from_slice(&2u16.to_le_bytes());
        push_le_tag(&mut sub_ifd, 0x0111, 4, 1, full_offset);
        push_le_tag(&mut sub_ifd, 0x0117, 4, 1, full_jpeg.len() as u32);
        sub_ifd.extend_from_slice(&0u32.to_le_bytes());
        data[64..64 + sub_ifd.len()].copy_from_slice(&sub_ifd);

        let extracted = extract_embedded_jpeg(&data, 32).expect("extract SubIFD JPEG");
        assert_eq!(extracted, full_jpeg.as_slice());
    }

    #[test]
    fn extracts_jpeg_from_olympus_orf_and_panasonic_rw2() {
        let jpeg = fake_jpeg(128, 0x33);

        // Panasonic RW2 magic 0x0055 + JpgFromRaw tag 0x002E
        let mut rw2 = vec![0u8; 64];
        rw2[0..2].copy_from_slice(b"II");
        rw2[2..4].copy_from_slice(&0x0055u16.to_le_bytes());
        rw2[4..8].copy_from_slice(&8u32.to_le_bytes());
        let offset = rw2.len() as u32;
        rw2.extend_from_slice(&jpeg);

        let mut ifd = Vec::new();
        ifd.extend_from_slice(&1u16.to_le_bytes());
        push_le_tag(&mut ifd, 0x002E, 7, jpeg.len() as u32, offset);
        ifd.extend_from_slice(&0u32.to_le_bytes());
        rw2[8..8 + ifd.len()].copy_from_slice(&ifd);

        assert_eq!(
            extract_embedded_jpeg(&rw2, 32).expect("extract RW2 JPEG"),
            jpeg.as_slice()
        );

        // Olympus ORF magic 0x4F52
        let mut orf = vec![0u8; 64];
        orf[0..2].copy_from_slice(b"II");
        orf[2..4].copy_from_slice(&0x4F52u16.to_le_bytes());
        orf[4..8].copy_from_slice(&8u32.to_le_bytes());
        let orf_offset = orf.len() as u32;
        orf.extend_from_slice(&jpeg);
        let mut orf_ifd = Vec::new();
        orf_ifd.extend_from_slice(&2u16.to_le_bytes());
        push_le_tag(&mut orf_ifd, 0x0201, 4, 1, orf_offset);
        push_le_tag(&mut orf_ifd, 0x0202, 4, 1, jpeg.len() as u32);
        orf_ifd.extend_from_slice(&0u32.to_le_bytes());
        orf[8..8 + orf_ifd.len()].copy_from_slice(&orf_ifd);

        assert_eq!(
            extract_embedded_jpeg(&orf, 32).expect("extract ORF JPEG"),
            jpeg.as_slice()
        );
    }

    #[test]
    fn extracts_jpeg_from_fujifilm_raf() {
        let jpeg = fake_jpeg(160, 0x44);
        let mut raf = vec![0u8; 128];
        raf[0..16].copy_from_slice(b"FUJIFILMCCD-RAW ");
        let offset = raf.len() as u32;
        raf[84..88].copy_from_slice(&offset.to_be_bytes());
        raf[88..92].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        raf.extend_from_slice(&jpeg);

        assert_eq!(
            extract_embedded_jpeg(&raf, 32).expect("extract RAF JPEG"),
            jpeg.as_slice()
        );
    }

    #[test]
    fn extracts_largest_jpeg_from_canon_cr3_prvw_and_mdat_track() {
        let prvw_jpeg = fake_jpeg(96, 0x55);
        let full_jpeg = fake_jpeg(320, 0x66);

        let ftyp = iso_box(b"ftyp", b"crx \0\0\0\x01crx isom");

        // Build PRVW box inside Canon preview UUID
        let mut prvw_payload = vec![0u8; 16];
        prvw_payload.extend_from_slice(&prvw_jpeg);
        let prvw = iso_box(b"PRVW", &prvw_payload);
        let mut uuid_payload = super::CANON_CR3_UUID_PREVIEW.to_vec();
        uuid_payload.extend_from_slice(&[0u8; 8]);
        uuid_payload.extend_from_slice(&prvw);
        let uuid_box = iso_box(b"uuid", &uuid_payload);

        // Compute mdat JPEG offset after ftyp + moov + uuid_box + mdat header(8)
        let placeholder_stco = iso_box(b"stco", &[0u8; 12]);
        let mut stsz_payload = vec![0u8; 12];
        stsz_payload[4..8].copy_from_slice(&(full_jpeg.len() as u32).to_be_bytes());
        let stsz = iso_box(b"stsz", &stsz_payload);
        let dummy_stbl = iso_box(b"stbl", &[placeholder_stco, stsz.clone()].concat());
        let dummy_moov = iso_box(
            b"moov",
            &iso_box(b"trak", &iso_box(b"mdia", &iso_box(b"minf", &dummy_stbl))),
        );
        let full_offset = (ftyp.len() + dummy_moov.len() + uuid_box.len() + 8) as u32;

        let mut stco_payload = vec![0u8; 12];
        stco_payload[4..8].copy_from_slice(&1u32.to_be_bytes());
        stco_payload[8..12].copy_from_slice(&full_offset.to_be_bytes());
        let stco = iso_box(b"stco", &stco_payload);
        let stbl = iso_box(b"stbl", &[stco, stsz].concat());
        let moov = iso_box(
            b"moov",
            &iso_box(b"trak", &iso_box(b"mdia", &iso_box(b"minf", &stbl))),
        );
        let mdat = iso_box(b"mdat", &full_jpeg);

        let cr3 = [ftyp, moov, uuid_box, mdat].concat();
        assert_eq!(
            extract_embedded_jpeg(&cr3, 32).expect("extract CR3 full JPEG"),
            full_jpeg.as_slice()
        );
    }

    #[test]
    fn skips_lossless_sof3_raw_sensor_strip_and_extracts_preview_jpeg() {
        let preview_jpeg = fake_jpeg(192, 0x42);
        let lossless_raw_strip = fake_lossless_sof3_raw_strip(1024, 0x99);

        // Layout mirroring Sony ILCE-7M4 lossless ARW:
        // IFD0 points to SubIFD (huge 14-bit SOF3 Bayer strip) AND next IFD (real 8-bit SOF0 preview)
        let mut data = vec![0u8; 192];
        data[0..2].copy_from_slice(b"II");
        data[2..4].copy_from_slice(&42u16.to_le_bytes());
        data[4..8].copy_from_slice(&8u32.to_le_bytes());

        let preview_offset = data.len() as u32;
        data.extend_from_slice(&preview_jpeg);
        let raw_offset = data.len() as u32;
        data.extend_from_slice(&lossless_raw_strip);

        // IFD0 at 8: SubIFD=64, next_ifd=128
        let mut ifd0 = Vec::new();
        ifd0.extend_from_slice(&1u16.to_le_bytes());
        push_le_tag(&mut ifd0, 0x014A, 4, 1, 64);
        ifd0.extend_from_slice(&128u32.to_le_bytes());
        data[8..8 + ifd0.len()].copy_from_slice(&ifd0);

        // SubIFD at 64: StripOffsets/StripByteCounts -> huge SOF3 Bayer sensor strip
        let mut sub_ifd = Vec::new();
        sub_ifd.extend_from_slice(&2u16.to_le_bytes());
        push_le_tag(&mut sub_ifd, 0x0111, 4, 1, raw_offset);
        push_le_tag(&mut sub_ifd, 0x0117, 4, 1, lossless_raw_strip.len() as u32);
        sub_ifd.extend_from_slice(&0u32.to_le_bytes());
        data[64..64 + sub_ifd.len()].copy_from_slice(&sub_ifd);

        // IFD1 at 128: JPEGInterchangeFormat/Length -> real 8-bit preview JPEG
        let mut ifd1 = Vec::new();
        ifd1.extend_from_slice(&2u16.to_le_bytes());
        push_le_tag(&mut ifd1, 0x0201, 4, 1, preview_offset);
        push_le_tag(&mut ifd1, 0x0202, 4, 1, preview_jpeg.len() as u32);
        ifd1.extend_from_slice(&0u32.to_le_bytes());
        data[128..128 + ifd1.len()].copy_from_slice(&ifd1);

        let extracted = extract_embedded_jpeg(&data, 32).expect("extract real SOF0 preview JPEG");
        assert_eq!(extracted, preview_jpeg.as_slice());
    }

    #[test]
    fn rejects_cyclic_or_truncated_tiff_cleanly() {
        let mut cyclic = vec![0u8; 64];
        cyclic[0..2].copy_from_slice(b"II");
        cyclic[2..4].copy_from_slice(&42u16.to_le_bytes());
        cyclic[4..8].copy_from_slice(&8u32.to_le_bytes());
        cyclic[8..10].copy_from_slice(&0u16.to_le_bytes());
        // next_ifd points back to itself (8)
        cyclic[10..14].copy_from_slice(&8u32.to_le_bytes());
        assert!(extract_embedded_jpeg(&cyclic, 32).is_none());
    }
}
