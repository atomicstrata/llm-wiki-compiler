/** Reproduce single-versus-batch CLI timings on disposable, credential-free wikis. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const exec = promisify(execFile);
const [cli, mode = 'single', pagesArgument = '1500', candidatesArgument = '30'] = process.argv.slice(2);
const pages = Number(pagesArgument);
const candidates = Number(candidatesArgument);
const timestamp = '2026-09-17T00:00:00.000Z';
const FILE_WRITE_BATCH_SIZE = 50;
const COMMAND_TIMEOUT_MS = 300_000;
const COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
if (!cli || !['single', 'batch'].includes(mode) || !Number.isInteger(pages) || !Number.isInteger(candidates) || pages < 0 || candidates < 1) {
  throw new Error('Usage: node benchmark.mjs CLI single|batch PAGE_COUNT CANDIDATE_COUNT');
}

/** Construct predictable corpus pages containing references to newly approved concepts. */
function pageBody(title, index) {
  return `---\ntitle: "${title}"\nsummary: "Benchmark knowledge"\nsources: []\ncreatedAt: "${timestamp}"\nupdatedAt: "${timestamp}"\n---\n\n# ${title}\n\nThis page discusses Batch Topic ${index % candidates} and Batch Topic ${(index + 1) % candidates}.\n`;
}

/** Seed the same trusted-page and pending-candidate fixture for each independent trial. */
async function seed(root) {
  await mkdir(path.join(root, 'wiki/concepts'), { recursive: true });
  await mkdir(path.join(root, '.llmwiki/candidates'), { recursive: true });
  await mkdir(path.join(root, 'sources'), { recursive: true });
  for (let start = 0; start < pages; start += FILE_WRITE_BATCH_SIZE) {
    await Promise.all(Array.from({ length: Math.min(FILE_WRITE_BATCH_SIZE, pages - start) }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(root, `wiki/concepts/existing-${index}.md`), pageBody(`Existing ${index}`, index));
    }));
  }
  const items = [];
  for (let index = 0; index < candidates; index++) {
    const id = `batch-topic-${index}-abcdef01`;
    const candidate = { id, slug: `batch-topic-${index}`, title: `Batch Topic ${index}`,
      summary: 'Benchmark knowledge', sources: [], body: pageBody(`Batch Topic ${index}`, index),
      generatedAt: timestamp, reviewMode: 'forced', heldReasons: [{ code: 'manual-review-requested' }] };
    await writeFile(path.join(root, '.llmwiki/candidates', `${id}.json`), JSON.stringify(candidate));
    items.push({ id });
  }
  await writeFile(path.join(root, 'batch-input.json'), JSON.stringify({ schemaVersion: 1, candidates: items }));
  return items;
}

/** Execute the compiled CLI with embeddings disabled and a bounded command budget. */
async function invoke(root, arguments_) {
  const started = performance.now();
  const output = await exec(process.execPath, [path.resolve(cli), ...arguments_], {
    cwd: root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_BYTES,
    env: { ...process.env, LLMWIKI_EMBEDDINGS: 'off', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
  return { durationMs: performance.now() - started, stdout: output.stdout };
}

/** Keep fixture construction outside timings and always remove only this run's generated directory. */
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'llmwiki-batch-benchmark-'));
  try {
    const items = await seed(root);
    const started = performance.now();
    const timings = [];
    let result;
    if (mode === 'single') {
      for (const item of items) {
        const run = await invoke(root, ['review', 'approve', item.id]);
        timings.push(run.durationMs);
        console.error(JSON.stringify({ completed: timings.length, total: candidates, durationMs: run.durationMs }));
      }
    } else {
      const run = await invoke(root, ['review', 'approve-batch', '--input', 'batch-input.json', '--json']);
      timings.push(run.durationMs);
      result = JSON.parse(run.stdout);
    }
    const pending = (await readdir(path.join(root, '.llmwiki/candidates'))).filter(name => name.endsWith('.json'));
    if (pending.length) throw new Error(`Benchmark left ${pending.length} pending candidates`);
    console.log(JSON.stringify({ mode, pages, candidates, totalMs: performance.now() - started,
      invocations: timings.length, invocationMs: timings, node: process.version, result }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
