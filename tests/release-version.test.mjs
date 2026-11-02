import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { nextVersion, compareVersions, reserveVersion } = createRequire(import.meta.url)(
  "../scripts/release-version.cjs"
);

test("release versions start at 0.1.0 and increment numerically, ignoring build tags", () => {
  assert.equal(nextVersion(["build-123"]), "0.1.0");
  assert.equal(nextVersion(["v0.1.9", "v0.1.10", "v0.1.2"]), "0.1.11");
  assert.equal(nextVersion(["v0.2.0", "v0.1.99", "v0.3.0-beta"]), "0.2.1");
  assert.ok(compareVersions("v0.1.10", "v0.1.9") > 0);
});
test("a reservation collision retries and a rerun reuses the annotated version", async () => {
  let tags = [{ name: "v0.1.0", commit: { sha: "old" } }];
  let collision = true;
  const objects = new Map();
  const refs = new Map();
  const github = {
    paginate: async () => tags,
    rest: {
      repos: { listTags() {} },
      git: {
        createTag: async (args) => {
          const sha = args.tag;
          objects.set(sha, args);
          return { data: { sha } };
        },
        createRef: async (args) => {
          const name = args.ref.replace("refs/tags/", "");
          if (collision) {
            collision = false;
            tags = [...tags, { name, commit: { sha: "other" } }];
            refs.set(name, { data: { object: { type: "tag", sha: name } } });
            throw Object.assign(new Error("exists"), { status: 422 });
          }
          tags = [...tags, { name, commit: { sha: "current" } }];
          refs.set(name, { data: { object: { type: "tag", sha: args.sha } } });
        },
        getRef: async (args) => refs.get(args.ref.replace("tags/", "")),
        getTag: async (args) => ({ data: objects.get(args.tag_sha) }),
      },
    },
  };
  const context = { repo: { owner: "test", repo: "test" }, sha: "current", runId: 42 };
  assert.equal(await reserveVersion(github, context), "0.1.2");
  assert.equal(await reserveVersion(github, context), "0.1.2");
  assert.equal(tags.length, 3);
});
