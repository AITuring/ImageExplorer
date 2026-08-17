import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SmartIconProps } from "@/types";
import { SYSTEM_PATHS } from "@/constants/paths";
import {
  iconCache,
  loadingIcons,
  registerIconRefreshForKey,
  triggerIconRefreshForKey,
} from "@/lib/iconCache";

export function SmartIcon({ icon: Icon, className, sysIcon }: SmartIconProps) {
  // 用于强制刷新的计数器
  const [, forceUpdate] = useState(0);

  const sysIconType = sysIcon?.type;
  const sysIconValue = sysIcon?.value;

  // 生成缓存 key
  const cacheKey = sysIconType ? `${sysIconType}:${sysIconValue || "default"}` : null;

  // 从缓存读取图标（每次渲染都检查最新缓存）
  const cached = cacheKey ? iconCache[cacheKey] : undefined;
  const iconBase64 = cached === "failed" ? null : cached || null;

  // Only the component waiting for this exact icon needs to render again.
  useEffect(() => {
    if (!cacheKey) return;
    const unregister = registerIconRefreshForKey(cacheKey, () => {
      forceUpdate((n) => n + 1);
    });
    return () => {
      unregister();
    };
  }, [cacheKey]);

  // 加载图标到缓存
  useEffect(() => {
    if (!sysIconType || !cacheKey) return;

    // 如果已经有缓存，无需加载
    if (iconCache[cacheKey]) {
      return;
    }

    // 如果正在加载，不重复发起请求
    if (loadingIcons.has(cacheKey)) {
      return;
    }

    // 开始加载
    let isMounted = true;
    loadingIcons.add(cacheKey);

    const fetchIcon = async () => {
      try {
        let base64: string | null = null;

        if (sysIconType === "path" && sysIconValue) {
          base64 = await invoke<string>("get_app_icon", { appPath: sysIconValue });
        } else if (sysIconType === "ext") {
          base64 = await invoke<string>("get_file_type_icon", {
            ext: sysIconValue || "",
          });
        } else if (sysIconType === "folder") {
          base64 = await invoke<string>("get_app_icon", {
            appPath: SYSTEM_PATHS.CORE_SERVICES,
          });
        } else if (sysIconType === "sfsymbol" && sysIconValue) {
          base64 = await invoke<string>("get_sf_symbol", { name: sysIconValue });
        }

        // 即使组件卸载了，也要更新共享缓存。
        if (base64) {
          iconCache[cacheKey] = base64;
        } else {
          iconCache[cacheKey] = "failed";
        }

        if (isMounted) {
          // 触发当前组件刷新
          forceUpdate((n) => n + 1);
        }
      } catch (e) {
        console.error(`SmartIcon failed to load ${sysIconType}:${sysIconValue}`, e);
        iconCache[cacheKey] = "failed";
      } finally {
        loadingIcons.delete(cacheKey);
        triggerIconRefreshForKey(cacheKey);
      }
    };

    fetchIcon();

    return () => {
      isMounted = false;
    };
  }, [cacheKey, sysIconType, sysIconValue]);

  // 优先显示系统图标
  if (iconBase64) {
    if (sysIcon?.type === "sfsymbol") {
      return (
        <span
          className={`inline-block shrink-0 bg-current ${className || "h-6 w-6"}`}
          style={{
            maskImage: `url(data:image/png;base64,${iconBase64})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskImage: `url(data:image/png;base64,${iconBase64})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
          }}
          draggable={false}
        />
      );
    }
    return (
      <img
        src={`data:image/png;base64,${iconBase64}`}
        className={`object-contain ${className || "h-6 w-6"}`}
        alt=""
        draggable={false}
      />
    );
  }

  // 如果有 fallback 图标，显示它（即使正在加载系统图标）
  if (Icon) {
    return <Icon className={className || "h-6 w-6"} />;
  }

  return null;
}
