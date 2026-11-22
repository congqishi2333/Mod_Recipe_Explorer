import fs from 'fs';
import { PNG } from 'pngjs';

function matMul(a,b){ const o=new Float64Array(16); for(let r=0;r<4;r++) for(let c=0;c<4;c++) o[r*4+c]=a[r*4]*b[c]+a[r*4+1]*b[4+c]+a[r*4+2]*b[8+c]+a[r*4+3]*b[12+c]; return o; }
function matIdentity(){ const m=new Float64Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }
function matTranslate(tx,ty,tz){ const m=matIdentity(); m[12]=tx;m[13]=ty;m[14]=tz; return m; }
function matScale(sx,sy,sz){ const m=new Float64Array(16); m[0]=sx;m[5]=sy;m[10]=sz;m[15]=1; return m; }
function matRotateX(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[5]=c;m[6]=s;m[9]=-s;m[10]=c; return m; }
function matRotateY(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[0]=c;m[2]=-s;m[8]=s;m[10]=c; return m; }
function matRotateZ(d){ const r=d*Math.PI/180,c=Math.cos(r),s=Math.sin(r),m=matIdentity(); m[0]=c;m[1]=s;m[4]=-s;m[5]=c; return m; }
function vtx(m,v){ const x=v[0],y=v[1],z=v[2]; return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]]; }

const FACE_DIRS = {
  north:{n:[0,0,-1],verts:(f,t)=>[[t[0],t[1],f[2]],[f[0],t[1],f[2]],[f[0],f[1],f[2]],[t[0],f[1],f[2]]]},
  south:{n:[0,0,1], verts:(f,t)=>[[f[0],t[1],t[2]],[t[0],t[1],t[2]],[t[0],f[1],t[2]],[f[0],f[1],t[2]]]},
  west: {n:[-1,0,0],verts:(f,t)=>[[f[0],t[1],f[2]],[f[0],t[1],t[2]],[f[0],f[1],t[2]],[f[0],f[1],f[2]]]},
  east: {n:[1,0,0], verts:(f,t)=>[[t[0],t[1],t[2]],[t[0],t[1],f[2]],[t[0],f[1],f[2]],[t[0],f[1],t[2]]]},
  up:   {n:[0,1,0], verts:(f,t)=>[[f[0],t[1],f[2]],[t[0],t[1],f[2]],[t[0],t[1],t[2]],[f[0],t[1],t[2]]]},
  down: {n:[0,-1,0],verts:(f,t)=>[[f[0],f[1],t[2]],[t[0],f[1],t[2]],[t[0],f[1],f[2]],[f[0],f[1],f[2]]]},
};
const FACE_SHADE = {up:1.0, down:0.5, north:0.8, south:0.8, east:0.6, west:0.6};

function defaultUV(face, from, to) {
  switch(face) {
    case 'north': return [16-to[0], 16-to[1], 16-from[0], 16-from[1]];
    case 'south': return [from[0], 16-to[1], to[0], 16-from[1]];
    case 'west':  return [from[2], 16-to[1], to[2], 16-from[1]];
    case 'east':  return [16-to[2], 16-to[1], 16-from[2], 16-from[1]];
    case 'up':    return [from[0], from[2], to[0], to[2]];
    case 'down':  return [from[0], 16-to[2], to[0], 16-from[2]];
  }
  return [0,0,16,16];
}

function readPng(filePath, cache) {
  if (!filePath) return null;
  if (cache.has(filePath)) return cache.get(filePath);
  try {
    const data = fs.readFileSync(filePath);
    const png = PNG.sync.read(data);
    cache.set(filePath, png);
    return png;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}

function setPixel(img, x, y, r,g,b,a) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (img.width * y + x) << 2;
  const sa = a / 255;
  const da = img.data[i+3] / 255;
  const oa = sa + da * (1-sa);
  if (oa <= 0) { img.data[i]=img.data[i+1]=img.data[i+2]=img.data[i+3]=0; return; }
  img.data[i]   = Math.round((r*sa + img.data[i]*da*(1-sa)) / oa);
  img.data[i+1] = Math.round((g*sa + img.data[i+1]*da*(1-sa)) / oa);
  img.data[i+2] = Math.round((b*sa + img.data[i+2]*da*(1-sa)) / oa);
  img.data[i+3] = Math.round(oa * 255);
}

function sampleTex(png, u, v) {
  const x = Math.min(png.width-1, Math.max(0, Math.floor(u)));
  const y = Math.min(png.height-1, Math.max(0, Math.floor(v)));
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i+1], png.data[i+2], png.data[i+3]];
}

