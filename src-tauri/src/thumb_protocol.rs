//! 自定义 `thumb://` 二进制缩略图协议
//!
//! 直接向 WebView 返回原始 JPEG/PNG 二进制流，彻底消除 Base64 编解码、
//! JSON IPC 序列化以及 WebView JS 堆字符串驻留开销。

use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder};

/// 限制同时运行的原生缩略图解码数量，充分利用多核同时避免无限并发打满外置盘
const MAX_CONCURRENT_THUMB_DECODES: usize = 10;
/// 后台分析（清晰度/特征提取）最多占用 6 个并发解码槽，始终为当前可见缩略图与 Quick Look 预留至少 4 个专用槽位
const MAX_CONCURRENT_BG_THUMB_DECODES: usize = 6;

struct AsyncPermitPool {
    tx: tauri::async_runtime::Sender<()>,
    rx: tauri::async_runtime::Mutex<tauri::async_runtime::Receiver<()>>,
}

struct DecodePermit {
    tx: tauri::async_runtime::Sender<()>,
}

impl Drop for DecodePermit {
    fn drop(&mut self) {
        let _ = self.tx.try_send(());
    }
}

impl AsyncPermitPool {
    fn new(capacity: usize) -> Self {
        let (tx, rx) = tauri::async_runtime::channel(capacity);
        for _ in 0..capacity {
            let _ = tx.try_send(());
        }
        Self {
            tx,
            rx: tauri::async_runtime::Mutex::new(rx),
        }
    }

    async fn acquire(&self) -> Option<DecodePermit> {
        let mut rx = self.rx.lock().await;
        rx.recv().await?;
        Some(DecodePermit {
            tx: self.tx.clone(),
        })
    }
}

fn decode_pool() -> &'static AsyncPermitPool {
    static POOL: OnceLock<AsyncPermitPool> = OnceLock::new();
    POOL.get_or_init(|| AsyncPermitPool::new(MAX_CONCURRENT_THUMB_DECODES))
}

fn bg_decode_pool() -> &'static AsyncPermitPool {
    static BG_POOL: OnceLock<AsyncPermitPool> = OnceLock::new();
    BG_POOL.get_or_init(|| AsyncPermitPool::new(MAX_CONCURRENT_BG_THUMB_DECODES))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            // Standard query-string decoding (application/x-www-form-urlencoded):
            // '+' represents a space while literal '+' is encoded as '%2B'.
            out.push(b' ');
            i += 1;
            continue;
        }
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        if let Some((key, value)) = pair.split_once('=') {
            params.insert(percent_decode(key), percent_decode(value));
        } else {
            params.insert(percent_decode(pair), String::new());
        }
    }
    params
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(Vec::new())
        .expect("empty response builder should never fail")
}

fn image_response(bytes: Vec<u8>, mime: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=3600, immutable")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(bytes)
        .expect("image response builder should never fail")
}

