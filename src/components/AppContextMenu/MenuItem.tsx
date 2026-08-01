import { useCallback, useRef } from "react";
import { SmartIcon } from "@/components/SmartIcon";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { MenuItemProps } from "@/types";

export function MenuItem(props: MenuItemProps) {
  const { icon, fallbackIcon, sysIcon, label, shortcut, onClick, destructive } = props;
  const activatedByPointerRef = useRef(false);
  const activateFromPointer = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      if (activatedByPointerRef.current) return;

      activatedByPointerRef.current = true;
      onClick();
    },
    [onClick]
  );
  const activateFromSelection = useCallback(() => {
    if (activatedByPointerRef.current) {
      activatedByPointerRef.current = false;
      return;
    }

    onClick();
  }, [onClick]);

  return (
    <ContextMenuItem
      className={destructive ? "text-destructive focus:text-destructive" : ""}
      onPointerDown={activateFromPointer}
      onPointerCancel={() => {
        activatedByPointerRef.current = false;
      }}
      onSelect={activateFromSelection}
    >
      {sysIcon ? (
        <SmartIcon className="mr-2 h-4 w-4" sysIcon={sysIcon} icon={fallbackIcon} />
      ) : (
        icon
      )}
      {label}
      {shortcut && <span className="text-muted-foreground ml-auto text-xs">{shortcut}</span>}
    </ContextMenuItem>
  );
}
