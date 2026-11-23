import assert from "node:assert/strict";
import test from "node:test";
import {
  findTypeAheadMatch,
  sortFileEntries,
} from "../src/components/FileList/hooks/finderListModel.ts";

function makeEntry(name, overrides = {}) {
  return {
    name,
    is_dir: false,
    size: 0,
    modified: null,
    created: null,
    extension: name.includes(".") ? name.split(".").pop() : null,
    is_package: false,
    package_type: null,
    ...overrides,
  };
}

test("sortFileEntries uses Finder natural numeric ordering with directories first", () => {
  const entries = [
    makeEntry("IMG_10.jpg"),
    makeEntry("IMG_2.jpg"),
    makeEntry("img_1.jpg"),
    makeEntry("Album 10", { is_dir: true, extension: null }),
    makeEntry("Album 2", { is_dir: true, extension: null }),
  ];

  const sorted = sortFileEntries(entries, "name", "asc");
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["Album 2", "Album 10", "img_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]
  );
});

test("findTypeAheadMatch matches prefixes and cycles repeated single characters", () => {
  const entries = [
    makeEntry("Alpha.jpg"),
    makeEntry("Apple.jpg"),
    makeEntry("Apricot.jpg"),
    makeEntry("Banana.jpg"),
  ];

  assert.equal(findTypeAheadMatch(entries, "ap", -1, false), 1);
  assert.equal(findTypeAheadMatch(entries, "apr", 1, false), 2);
  // Pressing "a" repeatedly cycles Alpha -> Apple -> Apricot -> Alpha
  assert.equal(findTypeAheadMatch(entries, "a", 0, true), 1);
  assert.equal(findTypeAheadMatch(entries, "a", 1, true), 2);
  assert.equal(findTypeAheadMatch(entries, "a", 2, true), 0);
  assert.equal(findTypeAheadMatch(entries, "z", 0, false), -1);
});
