import assert from "node:assert/strict";
import test from "node:test";
import { filterSearchResultsByKind } from "../src/lib/searchFilter.ts";

const sample = [
  { name: "DSC00123.ARW", is_dir: false, extension: "ARW" },
  { name: "portrait.jpg", is_dir: false, extension: "jpg" },
  { name: "clip.mov", is_dir: false, extension: "mov" },
  { name: "notes.pdf", is_dir: false, extension: "pdf" },
  { name: "Album", is_dir: true },
];

test("filterSearchResultsByKind filters images, RAW, videos, documents, and folders", () => {
  assert.equal(filterSearchResultsByKind(sample, "all").length, 5);
  assert.deepEqual(
    filterSearchResultsByKind(sample, "image").map((item) => item.name),
    ["DSC00123.ARW", "portrait.jpg"]
  );
  assert.deepEqual(
    filterSearchResultsByKind(sample, "raw").map((item) => item.name),
    ["DSC00123.ARW"]
  );
  assert.deepEqual(
    filterSearchResultsByKind(sample, "video").map((item) => item.name),
    ["clip.mov"]
  );
  assert.deepEqual(
    filterSearchResultsByKind(sample, "document").map((item) => item.name),
    ["notes.pdf"]
  );
  assert.deepEqual(
    filterSearchResultsByKind(sample, "folder").map((item) => item.name),
    ["Album"]
  );
});
