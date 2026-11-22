import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { analyzeModJar } from './lib/analyzer.js';
import { prewarmVanillaRenders } from './lib/analyzer.js';
import { findVanillaJar, loadVanillaAssets } from './lib/vanilla.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3033;

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage, fileFilter: (_req, file, cb) => {
  if (file.originalname.toLowerCase().endsWith('.jar') || file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
  else cb(new Error('Only .jar/.zip supported'));
}});

app.use(express.json({ limit: '2mb' }));
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(dataDir));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/prewarm-vanilla', async (req, res) => {
  try {
    const out = await prewarmVanillaRenders({ mcVersion: req.body?.mcVersion || '1.21.1', vanillaJar: req.body?.vanillaJar || null });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/vanilla-status', (req, res) => {
  const explicit = req.query.path ? String(req.query.path) : null;
  const jarPath = explicit || findVanillaJar('1.21.1');
  const loaded = loadVanillaAssets('1.21.1', jarPath);
  res.json({ ok: !!loaded.ok, jarPath: loaded.jarPath || jarPath || null, error: loaded.error || null });
});

app.post('/api/analyze', upload.single('mod'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const outDir = path.join(dataDir, path.parse(req.file.filename).name);
    fs.mkdirSync(outDir, { recursive: true });
    const vanillaJar = req.body?.vanillaJar ? String(req.body.vanillaJar) : null;
    const result = await analyzeModJar(req.file.path, outDir, { mcVersion: '1.21.1', vanillaJar });
    res.json({
      ok: true,
      analysisUrl: `/data/${path.basename(outDir)}/analysis.json`,
      ...result.summary,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/api/analysis/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const p = path.join(dataDir, id, 'analysis.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(p);
});

app.listen(PORT, () => {
  console.log(`recipe-analyzer listening on http://127.0.0.1:${PORT}`);
  const v = findVanillaJar('1.21.1');
  console.log(v ? `Vanilla 1.21.1 jar: ${v}` : 'Vanilla 1.21.1 jar: not found (set VANILLA_JAR or provide in UI)');
  prewarmVanillaRenders({ mcVersion: '1.21.1', vanillaJar: process.env.VANILLA_JAR || null })
    .then(r => console.log('[vanilla-prewarm]', r))
    .catch(e => console.warn('[vanilla-prewarm] failed:', e?.message || e));
});
