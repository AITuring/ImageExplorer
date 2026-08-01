import { useEffect, useState, useMemo, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { X, ExternalLink, File, Loader2 } from "lucide-react";
import { SmartIcon } from "@/components/SmartIcon";
import { FileThumbnail } from "@/components/FileThumbnail";
import { iconCache, loadFileThumbnail } from "@/lib/iconCache";
import type { FileEntry } from "@/types/index";
import {
  isTextFile,
  isImageFile,
  isBrowserSupportedImage,
  isVideoFile,
  isAudioFile,
  isPdfFile,
} from "@/utils/file";
import { formatFileSize, formatDate } from "@/utils/format";

interface QuickLookProps {
  entry: FileEntry | null;
  onClose: () => void;
}

type PreviewType = "text" | "image" | "video" | "audio" | "pdf" | "icon";

interface ImageDimensions {
  width: number;
  height: number;
}

export function QuickLook({ entry, onClose }: QuickLookProps) {
  const { t } = useTranslation();

  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [useNativeImagePreview, setUseNativeImagePreview] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<ImageDimensions | null>(null);
  const [nativePreviewSrc, setNativePreviewSrc] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));

  // 缓存 convertFileSrc 结果，避免重复转换
  const fileSrc = useMemo(() => {
    if (!entry) return null;
    return convertFileSrc(entry.path);
  }, [entry]);

  // 根据 entry 计算预览类型
  const previewType: PreviewType = useMemo(() => {
    if (!entry || entry.is_dir) return "icon";
    // 忽略 macOS 的元数据文件 (AppleDouble)
    if (entry.name.startsWith("._")) return "icon";

    if (isImageFile(entry.extension)) return "image";
    if (isVideoFile(entry.extension)) return "video";
    if (isAudioFile(entry.extension)) return "audio";
    if (isPdfFile(entry.extension)) return "pdf";
    if (isTextFile(entry.extension) && entry.size < 1024 * 1024) return "text";
    return "icon";
  }, [entry]);

  const dialogSizeClass = useMemo(() => {
    if (!entry) {
      return "h-[min(88vh,48rem)] w-[min(92vw,72rem)]";
    }

    switch (previewType) {
      case "image":
        return "h-[min(92vh,64rem)] w-[min(96vw,96rem)]";
      case "pdf":
      case "video":
        return "h-[min(92vh,64rem)] w-[min(96vw,96rem)]";
      case "text":
        return "h-[min(88vh,56rem)] w-[min(92vw,80rem)]";
      default:
        return "h-[min(82vh,42rem)] w-[min(88vw,56rem)]";
    }
  }, [entry, previewType]);

  const contentPaddingClass =
    previewType === "image" || previewType === "pdf" || previewType === "video"
      ? "p-1.5 md:p-2"
      : "p-8";

  const nativePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entry) {
      return 768;
    }

    const viewportMax = Math.max(viewportSize.width, viewportSize.height);
    const baseSize = Math.min(1280, Math.max(896, Math.round(viewportMax * 0.72)));
    const extension = (entry.extension || "").toLowerCase();

    // PSD uses a progressive strategy: tiny first frame, then a noticeably larger background preview.
    if (extension === "psd") {
      if (entry.size > 200 * 1024 * 1024) {
        return 768;
      }
      if (entry.size > 80 * 1024 * 1024) {
        return 896;
      }
      return Math.min(1024, baseSize);
    }

    return baseSize;
  }, [entry, previewType, viewportSize.height, viewportSize.width]);

  const progressivePreviewRequestSize = useMemo(() => {
    if (previewType !== "image" || !entry) {
      return 384;
    }

    const extension = (entry.extension || "").toLowerCase();
    if (extension === "psd") {
      return entry.size > 80 * 1024 * 1024 ? 256 : 320;
    }

    return 384;
  }, [entry, previewType]);

  const cachedNativePreview = useMemo(() => {
    if (!entry) {
      return null;
    }

    const prefix = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:`;
    let bestMatch: { size: number; src: string } | null = null;

    for (const [cacheKey, value] of Object.entries(iconCache)) {
      if (!cacheKey.startsWith(prefix) || value === "failed") {
        continue;
      }

      const size = Number(cacheKey.slice(prefix.length));
      if (!Number.isFinite(size)) {
        continue;
      }

      if (!bestMatch || size > bestMatch.size) {
        bestMatch = {
          size,
          src: `data:image/png;base64,${value}`,
        };
      }
    }

    return bestMatch;
  }, [entry]);

  const dialogStyle = useMemo<CSSProperties | undefined>(() => {
    if (previewType !== "image" || !imageDimensions) {
      return undefined;
    }

    const HEADER_HEIGHT = 44;
    const CONTENT_PADDING_X = 10;
    const CONTENT_PADDING_Y = 10;
    const BORDER = 1;
    const MIN_DIALOG_WIDTH = 240;
    const MIN_DIALOG_HEIGHT = 220;
    const maxDialogWidth = Math.max(320, Math.floor(viewportSize.width * 0.96));
    const maxDialogHeight = Math.max(260, Math.floor(viewportSize.height * 0.92));
    const maxContentWidth = Math.max(120, maxDialogWidth - CONTENT_PADDING_X - BORDER);
    const maxContentHeight = Math.max(
      120,
      maxDialogHeight - HEADER_HEIGHT - CONTENT_PADDING_Y - BORDER
    );

    const scale = Math.min(
      maxContentWidth / imageDimensions.width,
      maxContentHeight / imageDimensions.height
    );

    const contentWidth = Math.round(imageDimensions.width * scale);
    const contentHeight = Math.round(imageDimensions.height * scale);

    return {
      width: `${Math.min(maxDialogWidth, Math.max(MIN_DIALOG_WIDTH, contentWidth + CONTENT_PADDING_X + BORDER))}px`,
      height: `${Math.min(
        maxDialogHeight,
        Math.max(MIN_DIALOG_HEIGHT, contentHeight + HEADER_HEIGHT + CONTENT_PADDING_Y + BORDER)
      )}px`,
    };
  }, [imageDimensions, previewType, viewportSize.height, viewportSize.width]);

  // 当 entry 变化时，重置错误状态
  useEffect(() => {
    setError(null);
    setTextContent(null);
    setFallbackSrc(null);
    setUseNativeImagePreview(false);
    setImageDimensions(null);
    setNativePreviewSrc(null);
  }, [entry]);

  useEffect(() => {
    const handleResize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ESC 关闭 + 媒体清理
  useEffect(() => {
    if (!entry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // 暂停所有媒体元素
      document.querySelectorAll("video, audio").forEach((el) => {
        (el as HTMLMediaElement).pause();
      });
    };
  }, [entry, onClose]);

  useEffect(() => {
    if (!entry || previewType !== "image") {
      return;
    }

    let cancelled = false;

    invoke<ImageDimensions>("read_image_dimensions", { path: entry.path })
      .then((dimensions) => {
        if (!cancelled && dimensions.width > 0 && dimensions.height > 0) {
          setImageDimensions(dimensions);
        }
      })
      .catch(() => {
        // Keep browser onLoad as a fallback for supported images.
      });

    return () => {
      cancelled = true;
    };
  }, [entry, previewType]);

  useEffect(() => {
    if (
      !entry ||
      previewType !== "image" ||
      (isBrowserSupportedImage(entry.extension) && !useNativeImagePreview)
    ) {
      return;
    }

    let cancelled = false;
    const progressiveCacheKey = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${progressivePreviewRequestSize}`;
    const fullCacheKey = `file:${entry.path}:${entry.modified ?? 0}:${entry.size}:${nativePreviewRequestSize}`;

    if (cachedNativePreview?.src) {
      setNativePreviewSrc(cachedNativePreview.src);
    }

    const applyPreview = (base64: string | null) => {
      if (!cancelled && base64) {
        setNativePreviewSrc(`data:image/png;base64,${base64}`);
      }
    };

    const loadFullPreview = () => {
      if (cachedNativePreview && cachedNativePreview.size >= nativePreviewRequestSize) {
        return Promise.resolve();
      }

      return loadFileThumbnail(fullCacheKey, entry.path, nativePreviewRequestSize).then(applyPreview);
    };

    const shouldLoadProgressive =
      !cachedNativePreview || cachedNativePreview.size < progressivePreviewRequestSize;

    if (shouldLoadProgressive) {
      loadFileThumbnail(progressiveCacheKey, entry.path, progressivePreviewRequestSize)
        .then(applyPreview)
        .finally(() => {
          void loadFullPreview();
        });
      return () => {
        cancelled = true;
      };
    }

    void loadFullPreview();

    return () => {
      cancelled = true;
    };
  }, [
    cachedNativePreview,
    entry,
    nativePreviewRequestSize,
    previewType,
    progressivePreviewRequestSize,
    useNativeImagePreview,
  ]);

  useEffect(() => {
    // 只有文本文件才需要加载内容
    if (!entry || previewType !== "text") {
      return;
    }

    let cancelled = false;

    const loadText = async () => {
      try {
        setLoading(true);
        setError(null);
        const content = await invoke<string>("read_text_file", {
          path: entry.path,
          maxSize: 1024 * 1024,
        });
        if (!cancelled) {
          setTextContent(content);
        }
      } catch (err) {
        console.error("Failed to read text:", err);
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadText();

    return () => {
      cancelled = true;
    };
  }, [entry, previewType]);

  if (!entry) return null;

  const handleOpen = async () => {
    try {
      await invoke("open_file", { path: entry.path });
      onClose();
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  };

  const renderPreview = () => {
    if (loading) {
      return (
        <div className="text-muted-foreground flex flex-col items-center justify-center">
          <Loader2 className="mb-2 h-8 w-8 animate-spin" />
          <span className="text-xs">{t("common.loading")}</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center p-4 text-center text-red-500">
          <p className="mb-1 text-sm font-medium">{t("common.quick_look.error") || "Error"}</p>
          <p className="text-xs opacity-80">{error}</p>
        </div>
      );
    }

    switch (previewType) {
      case "image":
        return (
          <div className="flex h-full w-full items-center justify-center">
            {useNativeImagePreview || !isBrowserSupportedImage(entry.extension) ? (
              nativePreviewSrc ? (
                <img
                  key={`${entry.path}:${nativePreviewSrc}`}
                  src={nativePreviewSrc}
                  alt={entry.name}
                  className="h-full w-full rounded-lg object-contain shadow-lg"
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                      setImageDimensions({
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                      });
                    }
                  }}
                />
              ) : (
                <FileThumbnail
                  entry={entry}
                  size={320}
                  requestSizeOverride={progressivePreviewRequestSize}
                  className="h-full w-full rounded-lg object-contain shadow-lg"
                  fallbackClassName="text-muted-foreground h-40 w-40"
                  onImageLoad={(image) => {
                    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                      setImageDimensions({
                        width: image.naturalWidth,
                        height: image.naturalHeight,
                      });
                    }
                  }}
                />
              )
            ) : (
              <img
                key={entry.path}
                src={fallbackSrc || fileSrc || ""}
                alt={entry.name}
                className="h-full w-full rounded-lg object-contain shadow-lg"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setImageDimensions({
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    });
                  }
                }}
                onError={() => {
                  if (fallbackSrc) {
                    setUseNativeImagePreview(true);
                    setError(null);
                    return;
                  }

                  invoke<string>("read_image_base64", { path: entry.path })
                    .then((base64) => {
                      setFallbackSrc(base64);
                      setError(null);
                    })
                    .catch(() => {
                      setUseNativeImagePreview(true);
                      setError(null);
                    });
                }}
              />
            )}
          </div>
        );

      case "video":
        return (
          <div className="flex h-full w-full items-center justify-center">
            <video
              key={entry.path}
              src={fileSrc || ""}
              controls
              className="h-full w-full rounded-lg object-contain shadow-lg"
              onError={(e) => {
                console.error("Video load error:", e);
                setError(t("common.quick_look.error") || "Failed to load video");
              }}
            >
              Your browser does not support video playback.
            </video>
          </div>
        );

      case "audio":
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-8 p-8">
            <div className="relative flex h-32 w-32 items-center justify-center drop-shadow-2xl">
              <SmartIcon
                icon={File}
                className="text-muted-foreground h-32 w-32"
                sysIcon={{ type: "ext", value: entry.extension || "" }}
              />
            </div>
            <audio
              key={entry.path}
              src={fileSrc || ""}
              controls
              className="w-full max-w-md"
              onError={(e) => {
                console.error("Audio load error:", e);
                setError(t("common.quick_look.error") || "Failed to load audio");
              }}
            >
              Your browser does not support audio playback.
            </audio>
          </div>
        );

      case "pdf":
        return (
          <div className="h-full w-full">
            <embed
              key={entry.path}
              src={fileSrc || ""}
              type="application/pdf"
              className="h-full w-full rounded-lg shadow-lg"
              onError={(e) => {
                console.error("PDF load error:", e);
                setError(t("common.quick_look.error") || "Failed to load PDF");
              }}
            />
          </div>
        );

      case "text":
        return textContent !== null ? (
          <div className="bg-muted/30 h-full w-full overflow-auto rounded-md border p-4 shadow-inner">
            <pre className="font-mono text-xs break-words whitespace-pre-wrap">{textContent}</pre>
          </div>
        ) : null;

      case "icon":
      default:
        return (
          <>
            <div className="relative mb-6 flex h-32 w-32 items-center justify-center drop-shadow-2xl">
              <FileThumbnail
                entry={entry}
                size={128}
                className="h-32 w-32 rounded-xl object-contain"
                fallbackClassName={
                  entry.is_dir ? "h-32 w-32 text-blue-500" : "text-muted-foreground h-32 w-32"
                }
              />
            </div>

            <div className="text-center">
              <h2 className="line-clamp-2 px-8 text-2xl font-semibold tracking-tight break-all">
                {entry.name}
              </h2>
              <div className="text-muted-foreground mt-2 space-y-1 text-sm">
                <p>
                  {entry.is_dir
                    ? t("common.folder")
                    : entry.extension?.toUpperCase() || t("common.file")}
                  {" • "}
                  {entry.is_dir ? "--" : formatFileSize(entry.size)}
                </p>
                <p>
                  {t("common.quick_look.modified")}:{" "}
                  {formatDate(entry.modified, "yyyy/MM/dd HH:mm:ss")}
                </p>
              </div>
            </div>
          </>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`bg-background/80 text-foreground animate-in fade-in zoom-in-95 relative flex ${dialogSizeClass} flex-col overflow-hidden rounded-lg border border-black/8 shadow-xl backdrop-blur-md transition-all duration-200`}
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title Bar */}
        <div className="bg-muted/25 flex items-center justify-between border-b border-black/6 px-3 py-2">
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground rounded-full p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="text-sm font-medium opacity-80">{t("common.quick_look.preview")}</div>
          <button
            onClick={handleOpen}
            className="text-primary hover:text-primary/80 flex items-center gap-1 text-sm font-medium transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            {t("common.quick_look.open")}
          </button>
        </div>

        {/* Content */}
        <div
          className={`flex w-full flex-1 flex-col items-center justify-center overflow-hidden ${contentPaddingClass}`}
        >
          {renderPreview()}
        </div>
      </div>
    </div>
  );
}
