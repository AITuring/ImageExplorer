import assert from "node:assert/strict";
import test from "node:test";
import {
  FINDER_TAG_PRESETS,
  getFinderTagColor,
  hasFinderTag,
  matchFinderTagPreset,
} from "../src/lib/finderTags.ts";

test("Finder tag matching resolves English, Chinese, and custom tags consistently", () => {
  assert.equal(FINDER_TAG_PRESETS.length, 7);
  assert.equal(matchFinderTagPreset("Red")?.id, "Red");
  assert.equal(matchFinderTagPreset("红色")?.id, "Red");
  assert.equal(getFinderTagColor("蓝色"), getFinderTagColor("Blue"));
  assert.equal(getFinderTagColor("CustomTag"), "#8e8e93");

  assert.equal(hasFinderTag(["红色", "Project"], "Red"), true);
  assert.equal(hasFinderTag(["Blue"], "Red"), false);
  assert.equal(hasFinderTag(["Project"], "project"), true);
  assert.equal(hasFinderTag(undefined, "Red"), false);
});
