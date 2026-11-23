import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
import { PNG } from 'pngjs';
const { collectRecipes } = await import(pathToFileURL(path.join(root, 'lib/recipes.js')).href);
const { analyzeModJar } = await import(pathToFileURL(path.join(root, 'lib/analyzer.js')).href);
const { pruneDataDir, pruneUploadsDir, pruneVanillaRendersDir } = await import(pathToFileURL(path.join(root, 'lib/data-maintenance.js')).href);
const { extractTextureFromSources } = await import(pathToFileURL(path.join(root, 'lib/zip.js')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const part = Buffer.concat([local, packed]);
    locals.push(part);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += part.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-regression-'));

console.log('\n[1] failedFiles: 强制解析阶段抛异常，批处理继续且可见');
{
  const origParse = JSON.parse;
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  JSON.parse = (s, reviver) => {
    const o = origParse(s, reviver);
    if (o && o.__forceThrow) {
      Object.defineProperty(o, 'type', {
        get() { throw new Error('forced-normalize-boom'); },
        enumerable: true,
        configurable: true,
      });
    }
    return o;
  };
  try {
    const entries = new Map([
      ['data/m/recipe/bad.json', {
        getData: () => Buffer.from(JSON.stringify({ __forceThrow: true, type: 'minecraft:crafting_shapeless', result: { id: 'm:bad', count: 1 } })),
      }],
      ['data/m/recipe/good.json', {
        getData: () => Buffer.from(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: [{ item: 'minecraft:stone' }], result: { id: 'm:good', count: 1 } })),
      }],
    ]);
    const stats = {};
    const recipes = collectRecipes(entries, stats);
    check('bad recipe 不拖垮整批', recipes.length === 1, `len=${recipes.length}`);
    check('failedFiles=1', stats.failedFiles === 1, `failed=${stats.failedFiles}`);
    check('failedSamples 含文件和错误', stats.failedSamples?.[0]?.file === 'data/m/recipe/bad.json' && /forced-normalize-boom/.test(stats.failedSamples?.[0]?.error || ''), JSON.stringify(stats.failedSamples?.[0]));
    check('console.warn 报告坏文件', warns.some(w => w.includes('recipe parse failed') && w.includes('data/m/recipe/bad.json') && w.includes('forced-normalize-boom')), warns[0] || '(no warn)');
  } finally {
    JSON.parse = origParse;
    console.warn = origWarn;
  }
}

console.log('\n[2] invalidJsonSamples 可见性');
{
  const jar = path.join(tmp, 'badjson.jar');
  fs.writeFileSync(jar, makeZip([
    ['data/m/recipe/broken.json', Buffer.from('{broken json', 'utf8')],
    ['data/m/recipe/good.json', Buffer.from(JSON.stringify({
      type: 'minecraft:crafting_shapeless',
      ingredients: [{ item: 'minecraft:stone' }],
      result: { id: 'm:good', count: 1 },
    }))],
  ]));
  const outDir = path.join(tmp, 'out-badjson');
  fs.mkdirSync(outDir, { recursive: true });
  const res = await analyzeModJar(jar, outDir, { mcVersion: '1.21.1' });
  check('invalidJsonFiles=1', res.summary.coverage.invalidJsonFiles === 1, String(res.summary.coverage.invalidJsonFiles));
  check('invalidJsonSamples 含文件路径', res.summary.coverage.invalidJsonSamples?.[0]?.file === 'data/m/recipe/broken.json', JSON.stringify(res.summary.coverage.invalidJsonSamples?.[0]));
  check('invalidJsonSamples 含错误', typeof res.summary.coverage.invalidJsonSamples?.[0]?.error === 'string' && res.summary.coverage.invalidJsonSamples[0].error.length > 0, res.summary.coverage.invalidJsonSamples?.[0]?.error);
  check('正常配方仍解析', res.summary.recipeCount === 1, String(res.summary.recipeCount));
}

