// Atomically reserve a version tag. Annotated tags identify reruns without
// depending on build completion order or a mutable package.json commit.
function compareVersions(a, b) {
  const av = a.replace(/^v/, "").split(".").map(Number);
  const bv = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
}
function nextVersion(tags) {
  const versions = tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)).sort(compareVersions);
  if (!versions.length) return "0.1.0";
  const [major, minor, patch] = versions.at(-1).slice(1).split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
async function reserveVersion(github, context) {
  const repo = context.repo;
  const marker = `ImageExplorer release run:${context.runId}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const tags = await github.paginate(github.rest.repos.listTags, { ...repo, per_page: 100 });
    // A rerun must reuse the version already reserved by this workflow run.
    for (const tag of tags.filter(
      (t) => /^v\d+\.\d+\.\d+$/.test(t.name) && t.commit.sha === context.sha
    )) {
      const ref = await github.rest.git.getRef({ ...repo, ref: `tags/${tag.name}` });
      if (ref.data.object.type !== "tag") continue;
      const object = await github.rest.git.getTag({ ...repo, tag_sha: ref.data.object.sha });
      if (object.data.message.trim() === marker) return tag.name.slice(1);
    }
    const version = nextVersion(tags.map((tag) => tag.name));
    const tag = await github.rest.git.createTag({
      ...repo,
      tag: `v${version}`,
      message: marker,
      object: context.sha,
      type: "commit",
    });
    try {
      await github.rest.git.createRef({ ...repo, ref: `refs/tags/v${version}`, sha: tag.data.sha });
      return version;
    } catch (error) {
      if (error.status !== 422) throw error;
      // Only retry a real reservation collision, not arbitrary validation errors.
      await github.rest.git.getRef({ ...repo, ref: `tags/v${version}` });
    }
  }
  throw new Error("Could not reserve a unique release version after 20 attempts");
}
module.exports = { compareVersions, nextVersion, reserveVersion };
