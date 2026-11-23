import { parentPort, workerData } from 'worker_threads';
import { analyzeModJar } from './analyzer.js';

function report(stage, detail = {}) {
  try {
    parentPort?.postMessage({ type: 'progress', progress: { stage, at: Date.now(), ...detail } });
  } catch {}
}

async function main() {
  const { jarPaths, outDir, options } = workerData || {};
  report('worker-started', { files: Array.isArray(jarPaths) ? jarPaths.length : 0 });
  const result = await analyzeModJar(jarPaths, outDir, options || {});
  report('completed');
  return {
    summary: result.summary,
  };
}

main().then((payload) => {
  parentPort?.postMessage({ ok: true, ...payload });
}).catch((e) => {
  report('failed', { error: String(e?.message || e) });
  parentPort?.postMessage({
    ok: false,
    status: e?.status || 500,
    error: String(e?.message || e),
  });
});
