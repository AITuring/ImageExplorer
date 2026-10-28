import assert from "node:assert/strict";
import test from "node:test";
import {
  isRegisteredCommandEnabled,
  registerAppCommands,
  runRegisteredCommand,
} from "../src/lib/commands.ts";

test("registered commands follow the active owner and restore the previous owner", () => {
  const calls = [];
  const unregisterFileView = registerAppCommands([
    {
      id: "test.copy",
      enabled: (paths) => paths.length > 0,
      run: (paths) => calls.push(["file-view", paths]),
    },
  ]);

  assert.equal(isRegisteredCommandEnabled("test.copy", []), false);
  assert.equal(isRegisteredCommandEnabled("test.copy", ["/a.jpg"]), true);
  assert.equal(runRegisteredCommand("test.copy", ["/a.jpg"]), true);

  const unregisterDialog = registerAppCommands([
    {
      id: "test.copy",
      enabled: () => false,
      run: () => calls.push(["dialog"]),
    },
  ]);

  assert.equal(isRegisteredCommandEnabled("test.copy"), false);
  assert.equal(runRegisteredCommand("test.copy"), false);
  unregisterDialog();

  assert.equal(isRegisteredCommandEnabled("test.copy", ["/b.jpg"]), true);
  assert.equal(runRegisteredCommand("test.copy", ["/b.jpg"]), true);
  unregisterFileView();

  assert.equal(isRegisteredCommandEnabled("test.copy"), false);
  assert.deepEqual(calls, [
    ["file-view", ["/a.jpg"]],
    ["file-view", ["/b.jpg"]],
  ]);
});
