import assert from "node:assert/strict";
import test from "node:test";
import { RequestGeneration } from "../src/lib/requestGeneration.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a late directory response cannot replace the latest request result", async () => {
  const requests = new RequestGeneration();
  const published = [];
  const older = deferred();

  const load = async (promise) => {
    const requestId = requests.begin();
    const result = await promise;
    if (requests.isCurrent(requestId)) published.push(result);
  };

  const olderLoad = load(older.promise);
  await load(Promise.resolve(["new directory snapshot"]));
  older.resolve(["stale directory snapshot"]);
  await olderLoad;

  assert.deepEqual(published, [["new directory snapshot"]]);
});

test("a watcher event invalidates requests started before the change", () => {
  const requests = new RequestGeneration();
  const inFlightRequest = requests.begin();

  requests.invalidate();

  assert.equal(requests.isCurrent(inFlightRequest), false);
  const refreshRequest = requests.begin();
  assert.equal(requests.isCurrent(refreshRequest), true);
});
