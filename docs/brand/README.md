# ImageExplorer 应用图标

2026-10-30：用户确认并应用拟物文件夹方案。薄蓝色文件夹内包含有正文的文档、山湖照片和带标签的档案页；文件夹外侧保持无图案。

## 当前资源

- `approved/preview.png`：用户确认的原始预览，保留白色背景，不用于打包。
- `../../public/logo.png`：使用内置 imagegen 去除外部背景后的透明 PNG 母稿。
- `../../public/logo-menu.png`：64 px 菜单资源，显示为 16 CSS px，支持高分屏。
- `../../public/favicon.png`：32 px 浏览器图标。
- `../../src-tauri/icons/`：同一母稿生成的桌面和移动端图标，包括 macOS ICNS、Windows ICO。

已接入文件/侧边栏右键菜单、favicon 和 Tauri 打包图标。应用标题改为 ImageExplorer。

## 重新生成

在仓库根目录运行：

```sh
pnpm tauri icon public/logo.png --output src-tauri/icons
pnpm tauri icon public/logo.png --output /private/tmp/imageexplorer-approved-sizes --png 16 --png 32 --png 64 --png 256
cp /private/tmp/imageexplorer-approved-sizes/32x32.png public/favicon.png
cp /private/tmp/imageexplorer-approved-sizes/64x64.png public/logo-menu.png
```

保留 PNG 的 alpha 通道，避免增加白色方形背景。小图中文字属于材质细节，不要求在 16 px 下可读。

## 透明底处理

工具：内置 imagegen；模式：background-extraction。

提示词：

> Background extraction ONLY for the approved application icon. Remove the white/light gray background completely and produce true transparent alpha outside the folder and its papers. Preserve the original foreground precisely: blue thin folder, same exact proportions, texture, position, colors, left printed PROJECT NOTES document, central mountain lake photograph, right lavender ARCHIVE document and every printed detail. Do not redesign, redraw, restyle, reshape, recolor or add anything. Retain only a very subtle close contact shadow if it can have transparent alpha; remove the broad studio floor shadow. Keep all white paper areas opaque. Output square transparent PNG with the same composition and generous margin. No checkerboard drawn into the image, no opaque backdrop.

桌面 Dock/Finder 中已安装的应用需要重新打包、安装后才会采用新图标；本次接入更新的是项目资源。
