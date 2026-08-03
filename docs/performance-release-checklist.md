# Performance and release checklist

This checklist is the gate for 7.2/7.3. Code paths have protective limits and
recovery behavior, but the numeric targets must still be measured on a release
machine with representative disks and network volumes.

## Performance scenarios

- [ ] 100,000 entries in one directory: first contentful list paint `<200 ms`
  and scrolling/selection remains responsive.
- [ ] 1,000,000 indexed files: index completes without unbounded memory growth;
  search starts returning within `100 ms` after the configured debounce.
- [ ] 100 GB copy: progress, cancellation, free-space preflight, and final
  byte totals remain correct.
- [ ] High-latency and disconnected network volume: transient errors retry and
  the operation ends with a visible, retryable error.
- [ ] Low disk space: copy/move is rejected before writing when free space is
  below the required bytes plus safety headroom.
- [ ] Large thumbnail grid: memory stays within the frontend LRU limits and
  old entries are evicted.
- [ ] Multiple windows watching the same directory: one native watcher is
  shared and is released after the last window leaves.

Run the repeatable host baseline with:

```bash
PERF_ITEMS=100000 pnpm perf:smoke
```

The script measures filesystem read/sort time only. Tauri IPC, React paint,
and end-to-end copy timings must be recorded separately in the release run.

## Release quality

- [ ] Start an operation, kill/relaunch the app, and verify it appears as a
  failed/retryable record rather than disappearing.
- [ ] Confirm operation error text uses redacted home-directory paths.
- [ ] Open an existing database, apply migrations, and run SQLite integrity
  checks; corrupt database files must be backed up and rebuilt.
- [ ] Replace the updater public-key placeholder and publish a signed
  `latest.json` plus signed artifacts.
- [ ] Store `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only in CI secrets; never commit the
  updater private key.
- [ ] Configure Apple Developer ID signing and notarization secrets, then run
  `RELEASE_STRICT=1 pnpm release:check`.
- [ ] Verify macOS permission prompts and the Settings full-disk-access
  explanation on a clean machine.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm cargo:test`,
  `pnpm cargo:clippy`, and this checklist before tagging a release.