console.log('\n[3] 跨 jar 共享解压预算端到端（分析必读路径）');
{
  const smallRecipe = Buffer.from(JSON.stringify({
    type: 'minecraft:crafting_shapeless',
    ingredients: [{ item: 'minecraft:stone' }],
    result: { id: 'm:small', count: 1 },
  }));
  const bigRecipe = Buffer.from(JSON.stringify({
    type: 'minecraft:crafting_shapeless',
    ingredients: [{ item: 'minecraft:dirt' }],
    result: { id: 'm:big', count: 1 },
    pad: 'x'.repeat(200000),
  }));
  const jar1 = path.join(tmp, 'budget-a.jar');
  const jar2 = path.join(tmp, 'budget-b.jar');
  fs.writeFileSync(jar1, makeZip([['data/m/recipe/a_small.json', smallRecipe]]));
  fs.writeFileSync(jar2, makeZip([['data/m/recipe/b_big.json', bigRecipe]]));

  const outDir = path.join(tmp, 'out-budget');
  fs.mkdirSync(outDir, { recursive: true });
  const res = await analyzeModJar([jar1, jar2], outDir, { mcVersion: '1.21.1', maxTotalInflatedBytes: 150000 });
  const cov = res.summary.coverage || {};
  check('分析完成而非崩溃', !!res.summary, 'summary missing');
  check('小配方正常解析', (res.summary.recipeCount || 0) >= 1, `recipeCount=${res.summary.recipeCount}`);
  check('预算超限被报告为 readError', (cov.readErrors || 0) >= 1, `readErrors=${cov.readErrors} codes=${JSON.stringify(cov.readErrorCodes)}`);
  check('readErrorCodes 含 size-limit', (cov.readErrorCodes?.['size-limit'] || 0) >= 1, JSON.stringify(cov.readErrorCodes));
  check('readErrorSamples 含大文件', (cov.readErrorSamples || []).some(s => s.file === 'data/m/recipe/b_big.json' && s.code === 'size-limit'), JSON.stringify(cov.readErrorSamples));
}

console.log('\n[4] data maintenance: age/maxEntries/maxTotalBytes/protectNames');
{
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const mk = (name, ageMs, bytes = 10) => {
    const dir = path.join(dataDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'analysis.json'), Buffer.alloc(bytes, 1));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
    fs.utimesSync(path.join(dir, 'analysis.json'), t, t);
    return dir;
  };
  mk('100000-old', 10 * 24 * 60 * 60 * 1000, 100);
  mk('200000-mid', 2 * 24 * 60 * 60 * 1000, 100);
  mk('300000-new', 1 * 60 * 60 * 1000, 100);
  mk('400000-protect', 20 * 24 * 60 * 60 * 1000, 100);

  let r = pruneDataDir(dataDir, { maxAgeMs: 3 * 24 * 60 * 60 * 1000, maxEntries: 10, maxTotalBytes: 1024 * 1024, protectNames: ['400000-protect'] });
  check('age 清理旧目录', r.removed.some(x => x.name === '100000-old' && x.reason === 'age'), JSON.stringify(r.removed));
  check('protectNames 保留过期目录', fs.existsSync(path.join(dataDir, '400000-protect')), r.removed.map(x=>x.name).join(','));

  r = pruneDataDir(dataDir, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxEntries: 2, maxTotalBytes: 1024 * 1024, protectNames: ['400000-protect'] });
  check('maxEntries 清理最旧非保护目录', !fs.existsSync(path.join(dataDir, '200000-mid')) && fs.existsSync(path.join(dataDir, '300000-new')), JSON.stringify(r.removed));

  // maxTotalBytes: keep newest + protected if possible
  const dataDir2 = fs.mkdtempSync(path.join(tmp, 'data2-'));
  mk2(dataDir2, '100000-a', 3 * 60 * 60 * 1000, 400);
  mk2(dataDir2, '200000-b', 2 * 60 * 60 * 1000, 400);
  mk2(dataDir2, '300000-c', 1 * 60 * 60 * 1000, 400);
  const r2 = pruneDataDir(dataDir2, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxEntries: 10, maxTotalBytes: 900, protectNames: [] });
  check('maxTotalBytes 清理旧目录', r2.removed.some(x => x.reason === 'maxTotalBytes'), JSON.stringify(r2.removed));
  check('maxTotalBytes 保留最新', fs.existsSync(path.join(dataDir2, '300000-c')), fs.readdirSync(dataDir2).join(','));
}

function mk2(dataDir, name, ageMs, bytes) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis.json'), Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t);
  fs.utimesSync(path.join(dir, 'analysis.json'), t, t);
}

