// 回归冒烟测试：验证 P0/P1 渲染与索引修复
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PNG } from 'pngjs';
import zlib from 'zlib';
import { renderModel3DToPng, getRenderStats } from '../lib/render3d.js';
import { buildAssetIndex, resolveItemRender, resolveFullModel, expandTag } from '../lib/assets.js';
import { readZipEntries, getJson } from '../lib/zip.js';
import { collectRecipes } from '../lib/recipes.js';
import { analyzeModJar } from '../lib/analyzer.js';
import { buildNamespaceRegistry, classifyId } from '../lib/namespaces.js';
import { SUPPORTED_VERSIONS, LATEST_VERSION, DEFAULT_VERSION, normalizeMcVersion } from '../lib/versions.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-smoke-'));
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function buf(obj) { return { getData: () => Buffer.from(JSON.stringify(obj)) }; }
function countVisible(png) {
  if (!png) return 0;
  let n = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 10) n++;
  return n;
}
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const localPart = Buffer.concat([local, packed]);
    locals.push(localPart);

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
    offset += localPart.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
function makeFaceTexture(name, rgb) {
  const tex = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < tex.data.length; i += 4) {
    tex.data[i] = rgb[0]; tex.data[i + 1] = rgb[1]; tex.data[i + 2] = rgb[2]; tex.data[i + 3] = 255;
  }
  const p = path.join(tmp, name);
  fs.writeFileSync(p, PNG.sync.write(tex));
  return p;
}
function makeTexture() {
  const tex = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < tex.data.length; i += 4) {
    tex.data[i] = 200; tex.data[i + 1] = 150; tex.data[i + 2] = 100; tex.data[i + 3] = 255;
  }
  const p = path.join(tmp, 'tex.png');
  fs.writeFileSync(p, PNG.sync.write(tex));
  return p;
}

const texPath = makeTexture();
const texMap = { 'block/stone': texPath, 'minecraft:block/stone': texPath, 'stone': texPath };
const faces = {};
for (const f of ['up', 'down', 'north', 'south', 'east', 'west']) faces[f] = { texture: '#all', uv: [0, 0, 16, 16] };

console.log('\n[1] 渲染：等距快路 (isSimpleCube)');
const simple = { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }], textures: { all: 'block/stone' } };
const rIso = renderModel3DToPng(simple, texMap, 64);
check('iso cube 渲染出可见像素', countVisible(rIso) > 8, `visible=${countVisible(rIso)}`);

console.log('\n[2] 渲染：通用光栅器 (带 element rotation 绕过快路)');
const rotated = {
  elements: [{ from: [0, 0, 0], to: [16, 16, 16], rotation: { axis: 'y', angle: 0, origin: [8, 8, 8] }, faces }],
  textures: { all: 'block/stone' },
};
const rGen = renderModel3DToPng(rotated, texMap, 64);
check('通用光栅器渲染出可见像素', countVisible(rGen) > 8, `visible=${countVisible(rGen)}`);

console.log('\n[3] 索引：vanilla blockstates 收集');
const modEntries = new Map([['assets/testmod/blockstates/foo.json', buf({ variants: {} })]]);
const vanilla = {
  entries: new Map([
    ['assets/minecraft/blockstates/stone.json', buf({ variants: {} })],
    ['assets/minecraft/models/item/stone.json', buf({ parent:'block/cube_all', textures:{} })],
    ['assets/minecraft/models/block/cube_all.json', buf({ textures: { all: 'block/stone' }, elements: [{ from: [0,0,0], to: [16,16,16], faces }] })],
  ]),
  langs: {},
};
const idx = buildAssetIndex(modEntries, vanilla);
check('收集 mod blockstate', idx.blockstates.has('testmod:foo'), [...idx.blockstates].join(','));
check('收集 vanilla blockstate', idx.blockstates.has('minecraft:stone'), [...idx.blockstates].join(','));

