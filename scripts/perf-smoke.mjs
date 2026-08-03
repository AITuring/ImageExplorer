import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const requested = Number(process.env.PERF_ITEMS ?? 10000);
const itemCount = Number.isFinite(requested) && requested > 0 ? requested : 10000;
const fixture = await mkdtemp(join(tmpdir(), "imageexplorer-perf-"));

try {
  const createStart = performance.now();
  await Promise.all(
    Array.from({ length: itemCount }, (_, index) =>
      writeFile(join(fixture, `item-${String(index).padStart(7, "0")}.dat`), "x")
    )
  );
  const createMs = performance.now() - createStart;

  const readStart = performance.now();
  const entries = await readdir(fixture);
  const readMs = performance.now() - readStart;
  const sortStart = performance.now();
  entries.sort((left, right) => left.localeCompare(right));
  const sortMs = performance.now() - sortStart;

  console.log(
    JSON.stringify(
      {
        fixture,
        itemCount,
        createMs: Math.round(createMs),
        readMs: Math.round(readMs),
        sortMs: Math.round(sortMs),
        note: "This is a host filesystem baseline, not a Tauri IPC or React P95 measurement.",
      },
      null,
      2
    )
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
