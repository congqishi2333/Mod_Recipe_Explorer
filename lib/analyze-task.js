import { parentPort, workerData } from 'worker_threads';
import { analyzeModJar } from './analyzer.js';

async function main() {
  const { jarPaths, outDir, options } = workerData || {};
  const result = await analyzeModJar(jarPaths, outDir, options || {});
  return {
    summary: result.summary,
  };
}

main().then((payload) => {
  parentPort?.postMessage({ ok: true, ...payload });
}).catch((e) => {
  parentPort?.postMessage({
    ok: false,
    status: e?.status || 500,
    error: String(e?.message || e),
  });
});