console.log('\n[4] 模型链：parent 不带 block/ 前缀的兜底');
const itemEntries = new Map([['assets/testmod/models/item/cube_item.json', buf({ parent: 'cube_all', textures: {} })]]);
const r = resolveItemRender('testmod:cube_item', idx, itemEntries, vanilla, new Map());
check('cube_item 解析为 3D', r.mode === '3d', `mode=${r.mode}`);

console.log('\n[4a] blockstate variants 指向不同名 model');
const bsEntries = new Map([
  ['assets/testmod/models/item/weird_block.json', buf({ parent:'item/generated', textures:{ layer0:'block/weird' } })],
  ['assets/testmod/blockstates/weird_block.json', buf({ variants:{ '':{ model:'testmod:block/actual_shape' } } })],
  ['assets/testmod/models/block/actual_shape.json', buf({ textures:{ all:'block/weird' }, elements:[{ from:[0,0,0], to:[16,16,16], faces }] })],
]);
const bsVanilla = { entries: bsEntries, langs:{} };
const bsIdx = buildAssetIndex(bsEntries, bsVanilla);
const br = resolveItemRender('testmod:weird_block', bsIdx, bsEntries, bsVanilla, new Map());
check('从 blockstate 找到不同名的 3D model', br.mode === '3d', `mode=${br.mode}`);

console.log('\n[4c] 内置父模型兜底（不依赖 vanilla jar）');
const builtinEntries = new Map([
  ['assets/testmod/models/item/builtin_parent.json', buf({ parent:'minecraft:block/cube_all', textures:{ all:'block/stone' } })],
]);
const builtinVanilla = { entries: new Map(), langs: {} };
const builtinIdx = buildAssetIndex(builtinEntries, builtinVanilla);
const builtinModel = resolveFullModel('testmod:builtin_parent', builtinIdx, builtinEntries, builtinVanilla, new Map());
const builtinRender = resolveItemRender('testmod:builtin_parent', builtinIdx, builtinEntries, builtinVanilla, new Map());
check('cube_all 缺文件时用内置 elements', builtinModel?.elements?.length === 1, `elements=${builtinModel?.elements?.length}`);
check('内置父模型仍解析为 3D', builtinRender.mode === '3d', `mode=${builtinRender.mode}`);

console.log('\n[4b] 半透明方块退 2D');
const glassFaces = Object.fromEntries(['up','down','north','south','east','west'].map(f=>[f,{ texture:'#all', uv:[0,0,16,16] }]));
const glassEntries = new Map([
  ['assets/minecraft/models/item/glass.json', buf({ parent:'item/generated', textures:{ layer0:'block/glass' } })],
  ['assets/minecraft/blockstates/glass.json', buf({ variants:{} })],
  ['assets/minecraft/models/block/glass.json', buf({ textures:{ all:'block/glass' }, elements:[{ from:[0,0,0], to:[16,16,16], faces:glassFaces }] })],
]);
const glassVanilla = { entries: glassEntries, langs:{} };
const glassIdx = buildAssetIndex(new Map(), glassVanilla);
const gr = resolveItemRender('minecraft:glass', glassIdx, new Map(), glassVanilla, new Map());
check('半透明玻璃判成 2D', gr.mode === '2d', `mode=${gr.mode}`);
const sr = resolveItemRender('minecraft:stone', idx, new Map(), vanilla, new Map());
check('实心方块仍判 3D', sr.mode === '3d', `mode=${sr.mode}`);

console.log('\n[5] tintindex：灰白纹理被 colormap 染色');
const tintedFaces = {};
for (const f of ['up','down','north','south','east','west']) tintedFaces[f] = { texture: '#all', uv: [0,0,16,16], tintindex: 0 };
const tinted = {
  elements: [{ from:[0,0,0], to:[16,16,16], rotation:{ axis:'y', angle:0, origin:[8,8,8] }, faces: tintedFaces }],
  textures: { all:'block/stone' },
  _tintColors: { 0: [0,255,0] },
};
const rTint = renderModel3DToPng(tinted, texMap, 64);
let rr=0, gg=0, bb=0, np=0;
if (rTint) for (let i=0;i<rTint.data.length;i+=4) if (rTint.data[i+3]>10) { rr+=rTint.data[i]; gg+=rTint.data[i+1]; bb+=rTint.data[i+2]; np++; }
check('tintindex 把灰纹理染绿', np>8 && gg>rr*1.5 && gg>bb*1.5,
  `avg=(${(rr/np).toFixed(0)},${(gg/np).toFixed(0)},${(bb/np).toFixed(0)})`);

