import { useEffect, useRef } from "react";
import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

interface PathBarProps {
  path: string;
  onNavigate: (path: string) => void;
}

/** Keep ancestor navigation available without crowding the title toolbar. */
export function PathBar({ path, onNavigate }: PathBarProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLElement>(null);
  const segments = path.split("/").filter(Boolean);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [path]);

  return (
    <nav ref={scrollRef} className="finder-pathbar" aria-label={t("nav.path")}>
      <button
        type="button"
        onClick={() => onNavigate("/")}
        title="/"
        aria-label={t("nav.computer")}
      >
        <HardDrive size={13} aria-hidden="true" />
      </button>
      {segments.map((name, index) => {
        const destination = "/" + segments.slice(0, index + 1).join("/");
        return (
          <span className="flex shrink-0 items-center gap-1" key={destination}>
            <ChevronRight size={11} className="opacity-40" aria-hidden="true" />
            <button
              type="button"
              onClick={() => onNavigate(destination)}
              title={destination}
              aria-current={index === segments.length - 1 ? "location" : undefined}
            >
              <Folder size={13} aria-hidden="true" />
              <span className="max-w-48 truncate">{name}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
