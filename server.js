import express from 'express';
import multer from 'multer';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { prewarmVanillaRenders, getPrewarmProgress } from './lib/analyzer.js';
import { findVanillaJar, loadVanillaAssets, clearVanillaCache } from './lib/vanilla.js';
import { getRenderStats, resetRenderStats } from './lib/render3d.js';
import { SUPPORTED_VERSIONS, LATEST_VERSION, DEFAULT_VERSION, normalizeMcVersion } from './lib/versions.js';
import { pruneDataDir, pruneUploadsDir, pruneVanillaRendersDir, getVanillaRendersStats } from './lib/data-maintenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3033;
const HOST = process.env.HOST || '127.0.0.1';
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const DATA_MAX_AGE_MS = Math.max(0, Number(process.env.DATA_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000);
const DATA_MAX_ENTRIES = Math.max(1, Number(process.env.DATA_MAX_ENTRIES) || 30);
const DATA_MAX_TOTAL_BYTES = Math.max(0, Number(process.env.DATA_MAX_TOTAL_BYTES) || 512 * 1024 * 1024);
const UPLOAD_MAX_AGE_MS = Math.max(0, Number(process.env.UPLOAD_MAX_AGE_MS) || 24 * 60 * 60 * 1000);
const VANILLA_RENDERS_MAX_AGE_MS = Math.max(0, Number(process.env.VANILLA_RENDERS_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000);
const VANILLA_RENDERS_MAX_ENTRIES = Math.max(1, Number(process.env.VANILLA_RENDERS_MAX_ENTRIES) || 8);
const VANILLA_RENDERS_MAX_TOTAL_BYTES = Math.max(0, Number(process.env.VANILLA_RENDERS_MAX_TOTAL_BYTES) || 1024 * 1024 * 1024);
const MAINTENANCE_INTERVAL_MS = Math.max(0, Number(process.env.MAINTENANCE_INTERVAL_MS) || 5 * 60 * 1000);
let lastMaintenanceAt = 0;
let maintenanceInFlight = null;

async function runDataMaintenance(reason = 'manual', { force = false } = {}) {
  const now = Date.now();
  if (!force && MAINTENANCE_INTERVAL_MS > 0 && (now - lastMaintenanceAt) < MAINTENANCE_INTERVAL_MS) {
    return { ok: true, reason, skipped: true, nextInMs: MAINTENANCE_INTERVAL_MS - (now - lastMaintenanceAt) };
  }
  if (maintenanceInFlight) return maintenanceInFlight;
  maintenanceInFlight = (async () => {
    try {
      const protect = activeAnalysis?.outId ? [activeAnalysis.outId] : [];
      const data = await pruneDataDir(dataDir, {
        maxAgeMs: DATA_MAX_AGE_MS,
        maxEntries: DATA_MAX_ENTRIES,
        maxTotalBytes: DATA_MAX_TOTAL_BYTES,
        protectNames: protect,
      });
      const uploads = await pruneUploadsDir(uploadDir, UPLOAD_MAX_AGE_MS);
      const vanillaRenders = await pruneVanillaRendersDir(path.join(dataDir, 'vanilla-renders'), {
        maxAgeMs: VANILLA_RENDERS_MAX_AGE_MS,
        maxEntries: VANILLA_RENDERS_MAX_ENTRIES,
        maxTotalBytes: VANILLA_RENDERS_MAX_TOTAL_BYTES,
        protectVersions: [DEFAULT_VERSION],
      });
      lastMaintenanceAt = Date.now();
      if (data.removed.length || uploads.removed || vanillaRenders.removed.length) {
        log.info({ reason, data, uploads, vanillaRenders }, 'data maintenance completed');
      }
      return { ok: true, reason, data, uploads, vanillaRenders };
    } catch (e) {
      log.warn({ err: e, reason }, 'data maintenance failed');
      return { ok: false, reason, error: String(e?.message || e) };
    } finally {
      maintenanceInFlight = null;
    }
  })();
  return maintenanceInFlight;
}

const ANALYZE_TIMEOUT_MS = Math.max(30_000, Number(process.env.ANALYZE_TIMEOUT_MS) || 10 * 60_000);
const ANALYZE_MAX_RETRIES = Math.max(0, Math.min(3, Number(process.env.ANALYZE_MAX_RETRIES ?? 1)));

let activeAnalysis = null; // { startedAt, files, outId, worker, attempt, maxAttempts, progress, cancelRequested }
function getAnalyzeStatus() {
  if (!activeAnalysis) return { running: false };
  return {
    running: true,
    startedAt: activeAnalysis.startedAt,
    outId: activeAnalysis.outId,
    files: activeAnalysis.files,
    elapsedMs: Date.now() - activeAnalysis.startedAt,
    attempt: activeAnalysis.attempt,
    maxAttempts: activeAnalysis.maxAttempts,
    progress: activeAnalysis.progress || null,
    cancelRequested: !!activeAnalysis.cancelRequested,
  };
}

function isRetryableWorkerError(err) {
  if (!err) return false;
  if (err.cancelled) return false;
  // Explicit logical/validation errors from worker payload are not retried.
  if (err.logical) return false;
  const msg = String(err.message || err);
  return err.workerCrash === true
    || err.code === 'ANALYZE_TIMEOUT'
    || /Analyze worker exited|Worker stopped|worker/i.test(msg);
}

function runAnalyzeInWorkerOnce(payload, { timeoutMs, attempt, maxAttempts }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lib/analyze-task.js', import.meta.url), {
      workerData: payload,
    });
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
    };
    const finishResolve = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    if (activeAnalysis) {
      activeAnalysis.worker = worker;
      activeAnalysis.attempt = attempt;
      activeAnalysis.maxAttempts = maxAttempts;
    }

    timer = setTimeout(async () => {
      const err = new Error(`Analysis timed out after ${timeoutMs}ms`);
      err.status = 504;
      err.code = 'ANALYZE_TIMEOUT';
      err.workerCrash = true;
      try { await worker.terminate(); } catch {}
      finishReject(err);
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        if (activeAnalysis) activeAnalysis.progress = msg.progress || msg;
        return;
      }
      if (msg?.ok) return finishResolve(msg);
      const err = new Error(msg?.error || 'Analysis failed');
      err.status = msg?.status || 500;
      err.logical = true; // from analyzer, do not auto-retry
      finishReject(err);
    });

    worker.on('error', (err) => {
      err.workerCrash = true;
      finishReject(err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      if (code === 0) {
        finishReject(new Error('Analyze worker exited before sending result'));
        return;
      }
      const err = new Error(`Analyze worker exited with code ${code}`);
      err.status = 500;
      err.workerCrash = true;
      finishReject(err);
    });
  });
}