console.log('\n[6] uvlock：旋转 90° 且有 uvlock 时仍能渲染');
const uvlocked = {
  elements: [{ from:[0,0,0], to:[16,16,16], rotation:{ axis:'y', angle:90, origin:[8,8,8] },
    faces: Object.fromEntries(['up','down','north','south','east','west'].map(f=>[f,{ texture:'#all', uv:[0,0,16,16], uvlock:true }])) }],
  textures: { all:'block/stone' },
};
const rUv = renderModel3DToPng(uvlocked, texMap, 64);
check('uvlock 模型渲染出可见像素', countVisible(rUv) > 8, `visible=${countVisible(rUv)}`);

console.log('\n[7] 标签 fallback：JSON 配置 + 原版等价开关默认关');
const fallbackJson = JSON.parse(fs.readFileSync(new URL('../config/tag-fallbacks.json', import.meta.url), 'utf8'));
check('fallback 表已抽成 JSON', Array.isArray(fallbackJson['c:ingots/iron']), `keys=${Object.keys(fallbackJson).length}`);
const tagEntries = new Map([
  ['data/c/tags/item/ingots/iron.json', buf({ values: ['testmod:custom_iron_ingot'] })],
  ['data/c/tags/item/custom_gems.json', buf({ values: ['testmod:custom_gem'] })],
]);
const tagVanilla = {
  entries: new Map([
    ['assets/minecraft/models/item/iron_ingot.json', buf({ parent: 'item/generated' })],
    ['assets/minecraft/models/item/custom_gem.json', buf({ parent: 'item/generated' })],
  ]),
  langs: {},
};
const strictIdx = buildAssetIndex(tagEntries, tagVanilla);
const looseIdx = buildAssetIndex(tagEntries, tagVanilla, { includeVanillaEquivalents: true });
check('默认严格按 mod 标签展开', JSON.stringify(expandTag('c:ingots/iron', strictIdx)) === JSON.stringify(['testmod:custom_iron_ingot']),
  `ids=${expandTag('c:ingots/iron', strictIdx).join(',')}`);
check('默认不强行补同名原版', JSON.stringify(expandTag('c:custom_gems', strictIdx)) === JSON.stringify(['testmod:custom_gem']),
  `ids=${expandTag('c:custom_gems', strictIdx).join(',')}`);
check('开启后补原版等价物', expandTag('c:ingots/iron', looseIdx)[0] === 'minecraft:iron_ingot',
  `ids=${expandTag('c:ingots/iron', looseIdx).join(',')}`);
check('开启后通用 c: 标签也补原版', expandTag('c:custom_gems', looseIdx).includes('minecraft:custom_gem'),
  `ids=${expandTag('c:custom_gems', looseIdx).join(',')}`);

console.log('\n[8] zip：中央目录索引 + 按需解压');
const zipPath = path.join(tmp, 'stream.zip');
fs.writeFileSync(zipPath, makeZip([
  ['data/testmod/recipe/a.json', Buffer.from('{"ok":true,"name":"a"}')],
  ['assets/testmod/textures/item/a.png', Buffer.from([137,80,78,71])],
]));
const zipIndex = readZipEntries(zipPath);
check('zip 只索引文件条目', zipIndex.entries.size === 2, `entries=${zipIndex.entries.size}`);
check('getData 按需解压 deflate', getJson(zipIndex.entries, 'data/testmod/recipe/a.json')?.name === 'a');
check('纹理字节按需读取', zipIndex.entries.get('assets/testmod/textures/item/a.png').getData()[0] === 137);

