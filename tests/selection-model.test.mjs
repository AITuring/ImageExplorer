import assert from "node:assert/strict";
import test from "node:test";
import { initialSelection, selectionReducer } from "../src/components/FileList/hooks/selectionModel.ts";

const ascending = ["A", "B", "C", "D", "E", "F"].map((name) => ({
  path: `/${name}.png`,
}));

function selectB() {
  return selectionReducer(initialSelection, { type: "single", path: "/B.png" });
}

test("Shift range recomputes from the original anchor while moving in both directions", () => {
  let state = selectB();
  state = selectionReducer(state, { type: "range", entries: ascending, toIndex: 4 });
  assert.deepEqual(state, {
    selectedPaths: ["/B.png", "/C.png", "/D.png", "/E.png"],
    focusedPath: "/E.png",
    anchorPath: "/B.png",
  });

  state = selectionReducer(state, { type: "range", entries: ascending, toIndex: 2 });
  assert.deepEqual(state, {
    selectedPaths: ["/B.png", "/C.png"],
    focusedPath: "/C.png",
    anchorPath: "/B.png",
  });

  state = selectionReducer(state, { type: "range", entries: ascending, toIndex: 3 });
  assert.deepEqual(state.selectedPaths, ["/B.png", "/C.png", "/D.png"]);
  assert.equal(state.anchorPath, "/B.png");
});

test("sort reorders the range without changing the path-based anchor", () => {
  const descending = ["Z", "Y", "C", "B", "A"].map((name) => ({
    path: `/${name}.png`,
  }));
  let state = selectB();

  state = selectionReducer(state, { type: "range", entries: descending, toIndex: 2 });
  assert.deepEqual(state, {
    selectedPaths: ["/C.png", "/B.png"],
    focusedPath: "/C.png",
    anchorPath: "/B.png",
  });

  state = selectionReducer(state, { type: "range", entries: descending, toIndex: 3 });
  assert.deepEqual(state, {
    selectedPaths: ["/B.png"],
    focusedPath: "/B.png",
    anchorPath: "/B.png",
  });
});

test("pruning a removed item clears it from selection and repairs a missing anchor", () => {
  const range = selectionReducer(selectB(), {
    type: "range",
    entries: ascending,
    toIndex: 2,
  });

  const pruned = selectionReducer(range, {
    type: "prune",
    paths: ["/A.png", "/C.png", "/D.png"],
  });

  assert.deepEqual(pruned, {
    selectedPaths: ["/C.png"],
    focusedPath: "/C.png",
    anchorPath: "/C.png",
  });
});