async function runAnalyzeInWorker(payload, opts = {}) {
  const timeoutMs = Math.max(30_000, Number(opts.timeoutMs) || ANALYZE_TIMEOUT_MS);
  const retries = Math.max(0, Math.min(3, Number(opts.retries ?? ANALYZE_MAX_RETRIES)));
  const maxAttempts = retries + 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (activeAnalysis?.cancelRequested) {
      const err = new Error('Analysis cancelled');
      err.status = 499;
      err.cancelled = true;
      throw err;
    }
    try {
      if (activeAnalysis) {
        activeAnalysis.progress = { stage: 'starting', attempt, maxAttempts };
      }
      return await runAnalyzeInWorkerOnce(payload, { timeoutMs, attempt, maxAttempts });
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < maxAttempts && isRetryableWorkerError(err);
      log.warn({ err, attempt, maxAttempts, canRetry }, 'analyze worker attempt failed');
      if (!canRetry) throw err;
      if (activeAnalysis) activeAnalysis.progress = { stage: 'retrying', attempt, maxAttempts, error: String(err?.message || err) };
      await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 3000)));
    }
  }
  throw lastErr;
}

function cleanupUploads(files = []) {
  for (const f of files) {
    try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
  }
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

function safeDataPath(...parts) {
  const resolved = path.resolve(dataDir, ...parts);
  const base = path.resolve(dataDir) + path.sep;
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

// 用户提供的 vanillaJar 只允许 .jar 且位于已知的 Minecraft 安装目录下，
// 防止任意绝对路径读取。环境变量 VANILLA_JAR 是服务端配置，不走此校验。
const VANILLA_ROOTS = [
  path.join(os.homedir(), '.minecraft', 'versions'),
  path.join(os.homedir(), '.minecraft', 'libraries', 'net', 'minecraft', 'client'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft', 'versions'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'minecraft-dev-mcp', 'jars'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'minecraft-dev-mcp', 'remapped'),
];
function safeVanillaJar(input) {
  if (!input) return null;
  const p = String(input);
  if (!p.toLowerCase().endsWith('.jar')) {
    const e = new Error('vanillaJar must be a .jar file'); e.status = 400; throw e;
  }
  const resolved = path.resolve(p);
  if (resolved.includes('..') || !VANILLA_ROOTS.some(root => resolved.startsWith(root + path.sep))) {
    const e = new Error('vanillaJar must be inside a recognized Minecraft directory'); e.status = 400; throw e;
  }
  return resolved;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const base = path.parse(file.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'mod';
    cb(null, `${Date.now()}-${base}.upload`);
  }
});
const upload = multer({
  storage,
  // 一次最多 50 个 jar，单个上限 200MB；命名空间表由全部 jar 共享，
  // 才能区分「内部引用」与「外部依赖」。
  limits: { fileSize: 200 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.jar') || file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
    else cb(new Error('Only .jar/.zip supported'));
  },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return res.status(421).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use('/', express.static(path.join(__dirname, 'public')));
// 只暴露分析结果、图标、渲染图和 vanilla 预热图，不暴露 uploads/ 里别人上传的 jar
function sendIfExists(res, p) {
  if (!p || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
}
app.get('/data/vanilla-renders/:version/:file', (req, res) => {
  let version;
  try { version = normalizeMcVersion(req.params.version); }
  catch { return res.status(404).end(); }
  const file = path.basename(req.params.file || '');
  if (!/^[A-Za-z0-9._-]+\.png$/i.test(file)) return res.status(404).end();
  sendIfExists(res, safeDataPath('vanilla-renders', version, file));
});
app.get('/data/:id/analysis.json', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(404).end();
  sendIfExists(res, safeDataPath(id, 'analysis.json'));
});
app.get('/data/:id/:kind/:file', (req, res) => {
  const { id, kind } = req.params;
  if (!isSafeId(id) || (kind !== 'icons' && kind !== 'renders')) return res.status(404).end();
  const file = path.basename(req.params.file || '');
  if (!/^[A-Za-z0-9._-]+\.png$/i.test(file)) return res.status(404).end();
  sendIfExists(res, safeDataPath(id, kind, file));
});

app.get('/api/health', (_req, res) => res.json({ ok: true, analyze: getAnalyzeStatus() }));
app.post('/api/maintenance/prune', async (_req, res) => {
  const result = await runDataMaintenance('api', { force: true });
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/cache-stats', async (_req, res) => {
  try {
    const stats = await getVanillaRendersStats(path.join(dataDir, 'vanilla-renders'));
    res.json({
      ok: true,
      vanillaRenders: {
        ...stats,
        limits: {
          maxAgeMs: VANILLA_RENDERS_MAX_AGE_MS,
          maxEntries: VANILLA_RENDERS_MAX_ENTRIES,
          maxTotalBytes: VANILLA_RENDERS_MAX_TOTAL_BYTES,
        },
      },
      data: {
        limits: {
          maxAgeMs: DATA_MAX_AGE_MS,
          maxEntries: DATA_MAX_ENTRIES,
          maxTotalBytes: DATA_MAX_TOTAL_BYTES,
        },
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.get('/api/versions', (_req, res) => res.json({
  versions: SUPPORTED_VERSIONS, latest: LATEST_VERSION, default: DEFAULT_VERSION,
}));
app.get('/api/analyze/status', (_req, res) => res.json({ ok: true, ...getAnalyzeStatus() }));

app.post('/api/analyze/cancel', async (_req, res) => {
  if (!activeAnalysis) return res.status(404).json({ ok: false, error: 'No analysis running' });
  activeAnalysis.cancelRequested = true;
  activeAnalysis.progress = { ...(activeAnalysis.progress || {}), stage: 'cancelling' };
  try {
    if (activeAnalysis.worker) await activeAnalysis.worker.terminate();
  } catch (e) {
    log.warn({ err: e }, 'failed to terminate analysis worker');
  }
  res.json({ ok: true, ...getAnalyzeStatus() });
});

app.post('/api/prewarm-vanilla', async (req, res) => {
  try {
    const mcVersion = normalizeMcVersion(req.body?.mcVersion);
    const out = await prewarmVanillaRenders({ mcVersion, vanillaJar: safeVanillaJar(req.body?.vanillaJar), dataDir });
    res.json(out);
  } catch (e) {
    const status = e?.status || 500;
    res.status(status).json({ ok: false, error: status >= 500 ? 'Prewarm failed' : String(e?.message || e) });
  }
});

app.get('/api/vanilla-status', (req, res) => {
  let explicit, mcVersion;
  try {
    explicit = safeVanillaJar(req.query.path);
    mcVersion = normalizeMcVersion(req.query.version);
  } catch (e) { return res.status(e?.status || 500).json({ ok: false, error: String(e?.message || e) }); }
  const jarPath = explicit || findVanillaJar(mcVersion);
  const loaded = loadVanillaAssets(mcVersion, jarPath);
  res.json({
    ok: !!loaded.ok,
    mcVersion,
    jarPath: loaded.jarPath || jarPath || null,
    error: loaded.error || null,
    prewarm: getPrewarmProgress(),
    renderStats: getRenderStats(),
    memory: { rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1) },
  });
});

app.post('/api/clear-cache', (req, res) => {
  try {
    clearVanillaCache();
    if (req.body?.resetStats) resetRenderStats();
    if (global.gc) global.gc();
    res.json({
      ok: true,
      gcRan: !!global.gc,
      memory: { rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1) },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to clear cache' });
  }
});

app.post('/api/analyze', upload.array('mods', 50), async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) return res.status(400).json({ error: 'No file uploaded' });
    if (activeAnalysis) {
      cleanupUploads(files);
      return res.status(409).json({ error: 'Analysis already in progress', analyze: getAnalyzeStatus() });
    }
    const outId = path.parse(files[0].filename).name;
    if (!isSafeId(outId)) return res.status(400).json({ error: 'Invalid upload id' });
    const outDir = safeDataPath(outId);
    if (!outDir) return res.status(400).json({ error: 'Invalid output path' });
    fs.mkdirSync(outDir, { recursive: true });
    const vanillaJar = safeVanillaJar(req.body?.vanillaJar);
    const mcVersion = normalizeMcVersion(req.body?.mcVersion);
    const includeVanillaEquivalents = req.body?.includeVanillaEquivalents === true
      || req.body?.includeVanillaEquivalents === '1'
      || req.body?.includeVanillaEquivalents === 'true';

    activeAnalysis = {
      startedAt: Date.now(),
      files: files.map(f => f.originalname),
      outId,
      worker: null,
      attempt: 0,
      maxAttempts: ANALYZE_MAX_RETRIES + 1,
      progress: { stage: 'queued' },
      cancelRequested: false,
    };
    const result = await runAnalyzeInWorker({
      jarPaths: files.map(f => f.path),
      outDir,
      options: { mcVersion, vanillaJar, includeVanillaEquivalents },
    }, { timeoutMs: ANALYZE_TIMEOUT_MS, retries: ANALYZE_MAX_RETRIES });
    void runDataMaintenance('post-analyze');
    res.json({
      ok: true,
      mcVersion,
      analysisUrl: `/data/${outId}/analysis.json`,
      ...result.summary,
    });
  } catch (e) {
    log.error({ err: e }, 'analyze failed');
    const status = e?.status || 500;
    res.status(status).json({ error: status >= 500 ? 'Analysis failed' : String(e?.message || e) });
  } finally {
    activeAnalysis = null;
    cleanupUploads(files);
  }
});

app.get('/api/analysis/:id', (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(404).json({ error: 'Not found' });
  const p = safeDataPath(id, 'analysis.json');
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

app.use((err, req, res, _next) => {
  cleanupUploads(req?.files || []);
  log.error({ err }, 'request failed');
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code });
  const status = err?.status || 500;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : String(err?.message || err) });
});

export { app, runDataMaintenance, dataDir };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, HOST, () => {
    log.info({ host: HOST, port: PORT, versions: SUPPORTED_VERSIONS.length, latest: LATEST_VERSION }, 'recipe-analyzer listening');
    const v = findVanillaJar(DEFAULT_VERSION);
    log.info({ jar: v, mcVersion: DEFAULT_VERSION }, v ? 'vanilla jar detected' : 'vanilla jar not found');
    void runDataMaintenance('startup', { force: true });
    // 只预热默认版本的 vanilla 渲染；其他版本在首次分析或手动调用 /api/prewarm-vanilla 时按需生成。
    // 延迟到下一轮事件循环再启动预热，避免阻塞首个请求；进度见 /api/vanilla-status
    setImmediate(() => {
      prewarmVanillaRenders({ mcVersion: DEFAULT_VERSION, vanillaJar: process.env.VANILLA_JAR || null, dataDir })
        .then(r => log.info({ result: r }, 'vanilla prewarm done'))
        .catch(e => log.warn({ err: e }, 'vanilla prewarm failed'));
    });
  });
}