console.log('\n[9] 静默兜底可见性计数');
const beforeInvisible = getRenderStats().invisibleFallbacks;
renderModel3DToPng(simple, texMap, 1);
check('visible<=8 被计入统计', getRenderStats().invisibleFallbacks > beforeInvisible,
  `${beforeInvisible} -> ${getRenderStats().invisibleFallbacks}`);

console.log('\n[10] 视角：通用光栅器应看到上/前/左');
const faceColors = {
  up:[255,0,0], down:[0,255,0], south:[0,0,255],
  north:[255,255,0], east:[255,0,255], west:[0,255,255],
};
const faceRefs = {}, faceTexMap = {}, coloredFaces = {};
for (const [f, rgb] of Object.entries(faceColors)) {
  faceRefs[f] = `face_${f}`;
  faceTexMap[faceRefs[f]] = makeFaceTexture(`${faceRefs[f]}.png`, rgb);
  coloredFaces[f] = { texture: `#${f}`, uv:[0,0,16,16] };
}
const viewPng = renderModel3DToPng({
  elements: [{ from:[0,0,0], to:[16,16,16], rotation:{axis:'y',angle:0,origin:[8,8,8]}, faces:coloredFaces }],
  textures: faceRefs,
}, faceTexMap, 64);
const faceCounts = {};
if (viewPng) {
  for (let i = 0; i < viewPng.data.length; i += 4) {
    const r = viewPng.data[i], g = viewPng.data[i + 1], b = viewPng.data[i + 2];
    if (viewPng.data[i + 3] <= 10) continue;
    let f = null;
    if (r > 90 && g < 70 && b < 70) f = 'up';
    else if (g > 90 && r < 70 && b < 70) f = 'down';
    else if (b > 90 && r < 70 && g < 70) f = 'south';
    else if (r > 90 && g > 90 && b < 70) f = 'north';
    else if (r > 90 && b > 90 && g < 70) f = 'east';
    else if (g > 90 && b > 90 && r < 70) f = 'west';
    if (f) faceCounts[f] = (faceCounts[f] || 0) + 1;
  }
}
check('可见上面（红）', (faceCounts.up || 0) > 50, `up=${faceCounts.up || 0}`);
check('可见前面 south（蓝）', (faceCounts.south || 0) > 50, `south=${faceCounts.south || 0}`);
check('可见左面 west（青）', (faceCounts.west || 0) > 50, `west=${faceCounts.west || 0}`);
check('不可见底面（绿）', !faceCounts.down, `down=${faceCounts.down || 0}`);
check('不可见后面 north（黄）', !faceCounts.north, `north=${faceCounts.north || 0}`);
check('不可见右面 east（品红）', !faceCounts.east, `east=${faceCounts.east || 0}`);

console.log('\n[11] 多版本：正式版列表与版本参数校验');
check('版本列表含起点 1.21.1 与最新 26.3', SUPPORTED_VERSIONS.includes('1.21.1') && LATEST_VERSION === '26.3',
  `count=${SUPPORTED_VERSIONS.length}, latest=${LATEST_VERSION}`);
check('默认版本合法', normalizeMcVersion(DEFAULT_VERSION) === DEFAULT_VERSION, `default=${DEFAULT_VERSION}`);
check('接受 1.21.x 与 26.x', normalizeMcVersion('1.21.4') === '1.21.4' && normalizeMcVersion('26.3') === '26.3');
check('空值回退默认', normalizeMcVersion('') === DEFAULT_VERSION);
let badRejected = false;
try { normalizeMcVersion('../../etc/passwd'); } catch (e) { badRejected = e.status === 400; }
check('路径穿越被拒绝', badRejected);

