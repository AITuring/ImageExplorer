import assert from "node:assert/strict";
import test from "node:test";
import { groupFileEntries } from "../src/lib/finderGrouping.ts";

const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime(); // 2026-05-20 12:00 local

test("groupFileEntries buckets by kind, date, size, and Finder tag", () => {
  const entries = [
    {
      name: "Projects",
      path: "/a/Projects",
      is_dir: true,
      size: 0,
      modified: Math.floor(NOW / 1000),
      extension: null,
      tags: ["Red"],
    },
    {
      name: "DSC0001.ARW",
      path: "/a/DSC0001.ARW",
      is_dir: false,
      size: 55 * 1024 * 1024,
      modified: Math.floor((NOW - 2 * 86_400_000) / 1000),
      extension: "ARW",
      tags: ["Blue"],
    },
    {
      name: "clip.mp4",
      path: "/a/clip.mp4",
      is_dir: false,
      size: 180 * 1024 * 1024,
      modified: Math.floor(new Date(2025, 10, 5, 10, 0, 0).getTime() / 1000),
      extension: "mp4",
      tags: [],
    },
    {
      name: "notes.md",
      path: "/a/notes.md",
      is_dir: false,
      size: 2048,
      modified: Math.floor((NOW - 86_400_000) / 1000),
      extension: "md",
      tags: [],
    },
  ];

  const byKind = groupFileEntries(entries, "kind", NOW);
  assert.deepEqual(
    byKind.map((g) => g.id),
    ["kind:folder", "kind:raw", "kind:video", "kind:document"]
  );

  const byDate = groupFileEntries(entries, "date", NOW);
  assert.deepEqual(
    byDate.map((g) => g.id),
    ["date:today", "date:yesterday", "date:week", "date:2025-11"]
  );

  const bySize = groupFileEntries(entries, "size", NOW);
  assert.deepEqual(
    bySize.map((g) => g.id),
    ["size:folder", "size:huge", "size:large", "size:small"]
  );

  const byTag = groupFileEntries(entries, "tag", NOW);
  assert.deepEqual(
    byTag.map((g) => g.id),
    ["tag:blue", "tag:red", "tag:none"]
  );
  assert.equal(byTag[2].entries.length, 2);
});
