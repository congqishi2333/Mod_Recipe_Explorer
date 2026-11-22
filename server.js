import express from 'express';
import multer from 'multer';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { analyzeModJar, prewarmVanillaRenders, getPrewarmProgress } from './lib/analyzer.js';
import { findVanillaJar, loadVanillaAssets } from './lib/vanilla.js';
import { getRenderStats } from './lib/render3d.js';
import { SUPPORTED_VERSIONS, LATEST_VERSION, DEFAULT_VERSION, normalizeMcVersion } from './lib/versions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3033;
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

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
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.jar') || file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
    else cb(new Error('Only .jar/.zip supported'));
  },
});

app.use(express.json({ limit: '2mb' }));
app.use('/', express.static(path.join(__dirname, 'public')));
// 只暴露分析结果、图标、渲染图和 vanilla 预热图，不暴露 uploads/ 里别人上传的 jar
const idSafe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
function sendIfExists(res, p) {
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
}
app.get('/data/vanilla-renders/:version/:file', (req, res) => {
  let version;
  try { version = normalizeMcVersion(req.params.version); }
  catch { return res.status(404).end(); }
  sendIfExists(res, path.join(dataDir, 'vanilla-renders', version, path.basename(req.params.file)));
});
app.get('/data/:id/analysis.json', (req, res) =>
  sendIfExists(res, path.join(dataDir, idSafe(req.params.id), 'analysis.json')));
app.get('/data/:id/:kind/:file', (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'icons' && kind !== 'renders') return res.status(404).end();
  sendIfExists(res, path.join(dataDir, idSafe(req.params.id), kind, path.basename(req.params.file)));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/versions', (_req, res) => res.json({
  versions: SUPPORTED_VERSIONS, latest: LATEST_VERSION, default: DEFAULT_VERSION,
}));

app.post('/api/prewarm-vanilla', async (req, res) => {
  try {
    const mcVersion = normalizeMcVersion(req.body?.mcVersion);
    const out = await prewarmVanillaRenders({ mcVersion, vanillaJar: safeVanillaJar(req.body?.vanillaJar) });
    res.json(out);
  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, error: String(e?.message || e) });
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
  });
});

app.post('/api/analyze', upload.single('mod'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const outDir = path.join(dataDir, path.parse(req.file.filename).name);
    fs.mkdirSync(outDir, { recursive: true });
    const vanillaJar = safeVanillaJar(req.body?.vanillaJar);
    const mcVersion = normalizeMcVersion(req.body?.mcVersion);
    const includeVanillaEquivalents = req.body?.includeVanillaEquivalents === true
      || req.body?.includeVanillaEquivalents === '1'
      || req.body?.includeVanillaEquivalents === 'true';
    const result = await analyzeModJar(req.file.path, outDir, {
      mcVersion, vanillaJar, includeVanillaEquivalents,
    });
    res.json({
      ok: true,
      mcVersion,
      analysisUrl: `/data/${path.basename(outDir)}/analysis.json`,
      ...result.summary,
    });
  } catch (e) {
    log.error({ err: e }, 'analyze failed');
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/analysis/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const p = path.join(dataDir, id, 'analysis.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

app.listen(PORT, () => {
  log.info({ port: PORT, versions: SUPPORTED_VERSIONS.length, latest: LATEST_VERSION }, 'recipe-analyzer listening');
  const v = findVanillaJar(DEFAULT_VERSION);
  log.info({ jar: v, mcVersion: DEFAULT_VERSION }, v ? 'vanilla jar detected' : 'vanilla jar not found');
  // 只预热默认版本的 vanilla 渲染；其他版本在首次分析或手动调用 /api/prewarm-vanilla 时按需生成。
  // 延迟到下一轮事件循环再启动预热，避免阻塞首个请求；进度见 /api/vanilla-status
  setImmediate(() => {
    prewarmVanillaRenders({ mcVersion: DEFAULT_VERSION, vanillaJar: process.env.VANILLA_JAR || null })
      .then(r => log.info({ result: r }, 'vanilla prewarm done'))
      .catch(e => log.warn({ err: e }, 'vanilla prewarm failed'));
  });
});
