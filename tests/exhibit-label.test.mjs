import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXHIBIT_NAMING_OPTIONS,
  formatExhibitFilename,
} from "../src/lib/exhibitLabelNaming.ts";

test("formatExhibitFilename follows 时代-名称-出土地-馆藏-原图片名 and omits unknown fields", () => {
  const full = formatExhibitFilename(
    {
      era: "春秋",
      name: "玉琮",
      provenance: "陕西渭南澄城刘家洼遗址M49出土",
      collection: "陕西省考古研究院藏",
      accessionNumber: "",
    },
    "DSC00533",
    "ARW"
  );
  assert.equal(full, "春秋-玉琮-陕西渭南澄城刘家洼遗址M49出土-陕西省考古研究院藏-DSC00533.ARW");

  const partial = formatExhibitFilename(
    {
      era: "良渚文化",
      name: "玉琮",
      provenance: "",
      collection: "大英博物馆藏",
      accessionNumber: "1947,0712.443",
    },
    "DSC00819_1",
    "ARW"
  );
  assert.equal(partial, "良渚文化-玉琮-大英博物馆藏-DSC00819_1.ARW");

  const customOpts = formatExhibitFilename(
    {
      era: "北宋",
      name: "银鎏金莲花宝子香炉",
      provenance: "长干寺长干塔地宫出土",
      collection: "南京市博物馆藏",
      accessionNumber: "",
    },
    "DSC00119",
    "ARW",
    { ...DEFAULT_EXHIBIT_NAMING_OPTIONS, includeCollection: false, separator: "_" }
  );
  assert.equal(customOpts, "北宋_银鎏金莲花宝子香炉_长干寺长干塔地宫出土_DSC00119.ARW");

  assert.equal(
    formatExhibitFilename(
      { era: "明", name: "", provenance: "", collection: "", accessionNumber: "" },
      "DSC00001",
      "ARW"
    ),
    null
  );
});