function bary(p, a,b,c) {
  const v0x=b[0]-a[0], v0y=b[1]-a[1], v1x=c[0]-a[0], v1y=c[1]-a[1], v2x=p[0]-a[0], v2y=p[1]-a[1];
  const den = v0x*v1y - v1x*v0y;
  if (Math.abs(den) < 1e-8) return null;
  const v = (v2x*v1y - v1x*v2y) / den;
  const w = (v0x*v2y - v2x*v0y) / den;
  const u = 1-v-w;
  return [u,v,w];
}

function drawTri(img, pts, uvs, texPng, shade, tw, th) {
  const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(img.width-1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(img.height-1, Math.ceil(Math.max(...ys)));
  for (let y=minY; y<=maxY; y++) {
    for (let x=minX; x<=maxX; x++) {
      const bc = bary([x+0.5,y+0.5], pts[0], pts[1], pts[2]);
      if (!bc) continue;
      const [u3,v3,w3] = bc;
      if (u3 < -0.001 || v3 < -0.001 || w3 < -0.001) continue;
      let r,g,b,a;
      if (texPng) {
        const uu = u3*uvs[0][0] + v3*uvs[1][0] + w3*uvs[2][0];
        const vv = u3*uvs[0][1] + v3*uvs[1][1] + w3*uvs[2][1];
        const sx = uu / tw * texPng.width;
        const sy = vv / th * texPng.height;
        [r,g,b,a] = sampleTex(texPng, sx, sy);
      } else { r=g=b=160; a=255; }
      if (a <= 0) continue;
      r = Math.round(r*shade); g = Math.round(g*shade); b = Math.round(b*shade);
      setPixel(img, x, y, r,g,b,a);
    }
  }
}

// Isometric renderer for simple full cubes (fast, crisp, vanilla-like)
function isSimpleCube(model3d) {
  const els = model3d?.elements || [];
  if (els.length !== 1) return false;
  const e = els[0];
  const f = e.from||[0,0,0], t = e.to||[16,16,16];
  return f[0]===0&&f[1]===0&&f[2]===0&&t[0]===16&&t[1]===16&&t[2]===16 && !e.rotation;
}

function renderSimpleCubeIso(model3d, texFileByRef, size=64, pngCache=new Map()) {
  const out = new PNG({ width: size, height: size, fill: true });
  for (let i=0;i<out.data.length;i++) out.data[i]=0;
  const textures = model3d.textures || {};
  function getPng(faceName) {
    const face = model3d.elements[0].faces?.[faceName];
    if (!face) return null;
    let r = face.texture, lastKey = null;
    for (let i=0; i<8 && typeof r === 'string' && r.startsWith('#'); i++) { lastKey=r.slice(1); r=textures[lastKey]; }
    const key = typeof r === 'string' ? r : lastKey;
    const fp = texFileByRef[key] || texFileByRef[r] || (lastKey ? texFileByRef[lastKey] : null);
    return fp ? readPng(fp, pngCache) : null;
  }
  // MC inventory-like isometric: top, left(west/north visible), right(east/south visible)
  // Use faces: up, west(or north), south(or east) depending on convention; we'll draw up, east, south for nice view
  const top = getPng('up') || getPng('north') || getPng('south') || getPng('east') || getPng('west') || getPng('down');
  const left = getPng('west') || getPng('north') || getPng('south');
  const right = getPng('south') || getPng('east') || getPng('north');
  if (!top && !left && !right) return null;

  const pad = Math.max(2, Math.round(size * 0.04));
  const availW = size - pad * 2;
  const availH = size - pad * 2;
  // Fit isometric cube: width=sqrt(3)*s, height=2*s
  const s = Math.min(availH / 2, availW / Math.sqrt(3));
  const K = Math.sqrt(3) / 2;
  // basis vectors in screen coords (y down)
  const ux = K*s, uy = 0.5*s;    // right-down edge
  const vx = -K*s, vy = 0.5*s;   // left-down edge
  const wx = 0, wy = s;          // vertical down edge
  const cx = size / 2;
  const cy = (size - 2*s) / 2;   // top vertex, centered vertically

  function drawFace(png, origin, ax, ay, bx, by, shade) {
    if (!png) return;
    // iterate output pixels in bounding box and inverse-map
    const corners = [origin, [origin[0]+ax,origin[1]+ay], [origin[0]+ax+bx,origin[1]+ay+by], [origin[0]+bx,origin[1]+by]];
    const xs=corners.map(p=>p[0]), ys=corners.map(p=>p[1]);
    const minX=Math.max(0,Math.floor(Math.min(...xs))), maxX=Math.min(size-1,Math.ceil(Math.max(...xs)));
    const minY=Math.max(0,Math.floor(Math.min(...ys))), maxY=Math.min(size-1,Math.ceil(Math.max(...ys)));
    const det = ax*by - ay*bx;
    if (Math.abs(det) < 1e-8) return;
    for (let py=minY; py<=maxY; py++) {
      for (let px=minX; px<=maxX; px++) {
        const dx = (px+0.5)-origin[0], dy = (py+0.5)-origin[1];
        const u = (dx*by - dy*bx) / det;
        const v = (ax*dy - ay*dx) / det;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const sx = u * png.width;
        const sy = v * png.height;
        let [r,g,b,a] = sampleTex(png, sx, sy);
        if (a <= 0) continue;
        r=Math.round(r*shade); g=Math.round(g*shade); b=Math.round(b*shade);
        setPixel(out, px, py, r,g,b,a);
      }
    }
  }

  // Top face: origin T, x->u, y->v
  drawFace(top, [cx,cy], ux,uy, vx,vy, 1.0);
  // Left face: origin T+v, x->u, y->w
  drawFace(left, [cx+vx,cy+vy], ux,uy, wx,wy, 0.82);
  // Right face: origin T+u, x->v, y->w
  drawFace(right, [cx+ux,cy+uy], vx,vy, wx,wy, 0.62);

  let visible=0;
  for (let i=3;i<out.data.length;i+=4) { if (out.data[i]>10) { visible++; if (visible>8) break; } }
  if (visible<=8) return null;
  return out;
}

export function renderModel3DToPng(model3d, texFileByRef, size=64, pngCache=new Map()) {
  if (isSimpleCube(model3d)) {
    const iso = renderSimpleCubeIso(model3d, texFileByRef, size, pngCache);
    if (iso) return iso;
  }
  // Fallback: general rasterizer
  const W=size, H=size;
  const out = new PNG({ width: W, height: H });
  for (let i=0;i<out.data.length;i+=4){ out.data[i]=0; out.data[i+1]=0; out.data[i+2]=0; out.data[i+3]=0; }

  const textures = model3d.textures || {};
  const elements = model3d.elements || [];
  if (!elements.length) return null;
  const texW=16, texH=16;
  const texImgs = {};
  for (const [k, filePath] of Object.entries(texFileByRef || {})) {
    const p = readPng(filePath, pngCache);
    if (p) texImgs[k] = p;
  }

  const s = W * 0.0625;
  let M = matIdentity();
  M = matMul(M, matTranslate(W/2, H/2, 0));
  M = matMul(M, matScale(s*0.9, -s*0.9, s*0.9));
  M = matMul(M, matRotateX(30));
  M = matMul(M, matRotateY(225));
  M = matMul(M, matTranslate(-8, -8, -8));

  const quads = [];
  for (const el of elements) {
    const from = el.from || [0,0,0], to = el.to || [16,16,16];
    let EM = matIdentity();
    if (el.rotation) {
      const o = el.rotation.origin || [8,8,8];
      EM = matMul(EM, matTranslate(o[0],o[1],o[2]));
      const ang = el.rotation.angle || 0;
      if (el.rotation.axis === 'x') EM = matMul(EM, matRotateX(ang));
      if (el.rotation.axis === 'y') EM = matMul(EM, matRotateY(ang));
      if (el.rotation.axis === 'z') EM = matMul(EM, matRotateZ(ang));
      EM = matMul(EM, matTranslate(-o[0],-o[1],-o[2]));
    }
    for (const [fname, fdef] of Object.entries(FACE_DIRS)) {
      const face = el.faces?.[fname];
      if (!face) continue;
      const verts = fdef.verts(from,to).map(v => vtx(M, vtx(EM, v)));
      const depth = (verts[0][2]+verts[1][2]+verts[2][2]+verts[3][2])/4;
      let png = null;
      let r = face.texture, lastKey = null;
      for (let i=0; i<8 && typeof r === 'string' && r.startsWith('#'); i++) { lastKey = r.slice(1); r = textures[lastKey]; }
      if (typeof r === 'string') png = texImgs[r] || texImgs[lastKey] || null;
      if (!png && lastKey) png = texImgs[lastKey] || null;
      if (!png) { for (const v of Object.values(textures)) { if (typeof v==='string' && texImgs[v]) { png = texImgs[v]; break; } } }
      const uv = face.uv || defaultUV(fname, from, to);
      quads.push({verts, depth, png, uv, shade: FACE_SHADE[fname]||1});
    }
  }
  quads.sort((a,b)=>a.depth-b.depth);
  for (const q of quads) {
    const [u1,v1,u2,v2] = q.uv;
    const uvs = [[u1,v1],[u2,v1],[u2,v2],[u1,v2]];
    drawTri(out, [q.verts[0],q.verts[1],q.verts[2]], [uvs[0],uvs[1],uvs[2]], q.png, q.shade, texW, texH);
    drawTri(out, [q.verts[0],q.verts[2],q.verts[3]], [uvs[0],uvs[2],uvs[3]], q.png, q.shade, texW, texH);
  }
  let visible=0;
  for (let i=3;i<out.data.length;i+=4) { if (out.data[i]>10) { visible++; if (visible>8) break; } }
  if (visible<=8) return null;
  return out;
}