pub fn handle_thumb_protocol<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() == Method::OPTIONS {
        responder.respond(empty_response(StatusCode::NO_CONTENT));
        return;
    }

    let uri = request.uri();
    let endpoint = uri.path().trim_matches('/').to_string();
    let query = uri.query().unwrap_or("");
    let params = parse_query_params(query);

    let Some(path) = params.get("path").cloned().filter(|p| !p.is_empty()) else {
        responder.respond(empty_response(StatusCode::BAD_REQUEST));
        return;
    };

    // Only accept absolute paths.
    if !std::path::Path::new(&path).is_absolute() {
        responder.respond(empty_response(StatusCode::BAD_REQUEST));
        return;
    }

    let app_handle = ctx.app_handle().clone();

    match endpoint.as_str() {
        "file" => {
            let size = params
                .get("size")
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or(128.0);
            let allow_icon_fallback = params
                .get("fallback")
                .map(|value| value != "0" && value != "false")
                .unwrap_or(false);
            let prefer_embedded = params
                .get("embedded")
                .map(|value| value == "1" || value == "true")
                .unwrap_or(false);
            let is_background = params
                .get("bg")
                .map(|value| value == "1" || value == "true")
                .unwrap_or(false);

            tauri::async_runtime::spawn(async move {
                // Background analysis requests acquire a bounded 2-slot permit first so they
                // can never crowd out visible grid thumbnails or Quick Look previews.
                let _bg_permit = if is_background {
                    match bg_decode_pool().acquire().await {
                        Some(permit) => Some(permit),
                        None => {
                            responder.respond(empty_response(StatusCode::SERVICE_UNAVAILABLE));
                            return;
                        }
                    }
                } else {
                    None
                };
                let Some(_permit) = decode_pool().acquire().await else {
                    responder.respond(empty_response(StatusCode::SERVICE_UNAVAILABLE));
                    return;
                };
                // Convert generic AppHandle<R> to Wry-compatible helper on macOS via spawn_blocking.
                let result = tauri::async_runtime::spawn_blocking(move || {
                    resolve_file_thumbnail_bytes(
                        &app_handle,
                        path,
                        Some(size),
                        Some(allow_icon_fallback),
                        Some(prefer_embedded),
                    )
                })
                .await
                .ok()
                .flatten();

                match result {
                    Some(cached) => {
                        responder.respond(image_response((*cached.bytes).clone(), cached.mime));
                    }
                    None => responder.respond(empty_response(StatusCode::NOT_FOUND)),
                }
            });
        }
        "raw" | "arw" => {
            let max_pixel_size = params
                .get("max")
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(4096);

            tauri::async_runtime::spawn(async move {
                let Some(_permit) = decode_pool().acquire().await else {
                    responder.respond(empty_response(StatusCode::SERVICE_UNAVAILABLE));
                    return;
                };
                #[cfg(target_os = "macos")]
                let result = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::apps::get_raw_embedded_jpeg_bytes_blocking(
                        &path,
                        max_pixel_size,
                    )
                })
                .await
                .ok()
                .flatten();

                #[cfg(not(target_os = "macos"))]
                let result: Option<crate::cache::CachedImageBytes> = {
                    let _ = (path, max_pixel_size);
                    None
                };

                match result {
                    Some(cached) => {
                        responder.respond(image_response((*cached.bytes).clone(), cached.mime));
                    }
                    None => responder.respond(empty_response(StatusCode::NOT_FOUND)),
                }
            });
        }
        _ => responder.respond(empty_response(StatusCode::NOT_FOUND)),
    }
}

fn resolve_file_thumbnail_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: String,
    size: Option<f64>,
    allow_icon_fallback: Option<bool>,
    prefer_embedded: Option<bool>,
) -> Option<crate::cache::CachedImageBytes> {
    crate::commands::apps::get_file_thumbnail_bytes_blocking_generic(
        app,
        path,
        size,
        allow_icon_fallback,
        prefer_embedded,
    )
}

#[cfg(test)]
mod tests {
    use super::{parse_query_params, percent_decode};

    #[test]
    fn percent_decode_preserves_utf8_spaces_and_special_characters() {
        let encoded = "%2FUsers%2Ftest%2F%E7%85%A7%E7%89%87%20%231%2B2%26a%3Db.ARW";
        assert_eq!(percent_decode(encoded), "/Users/test/照片 #1+2&a=b.ARW");
    }

    #[test]
    fn parse_query_params_extracts_all_fields() {
        let params = parse_query_params(
            "path=%2Ftmp%2Fmy%20photo+name%2B2.jpg&size=288&embedded=1&fallback=0&bg=1&v=1700-42",
        );
        assert_eq!(
            params.get("path").map(String::as_str),
            Some("/tmp/my photo name+2.jpg")
        );
        assert_eq!(params.get("size").map(String::as_str), Some("288"));
        assert_eq!(params.get("embedded").map(String::as_str), Some("1"));
        assert_eq!(params.get("fallback").map(String::as_str), Some("0"));
        assert_eq!(params.get("bg").map(String::as_str), Some("1"));
    }
}