console.log('\n[12] 审计仪表：解析统计与可疑标记');
{
  const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const files = [
    ['data/testmod/recipe/good.json', j({
      type: 'minecraft:crafting_shaped',
      pattern: ['XX'], key: { X: { item: 'minecraft:iron_ingot' } },
      result: { id: 'minecraft:iron_block' },
    })],
    ['data/testmod/recipe/zero_input.json', j({
      type: 'testmod:opaque', result: { id: 'testmod:thing' },
    })],
    ['data/testmod/recipe/unknown_ing.json', j({
      type: 'testmod:mystery', ingredient: { mystery: 'foo' }, result: { id: 'testmod:bar' },
    })],
    ['data/testmod/recipe/fake_advancement.json', j({
      criteria: { root: { trigger: 'minecraft:tick' } },
    })],
    ['data/testmod/recipe/broken.json', Buffer.from('not json', 'utf8')],
  ];
  const zip2 = path.join(tmp, 'audit.zip');
  fs.writeFileSync(zip2, makeZip(files));
  const stats = {};
  const parsed = collectRecipes(readZipEntries(zip2).entries, stats);
  check('扫描数 = 配方路径下全部 JSON', stats.recipeFilesScanned === 5, `scanned=${stats.recipeFilesScanned}`);
  check('有效 JSON 被解析', stats.recipesParsed === 3, `parsed=${stats.recipesParsed}`);
  check('坏 JSON 被计数', stats.invalidJsonFiles === 1, `invalid=${stats.invalidJsonFiles}`);
  check('伪造成就被跳过并计数', stats.advancementFilesSkipped === 1, `skipped=${stats.advancementFilesSkipped}`);
  check('未知类型被计数', stats.unknownTypeRecipes === 1, `unknownType=${stats.unknownTypeRecipes}`);
  check('collectRecipes 返回 3 条', parsed.length === 3, `returned=${parsed.length}`);

  const outDir = path.join(tmp, 'audit-out');
  fs.mkdirSync(outDir, { recursive: true });
  const analysis = await analyzeModJar(zip2, outDir, { mcVersion: '1.21.1' });
  const cov = analysis.summary.coverage;
  check('summary.coverage 存在', !!cov);
  check('coverage 含扫描/解析/可疑数', cov.recipeFilesScanned === 5 && cov.recipesParsed === 3 && cov.suspiciousRecipes === 2,
    `scan=${cov.recipeFilesScanned} parsed=${cov.recipesParsed} suspicious=${cov.suspiciousRecipes}`);
  check('parseRate 分母剔除 advancement 文件', cov.parseRate === 0.75, `parseRate=${cov.parseRate}`);
  const byFile = Object.fromEntries(analysis.recipeEntries.map(r => [path.basename(r.sourceFile), r]));
  check('正常配方不可疑', byFile['good.json']?.parseQuality?.suspicious === false);
  check('零输入被标记', byFile['zero_input.json']?.parseQuality?.reasons?.includes('zero-input') === true);
  check('未知类型被标记', byFile['zero_input.json']?.parseQuality?.reasons?.includes('unknown-recipe-type') === true);
  check('未知材料被标记', byFile['unknown_ing.json']?.parseQuality?.reasons?.includes('unknown-ingredient') === true);
  check('可疑原因汇总含 zero-input', (cov.suspiciousReasons?.['zero-input'] || 0) === 1, JSON.stringify(cov.suspiciousReasons));
  check('每条分析记录带 parseQuality', analysis.recipeEntries.every(r => r.parseQuality && typeof r.parseQuality.suspicious === 'boolean'));
}

