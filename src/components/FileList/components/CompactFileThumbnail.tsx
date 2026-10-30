import { useEffect, useRef, useState } from "react";
import { FileThumbnail } from "@/components/FileThumbnail";
import type { FileEntry } from "@/types";

/** Shared row thumbnail; column rows only decode while visible. */
export function CompactFileThumbnail({
  entry,
  isInViewport,
  isScrolling = false,
}: {
  entry: FileEntry;
  isInViewport?: boolean;
  isScrolling?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (isInViewport !== undefined || !ref.current) return;
    const observer = new IntersectionObserver(([item]) => setVisible(item.isIntersecting));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isInViewport]);
  return (
    <span ref={ref} className="flex h-6 w-6 shrink-0 items-center justify-center">
      <FileThumbnail
        entry={entry}
        size={24}
        isInViewport={isInViewport ?? visible}
        isScrolling={isScrolling}
        className="h-6 w-6 rounded object-contain"
        fallbackClassName={entry.is_dir ? "h-5 w-5 text-blue-500" : "h-5 w-5 text-muted-foreground"}
      />
    </span>
  );
}
