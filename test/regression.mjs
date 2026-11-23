import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { collectRecipes } = await import(pathToFileURL(path.join(root, 'lib/recipes.js')).href);
const { analyzeModJar } = await import(pathToFileURL(path.join(root, 'lib/analyzer.js')).href);

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

console.log(`\n结果: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