console.log('\n[13] 1.21.4 items 映射：直取 / 复杂结构退 2D / 独立计数');
{
  const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const files = [
    ['assets/testmod/items/normal_block.json',
      j({ model: { type: 'minecraft:model', model: 'testmod:block/normal_block' } })],
    ['assets/testmod/models/block/normal_block.json',
      j({ parent: 'minecraft:block/cube_all', textures: { all: 'testmod:block/normal_block' } })],
    ['assets/testmod/items/conditional.json',
      j({ model: { type: 'minecraft:condition', property: 'minecraft:custom_model_data',
        if_true: { type: 'minecraft:model', model: 'testmod:block/normal_block' },
        if_false: { type: 'minecraft:model', model: 'testmod:block/normal_block' } } })],
    ['assets/testmod/models/item/conditional.json',
      j({ parent: 'minecraft:item/generated', textures: { layer0: 'testmod:item/conditional' } })],
    ['assets/testmod/models/item/legacy_item.json',
      j({ parent: 'minecraft:item/generated', textures: { layer0: 'testmod:item/legacy' } })],
  ];
  const zip3 = path.join(tmp, 'items-map.zip');
  fs.writeFileSync(zip3, makeZip(files));
  const ent3 = readZipEntries(zip3).entries;
  const idx3 = buildAssetIndex(ent3, null);
  check('items 映射索引建立', idx3.itemModelMappings.has('testmod:normal_block') && idx3.itemModelMappings.has('testmod:conditional'));

  const before = getRenderStats();
  const r1 = resolveItemRender('testmod:normal_block', idx3, ent3, null, new Map());
  const r2 = resolveItemRender('testmod:conditional', idx3, ent3, null, new Map());
  const r3 = resolveItemRender('testmod:legacy_item', idx3, ent3, null, new Map());
  const after = getRenderStats();
  check('minecraft:model 直取走 3D', r1.mode === '3d', r1.mode);
  check('condition 复杂结构退 2D（不猜分支）', r2.mode === '2d', r2.mode);
  check('无 items 映射走旧链路', r3.mode === '2d', r3.mode);
  check('hit 计数 +1', after.itemModelMappingHit - before.itemModelMappingHit === 1);
  check('fallback2D 计数 +1', after.itemModelMappingFallback2D - before.itemModelMappingFallback2D === 1);
  check('missing 计数 +1', after.itemModelMappingMissing - before.itemModelMappingMissing === 1);
  check('解析质量口径未被渲染降级污染', after.suspiciousRecipes === undefined && after.parseQuality === undefined);
}

