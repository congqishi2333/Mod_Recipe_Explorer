import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); fail++; }
}

async function waitForHealth(base, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await delay(200);
  }
  throw new Error('server did not become healthy');
}

async function withServer(env, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-int-'));
  const port = 31000 + Math.floor(Math.random() * 20000);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  child.stdout.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
    await fn({ base, dataDir, tmp, port, getStderr: () => stderr });
  } finally {
    child.kill();
    await Promise.race([new Promise(r => child.on('exit', r)), delay(3000)]);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function runNodeModule(code, env = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'error', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let so = '', se = '';
    c.stdout.on('data', d => { so += String(d); });
    c.stderr.on('data', d => { se += String(d); });
    c.on('exit', (code) => code === 0 ? resolve({ so, se }) : reject(new Error(se || so || `exit ${code}`)));
  });
}

console.log('\n[1] /api/cache-stats + /api/maintenance/prune HTTP');
await withServer({ MAINTENANCE_INTERVAL_MS: '60000' }, async ({ base, dataDir }) => {
  const vr = path.join(dataDir, 'vanilla-renders', '1.21.1');
  fs.mkdirSync(vr, { recursive: true });
  fs.writeFileSync(path.join(vr, 'a.png'), Buffer.alloc(128, 1));
  const st = await fetch(`${base}/api/cache-stats`);
  const stats = await st.json();
  check('cache-stats 200', st.status === 200, String(st.status));
  check('cache-stats ok', stats.ok === true, JSON.stringify(stats));
  check('cache-stats 有 vanillaRenders', !!stats.vanillaRenders, JSON.stringify(stats));
  check('cache-stats 有 limits', !!stats.vanillaRenders?.limits, JSON.stringify(stats.vanillaRenders?.limits));
  check('cache-stats 统计到版本', stats.vanillaRenders?.versionCount >= 1, JSON.stringify(stats.vanillaRenders));

  const oldVr = path.join(dataDir, 'vanilla-renders', '1.20.1');
  fs.mkdirSync(oldVr, { recursive: true });
  fs.writeFileSync(path.join(oldVr, 'old.png'), Buffer.alloc(64, 2));
  const oldT = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldVr, oldT, oldT);
  const pr = await fetch(`${base}/api/maintenance/prune`, { method: 'POST' });
  const prj = await pr.json();
  check('maintenance/prune 200', pr.status === 200, String(pr.status));
  check('maintenance/prune ok', prj.ok === true, JSON.stringify(prj));
  check('maintenance/prune 返回 vanillaRenders', !!prj.vanillaRenders, JSON.stringify(prj));
  check('maintenance/prune 清理过期 vanilla render', !fs.existsSync(oldVr), JSON.stringify(prj.vanillaRenders?.removed));
});

console.log('\n[2] maintenance 节流/skip 语义');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-maint-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const serverUrl = 'file:///' + path.join(root, 'server.js').replace(/\\/g, '/');
  const code = `
    process.env.DATA_DIR=${JSON.stringify(dataDir)};
    process.env.MAINTENANCE_INTERVAL_MS='60000';
    process.env.LOG_LEVEL='error';
    const { runDataMaintenance } = await import(${JSON.stringify(serverUrl)});
    const a = await runDataMaintenance('test', { force: true });
    const b = await runDataMaintenance('test2');
    const c = await runDataMaintenance('test3', { force: true });
    console.log(JSON.stringify({ a, b, c }));
  `;
  const out = await runNodeModule(code, { DATA_DIR: dataDir, MAINTENANCE_INTERVAL_MS: '60000' });
  const line = out.so.trim().split(/\r?\n/).filter(Boolean).pop();
  const j = JSON.parse(line);
  check('force maintenance ok', j.a?.ok === true, JSON.stringify(j.a));
  check('non-force 被节流 skip', j.b?.ok === true && j.b?.skipped === true, JSON.stringify(j.b));
  check('force 可绕过节流', j.c?.ok === true && j.c?.skipped !== true, JSON.stringify(j.c));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n[3] prewarm 失败回滚清理 tmp');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-prewarm-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const analyzerUrl = 'file:///' + path.join(root, 'lib/analyzer.js').replace(/\\/g, '/');
  const missingJar = path.join(tmp, 'missing.jar');
  const code = `
    process.env.LOG_LEVEL='error';
    import fs from 'fs';
    const dataDir=${JSON.stringify(dataDir)};
    const { prewarmVanillaRenders } = await import(${JSON.stringify(analyzerUrl)});
    const r = await prewarmVanillaRenders({ mcVersion: '1.21.1', vanillaJar: ${JSON.stringify(missingJar)}, dataDir });
    const rootDir = dataDir + '/vanilla-renders';
    const entries = fs.existsSync(rootDir) ? fs.readdirSync(rootDir) : [];
    console.log(JSON.stringify({ r, entries }));
  `;
  const out = await runNodeModule(code);
  const j = JSON.parse(out.so.trim().split(/\r?\n/).filter(Boolean).pop());
  check('vanilla missing 返回 ok:false', j.r?.ok === false, JSON.stringify(j.r));
  check('失败/缺失场景不遗留 tmp', !j.entries.some(e => String(e).startsWith('.tmp-')), JSON.stringify(j.entries));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
