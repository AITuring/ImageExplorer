# Permissions and privacy

ImageExplorer reads only the folders the user opens. macOS may ask for a
security-scoped folder grant when an external or network volume is first
visited; the grant is used by the current app process to enumerate and preview
that folder.

The optional Full Disk Access status in Settings is a convenience check for
protected locations. It is not silently enabled by ImageExplorer. The app does
not upload file contents, thumbnails, EXIF data, operation history, or index
records. The local SQLite index and operation snapshots are stored in the
application data directory and can be removed by deleting the app's data.

The macOS sandbox declarations are in `src-tauri/Entitlements.plist`. Release
builds must explain any additional entitlement in the release notes and must
test a clean-machine permission-denied path before distribution.