console.log('\n[14] 命名空间 → 模组表：多 jar 合并 / 元数据 / 外部依赖不算解析失败');
{
  const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const jarA = path.join(tmp, 'ns-a.jar');
  fs.writeFileSync(jarA, makeZip([
    ['fabric.mod.json', j({ id: 'moda', name: 'Mod A' })],
    ['assets/moda/models/item/part.json', j({ parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:iron_ingot' } })],
    ['data/moda/recipe/a.json', j({
      type: 'minecraft:crafting_shaped', pattern: ['X'],
      key: { X: { item: 'minecraft:iron_ingot' } },
      result: { id: 'moda:part' },
    })],
  ]));
  const jarB = path.join(tmp, 'ns-b.jar');
  fs.writeFileSync(jarB, makeZip([
    ['META-INF/neoforge.mods.toml', Buffer.from('modLoader="javafml"\n[[mods]]\nmodId="modb"\ndisplayName="Mod B"\nversion="1"\n', 'utf8')],
    ['data/modb/recipe/b.json', j({
      type: 'minecraft:crafting_shaped', pattern: ['X'],
      key: { X: { item: 'externalmod:widget' } },
      result: { id: 'modb:thing' },
    })],
  ]));
  const jarC = path.join(tmp, 'ns-c.jar');
  fs.writeFileSync(jarC, makeZip([
    ['mcmod.info', j([{ modid: 'modc', name: 'Mod C' }])],
    ['assets/modc/models/item/x.json', j({ parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:stone' } })],
  ]));

  const reg = buildNamespaceRegistry([
    { jarPath: jarA, entries: readZipEntries(jarA).entries },
    { jarPath: jarB, entries: readZipEntries(jarB).entries },
    { jarPath: jarC, entries: readZipEntries(jarC).entries },
  ]);
  check('Fabric fabric.mod.json → 模组名', reg.get('moda')?.modName === 'Mod A');
  check('NeoForge mods.toml → 模组名', reg.get('modb')?.modName === 'Mod B');
  check('老 Forge mcmod.info → 模组名', reg.get('modc')?.modName === 'Mod C');
  check('minecraft 不进注册表（原版单独归类）', !reg.has('minecraft'));
  check('minecraft id → vanilla', classifyId('minecraft:stone', reg).kind === 'vanilla');
  check('已上传 mod id → internal', classifyId('moda:part', reg).kind === 'internal');
  check('未上传 mod id → external', classifyId('externalmod:widget', reg).kind === 'external');
  check('tag id 也按命名空间归类', classifyId('#moda:parts', reg).kind === 'internal');

  const outDir = path.join(tmp, 'ns-analysis');
  fs.mkdirSync(outDir, { recursive: true });
  const result = await analyzeModJar([jarA, jarB, jarC], outDir, { mcVersion: '1.21.1' });
  const deps = result.summary.dependencies;
  check('多 jar 合并后 modFiles 列全量', result.summary.modFiles?.length === 3);
  check('多 jar 合并后配方来自两个 jar', result.summary.recipeCount === 2, String(result.summary.recipeCount));
  check('summary.dependencies 存在', !!deps);
  check('模组名来自元数据精确匹配（非推断）', deps.registry.find(n => n.namespace === 'moda')?.specific === true);
  check('外部依赖命名空间被识别', deps.externalNamespaces.some(n => n.namespace === 'externalmod'),
    JSON.stringify(deps.externalNamespaces.map(n => n.namespace)));
  check('外部依赖不算解析失败', result.summary.coverage.suspiciousRecipes === 0,
    JSON.stringify(result.summary.coverage.suspiciousReasons));
  check('外部依赖不进 parseQuality.reasons', result.recipeEntries.every(r => !(r.parseQuality?.reasons || []).includes('external-dependency')));
  check('外部依赖 id 单独归档', result.recipeEntries.some(r => r.dependencyRefs?.external.includes('externalmod:widget')));
  check('内部引用 id 单独归档', result.recipeEntries.some(r => r.dependencyRefs?.internal.some(x => x.startsWith('moda:') || x.startsWith('modb:'))));
  check('原版引用 id 单独归档', result.recipeEntries.some(r => r.dependencyRefs?.vanilla.includes('minecraft:iron_ingot')));
}

console.log('\n[15] 烹饪站点变体：标记为获取方式差异，站点列表不虚增');
{
  const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const zip4 = path.join(tmp, 'cook-variants.zip');
  fs.writeFileSync(zip4, makeZip([
    ['data/testmod/recipe/ingot_smelting.json', j({
      type: 'minecraft:smelting', ingredient: { item: 'minecraft:iron_ore' },
      result: 'minecraft:iron_ingot',
    })],
    ['data/testmod/recipe/ingot_blasting.json', j({
      type: 'minecraft:blasting', ingredient: { item: 'minecraft:iron_ore' },
      result: 'minecraft:iron_ingot',
    })],
  ]));
  const outDir = path.join(tmp, 'cook-out');
  fs.mkdirSync(outDir, { recursive: true });
  const analysis = await analyzeModJar(zip4, outDir, { mcVersion: '1.21.1' });
  const rec = analysis.collapsedRecipes.find(r => r.result?.id === 'minecraft:iron_ingot');
  check('熔炉/高炉配方被合并为一条', !!rec && rec.variantCount === 2, String(rec?.variantCount));
  check('变体类型标记为站点差异', rec?.variantKind === 'station', String(rec?.variantKind));
  check('站点列表只含实际两个炉子', rec?.stations?.length === 2
    && rec.stations.includes('minecraft:furnace')
    && rec.stations.includes('minecraft:blast_furnace')
    && !rec.stations.includes('minecraft:smoker'), JSON.stringify(rec?.stations));
  check('站点图标数与站点列表一致', rec?.stationItems?.length === rec?.stations?.length);
  check('未合并的单条配方不带变体类型标记', analysis.recipeEntries.every(r => r.variantKind === undefined));
}

console.log('\n[16] zip 读取错误分类 + 累计解压预算');
{
  const budgetZip = path.join(tmp, 'budget.zip');
  fs.writeFileSync(budgetZip, makeZip([
    ['a.txt', Buffer.alloc(200000, 97)],
    ['b.txt', Buffer.alloc(200000, 98)],
  ]));
  const budgetIndex = readZipEntries(budgetZip, { maxTotalInflated: 250000 });
  let budgetErr = null;
  try { budgetIndex.entries.get('a.txt').getData(); budgetIndex.entries.get('b.txt').getData(); }
  catch (e) { budgetErr = e; }
  check('累计解压预算生效', /budget exceeded/i.test(String(budgetErr?.message || budgetErr)), budgetErr?.message);

  const badZip = path.join(tmp, 'bad-method.zip');
  const goodRecipe = Buffer.from(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients:[{item:'minecraft:stone'}], result:{id:'m:ok',count:1} }));
  const badRecipe = Buffer.from(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients:[{item:'minecraft:dirt'}], result:{id:'m:bad',count:1} }));
  const files2 = [['data/m/recipe/good.json', goodRecipe], ['data/m/recipe/bad.json', badRecipe]];
  const locals=[], centrals=[]; let off=0;
  for (const [name,data] of files2) {
    const nameBuf=Buffer.from(name,'utf8');
    const isBad = name.endsWith('bad.json');
    const method = isBad ? 99 : 8;
    const packed = isBad ? data : zlib.deflateRawSync(data);
    const local=Buffer.alloc(30+nameBuf.length);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(method,8);
    local.writeUInt32LE(packed.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(nameBuf.length,26);
    nameBuf.copy(local,30); const part=Buffer.concat([local,packed]); locals.push(part);
    const central=Buffer.alloc(46+nameBuf.length);
    central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(method,10);
    central.writeUInt32LE(packed.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(nameBuf.length,28); central.writeUInt32LE(off,42);
    nameBuf.copy(central,46); centrals.push(central); off+=part.length;
  }
  const cd=Buffer.concat(centrals); const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(files2.length,8); eocd.writeUInt16LE(files2.length,10); eocd.writeUInt32LE(cd.length,12); eocd.writeUInt32LE(off,16);
  fs.writeFileSync(badZip, Buffer.concat([...locals,cd,eocd]));
  const outDir = path.join(tmp, 'readerr-out');
  fs.mkdirSync(outDir, { recursive: true });
  const res = await analyzeModJar(badZip, outDir, { mcVersion: '1.21.1' });
  check('读取错误不计入 invalidJson', (res.summary.coverage?.invalidJsonFiles || 0) === 0, JSON.stringify(res.summary.coverage));
  check('读取错误单独计数', (res.summary.coverage?.readErrors || 0) === 1, JSON.stringify(res.summary.coverage?.readErrorCodes));
  check('读取错误分类正确', res.summary.coverage?.readErrorCodes?.['unsupported-compression'] === 1, JSON.stringify(res.summary.coverage?.readErrorCodes));
  check('正常配方仍解析', res.summary.recipeCount === 1, String(res.summary.recipeCount));
}

console.log('\n[17] 多 jar 冲突报告');
{
  const j = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const j1 = path.join(tmp, 'conf-a.jar');
  const j2 = path.join(tmp, 'conf-b.jar');
  fs.writeFileSync(j1, makeZip([['data/m/recipe/same.json', j({type:'minecraft:crafting_shapeless',ingredients:[{item:'minecraft:stone'}],result:{id:'m:from_a',count:1}})]]));
  fs.writeFileSync(j2, makeZip([['data/m/recipe/same.json', j({type:'minecraft:crafting_shapeless',ingredients:[{item:'minecraft:dirt'}],result:{id:'m:from_b',count:1}})]]));
  const outDir = path.join(tmp, 'conf-out');
  fs.mkdirSync(outDir, { recursive: true });
  const res = await analyzeModJar([j1,j2], outDir, { mcVersion: '1.21.1' });
  check('conflictCount=1', res.summary.conflictCount === 1, String(res.summary.conflictCount));
  check('winner 为先上传 jar', res.summary.conflicts?.[0]?.winner === 'conf-a.jar', JSON.stringify(res.summary.conflicts?.[0]));
  check('先上传者结果生效', res.recipeEntries?.[0]?.result?.id === 'm:from_a', res.recipeEntries?.[0]?.result?.id);
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