console.log('\n[5] uploads maintenance: 过期上传文件清理');
{
  const upDir = fs.mkdtempSync(path.join(tmp, 'uploads-'));
  const oldFile = path.join(upDir, 'old.jar');
  const newFile = path.join(upDir, 'new.jar');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(newFile, 'new');
  const oldT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, oldT, oldT);
  const r = pruneUploadsDir(upDir, 24 * 60 * 60 * 1000);
  check('过期上传被删', !fs.existsSync(oldFile) && r.removed === 1, JSON.stringify(r));
  check('新上传保留', fs.existsSync(newFile), fs.readdirSync(upDir).join(','));
}

console.log('\n[6] L9: 非PNG/畸形PNG纹理被拒绝，不落盘');
{
  const outDir = fs.mkdtempSync(path.join(tmp, 'tex-'));
  const mkPng = (r, g, b) => {
    const png = new PNG({ width: 1, height: 1 });
    png.data[0] = r; png.data[1] = g; png.data[2] = b; png.data[3] = 255;
    return PNG.sync.write(png);
  };
  const validPng = mkPng(10, 20, 30);
  const entries = new Map([
    ['assets/m/textures/item/good.png', { getData: () => validPng }],
    ['assets/m/textures/item/bad.txt.png', { getData: () => Buffer.from('not a png') }],
    ['assets/m/textures/item/broken.png', { getData: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('broken')]) }],
  ]);

  const good = extractTextureFromSources(entries, null, 'm:item/good', outDir, 'good');
  check('有效PNG被提取', typeof good === 'string' && fs.existsSync(path.join(outDir, good)), String(good));
  const bad = extractTextureFromSources(entries, null, 'm:item/bad.txt', outDir, 'bad');
  check('非PNG被拒绝', bad === null, String(bad));
  check('非PNG未落盘', !fs.existsSync(path.join(outDir, 'bad.png')), fs.readdirSync(outDir).join(','));
  const broken = extractTextureFromSources(entries, null, 'm:item/broken', outDir, 'broken');
  check('畸形PNG被拒绝', broken === null, String(broken));
  check('畸形PNG未落盘', !fs.existsSync(path.join(outDir, 'broken.png')), fs.readdirSync(outDir).join(','));
}

console.log('\n[7] vanilla-renders prune: age/maxTotalBytes/protectVersions');
{
  const rootDir = fs.mkdtempSync(path.join(tmp, 'vr-'));
  const mkVer = (name, ageMs, bytes) => {
    const dir = path.join(rootDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(bytes, 2));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
  };
  mkVer('1.21.1', 40 * 24 * 60 * 60 * 1000, 100);
  mkVer('1.21.4', 40 * 24 * 60 * 60 * 1000, 100);
  mkVer('26.1', 1 * 24 * 60 * 60 * 1000, 100);

  let r = pruneVanillaRendersDir(rootDir, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxTotalBytes: 10 * 1024, protectVersions: ['1.21.1'] });
  check('过期版本被清理', r.removed.some(x => x.name === '1.21.4' && x.reason === 'age'), JSON.stringify(r.removed));
  check('受保护版本保留', fs.existsSync(path.join(rootDir, '1.21.1')), JSON.stringify(r.removed));

  const root2 = fs.mkdtempSync(path.join(tmp, 'vr2-'));
  mkVer2(root2, '1.21.1', 3 * 24 * 60 * 60 * 1000, 400);
  mkVer2(root2, '1.21.4', 2 * 24 * 60 * 60 * 1000, 400);
  mkVer2(root2, '26.1', 1 * 24 * 60 * 60 * 1000, 400);
  const r2 = pruneVanillaRendersDir(root2, { maxAgeMs: 60 * 24 * 60 * 60 * 1000, maxTotalBytes: 900, protectVersions: [] });
  check('vanilla-renders maxTotalBytes 生效', r2.removed.some(x => x.reason === 'maxTotalBytes'), JSON.stringify(r2.removed));
  check('vanilla-renders 保留最新', fs.existsSync(path.join(root2, '26.1')), fs.readdirSync(root2).join(','));
}

function mkVer2(rootDir, name, ageMs, bytes) {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(bytes, 2));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t);
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
