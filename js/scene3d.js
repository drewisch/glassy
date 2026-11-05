// Glassy - WebGL2 diorama of the break: terrain block, eikonal swell field, foam.
// Raw WebGL2, no libraries. World units: km, x east, z south, y up.

const VEX = 3;          // terrain vertical exaggeration
const WEX = 9;          // wave displacement exaggeration (so swell is visible at 6 km scale)
const TSCALE = 2;       // visual speed-up of the wave animation
const G = 9.81;
const WM = 200;         // water mesh resolution

// Fenton & McKee explicit approximation to the linear dispersion relation.
function kOf(w, h) {
  const k0 = w * w / G;
  return k0 / Math.pow(Math.tanh(Math.pow(k0 * h, 0.75)), 2 / 3);
}

// Fast-sweeping eikonal |grad phi| = k(depth); returns RGBA32F texel data [phi, depth, dphi/dx, dphi/dz] (per km).
function phaseField(elev, n, cell, dir, T) {
  const N = n * n, w = 2 * Math.PI / T, F = new Float64Array(N), ph = new Float64Array(N).fill(1e30),
    fixed = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const d = -elev[i]; F[i] = (d > 0 ? kOf(w, Math.max(d, 0.5)) : 1.0) * cell; }
  const r = dir * Math.PI / 180, px = -Math.sin(r), py = Math.cos(r); // propagation in (col, row=south)
  const seeds = [], c0 = (n - 1) / 2;
  const edge = (dot, f) => { if (dot < -0.1) for (let i = 0; i < n; i++) { const id = f(i); if (elev[id] < 0) seeds.push(id); } };
  edge(-px, i => i * n);           // west
  edge(px, i => i * n + n - 1);    // east
  edge(-py, i => i);               // north
  edge(py, i => (n - 1) * n + i);  // south
  if (!seeds.length) { let b = 0; for (let i = 1; i < N; i++) if (elev[i] < elev[b]) b = i; seeds.push(b); }
  let kr = 0; for (const s of seeds) kr += F[s]; kr /= seeds.length * cell;
  for (const s of seeds) { ph[s] = kr * (px * (s % n - c0) + py * ((s / n | 0) - c0)) * cell; fixed[s] = 1; }
  for (let it = 0; it < 3; it++) for (let sw = 0; sw < 4; sw++) {
    const rx = sw & 1, ry = sw >> 1;
    for (let jj = 0; jj < n; jj++) {
      const j = ry ? n - 1 - jj : jj;
      for (let ii = 0; ii < n; ii++) {
        const i = rx ? n - 1 - ii : ii, id = j * n + i;
        if (fixed[id]) continue;
        let a = Math.min(i > 0 ? ph[id - 1] : 1e30, i < n - 1 ? ph[id + 1] : 1e30);
        let b = Math.min(j > 0 ? ph[id - n] : 1e30, j < n - 1 ? ph[id + n] : 1e30);
        if (a > b) { const t = a; a = b; b = t; }
        if (a >= 1e29) continue;
        const f = F[id];
        const v = b - a >= f ? a + f : (a + b + Math.sqrt(2 * f * f - (b - a) * (b - a))) / 2;
        if (v < ph[id]) ph[id] = v;
      }
    }
  }
  // Replace land phase near the coast with neighbouring water phase so interpolation stays smooth.
  let good = new Uint8Array(N); for (let i = 0; i < N; i++) good[i] = elev[i] < 0 && ph[i] < 1e29;
  for (let p = 0; p < 4; p++) {
    const g2 = good.slice();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const id = j * n + i; if (good[id]) continue;
      let s = 0, c = 0;
      if (i > 0 && good[id - 1]) { s += ph[id - 1]; c++; }
      if (i < n - 1 && good[id + 1]) { s += ph[id + 1]; c++; }
      if (j > 0 && good[id - n]) { s += ph[id - n]; c++; }
      if (j < n - 1 && good[id + n]) { s += ph[id + n]; c++; }
      if (c) { ph[id] = s / c; g2[id] = 1; }
    }
    good = g2;
  }
  let mn = 1e30; for (let i = 0; i < N; i++) if (good[i] && ph[i] < mn) mn = ph[i];
  for (let i = 0; i < N; i++) ph[i] = good[i] ? ph[i] - mn : 0;
  const out = new Float32Array(N * 4), s = 1000 / cell;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const id = j * n + i, o = id * 4;
    const l = i > 0 ? id - 1 : id, rr = i < n - 1 ? id + 1 : id, u = j > 0 ? id - n : id, d = j < n - 1 ? id + n : id;
    out[o] = ph[id]; out[o + 1] = -elev[id];
    out[o + 2] = good[l] && good[rr] ? (ph[rr] - ph[l]) / (rr - l) * s : 0;
    out[o + 3] = good[u] && good[d] ? (ph[d] - ph[u]) / ((d - u) / n) * s : 0;
  }
  return out;
}

// ---------- tiny mat4 (column-major) ----------
function persp(fy, a, n, f) {
  const t = 1 / Math.tan(fy / 2), nf = 1 / (n - f);
  return [t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0];
}
function lookAt(e, c) {
  let z = [e[0] - c[0], e[1] - c[1], e[2] - c[2]]; const zl = Math.hypot(...z); z = z.map(v => v / zl);
  let x = [z[2], 0, -z[0]]; const xl = Math.hypot(...x) || 1; x = x.map(v => v / xl); // up = +y
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const d = (a) => -(a[0] * e[0] + a[1] * e[1] + a[2] * e[2]);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, d(x), d(y), d(z), 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

// ---------- shaders ----------
const HDR = '#version 300 es\nprecision highp float;precision highp int;precision highp sampler2D;\n';
const TER_VS = HDR + `in vec3 aP;in vec3 aN;in float aE;uniform mat4 uM;out vec3 vN;out vec3 vP;out float vE;
void main(){vN=aN;vP=aP;vE=aE;gl_Position=uM*vec4(aP,1.);}`;
const TER_FS = HDR + `in vec3 vN;in vec3 vP;in float vE;uniform vec3 uW[5];uniform vec3 uLand,uInk,uL;uniform float uDark;out vec4 o;
void main(){vec3 N=normalize(vN);float l=.55+.45*max(dot(N,uL),0.);vec3 c;
if(vE>9000.){c=(vP.y<-.001?uW[4]:uLand)*.72;o=vec4(c*l,1.);return;}
float d=-vE;
if(d>0.){c=mix(uW[0],uW[1],smoothstep(0.,3.,d));c=mix(c,uW[2],smoothstep(3.,8.,d));c=mix(c,uW[3],smoothstep(8.,18.,d));c=mix(c,uW[4],smoothstep(18.,40.,d));
 float q=(d+.13)/5.,f=fwidth(q),e=abs(fract(q+.5)-.5);c=mix(c,uInk,.22*(1.-smoothstep(0.,1.5*f+1e-4,e))*step(2.5,d));}
else{c=mix(uLand,uLand*(uDark>.5?1.25:.9),smoothstep(0.,120.,vE));
 float q=(vE+.13)/20.,f=fwidth(q),e=abs(fract(q+.5)-.5);c=mix(c,uInk,.14*(1.-smoothstep(0.,1.5*f+1e-4,e))*step(10.,vE));}
float fc=fwidth(vE);c=mix(c,uInk,.55*(1.-smoothstep(0.,1.5*fc+1e-3,abs(vE))));
o=vec4(c*l,1.);}`;
const WCOM = `uniform sampler2D uT;uniform int uN;uniform float uTime,uW,uH0,uHb,uCg0,uEx;
vec4 tx(vec2 uv){vec2 p=clamp(uv,0.,1.)*float(uN-1);ivec2 i=ivec2(min(floor(p),vec2(float(uN-2))));vec2 f=p-vec2(i);
vec4 a=texelFetch(uT,i,0),b=texelFetch(uT,i+ivec2(1,0),0),c=texelFetch(uT,i+ivec2(0,1),0),d=texelFetch(uT,i+ivec2(1,1),0);
return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float kOf(float h){float k0=uW*uW/9.81;return k0/pow(tanh(pow(k0*h,.75)),2./3.);}
float waveH(float d,float k){float h=max(d,.5),kh=min(k*h,10.),n=.5*(1.+2.*kh/sinh(2.*kh)),cg=n*uW/k;
float H=min(uH0*sqrt(uCg0/cg),.78*h);if(d<1.3*uHb)H=min(H,.5*h);return H*smoothstep(0.,1.,d);}
`;
const WAT_VS = HDR + WCOM + `in vec2 aU;uniform mat4 uM;uniform float uCell;out vec2 vU;out vec3 vP;
void main(){vec4 s=tx(aU);float d=s.y,k=kOf(max(d,.5));float H=waveH(d,k);
float fv=smoothstep(2.5,5.,6.2832/k/uCell);
float y=.5*H*cos(s.x-uW*uTime)*uEx*.001*fv;
vU=aU;vP=vec3((aU.x-.5)*6.,y,(aU.y-.5)*6.);gl_Position=uM*vec4(vP,1.);}`;
const WAT_FS = HDR + WCOM + `in vec2 vU;in vec3 vP;uniform vec3 uWat,uFoam,uL,uEye;uniform float uDark;out vec4 o;
float hs(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hs(i),hs(i+vec2(1,0)),f.x),mix(hs(i+vec2(0,1)),hs(i+1.),f.x),f.y);}
void main(){vec4 s=tx(vU);float d=s.y;if(d<-.3)discard;
float k=kOf(max(d,.5)),H=waveH(d,k),th=s.x-uW*uTime,aa=1.-smoothstep(.7,2.,fwidth(th)),c=cos(th);
vec2 sl=-.5*H*uEx*.001*sin(th)*s.zw*aa;vec3 N=normalize(vec3(-sl.x,1.,-sl.y));
float cr=pow(max(c,0.),3.)*aa*smoothstep(0.,.4,H);
float nz=vn(vP.xz*55.+vec2(uTime*.15,0.))*.6+vn(vP.xz*140.)*.4;
float sz=1.-smoothstep(uHb*1.,uHb*1.3+.4,d);
float fo=sz*(.55+.45*smoothstep(.2,.9,(c*aa*.5+.5)*.7+nz*.5));
fo=max(fo,cr*smoothstep(.35,.7,H/max(d,.5))*nz*1.2);
fo*=smoothstep(-.3,.25,d);fo=clamp(fo,0.,1.);
vec3 V=normalize(uEye-vP);float df=max(dot(N,uL),0.);float sp=pow(max(dot(reflect(-uL,N),V),0.),80.)*(uDark>.5?.12:.5);
vec3 col=uWat*(.8+.3*df)+cr*(uDark>.5?.05:.18)+sp;
float al=(uDark>.5?.3:.22)+.12*cr+sp*.5;
col=mix(col,uFoam,fo);al=mix(al,.92,fo)*smoothstep(-.3,.15,d);
o=vec4(col*al,al);}`;
const FLAT_VS = HDR + `in vec3 aP;uniform mat4 uM;uniform float uPs;void main(){gl_Position=uM*vec4(aP,1.);gl_PointSize=uPs;}`;
const FLAT_FS = HDR + `uniform vec4 uC;uniform float uRd;out vec4 o;void main(){if(uRd>.5&&length(gl_PointCoord-.5)>.5)discard;o=vec4(uC.rgb*uC.a,uC.a);}`;

const PAL = {
  light: { w: ['#e3f0f5', '#c9e1eb', '#a9cfe0', '#86b8d1', '#5f98bb'], land: '#e8dcb5', ink: '#14263a', accent: '#a3266b', foam: '#ffffff' },
  dark: { w: ['#1d3d55', '#173246', '#122839', '#0d1e2d', '#081521'], land: '#2f2a1e', ink: '#6fa6b8', accent: '#c0508a', foam: '#9fb8c4' },
};

export function createScene(canvas, sceneData, opts = {}) {
  let gl;
  try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true }); } catch (e) { gl = null; }
  if (!gl || !sceneData || !sceneData.elev) return null;
  const n = sceneData.n || 160, S = 6, sizeM = sceneData.sizeM || 6000, cell = sizeM / (n - 1), elev = sceneData.elev;
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let dark = opts.dark ?? !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  let hbOpt = opts.hb, eco = false, onScreen = !window.IntersectionObserver, disposed = false, lost = false;
  canvas.style.touchAction = 'none';

  // ----- programs -----
  const progs = [];
  function prog(vs, fs) {
    const p = gl.createProgram();
    for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s); gl.deleteShader(s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) { const nm = gl.getActiveUniform(p, i).name.replace('[0]', ''); u[nm] = gl.getUniformLocation(p, nm); }
    progs.push(p); return { p, u };
  }
  let PT, PW, PF;
  try { PT = prog(TER_VS, TER_FS); PW = prog(WAT_VS, WAT_FS); PF = prog(FLAT_VS, FLAT_FS); }
  catch (e) { console.warn('scene3d', e); gl.getExtension('WEBGL_lose_context')?.loseContext(); return null; }

  const bufs = [], vaos = [];
  function vao(p, attrs, idx) {
    const v = gl.createVertexArray(); gl.bindVertexArray(v); vaos.push(v);
    for (const [name, data, size, stride, off] of attrs) {
      const loc = gl.getAttribLocation(p, name); if (loc < 0) continue;
      let b = data._buf;
      if (!b) { b = data._buf = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); }
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
    }
    if (idx) { const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); }
    gl.bindVertexArray(null); return v;
  }
  const gridIdx = (m, arr, off, base) => {
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < m - 1; i++) {
      const a = base + j * m + i; arr.set([a, a + 1, a + m, a + 1, a + m + 1, a + m], off); off += 6;
    }
    return off;
  };

  // ----- terrain block -----
  let minE = 0; for (let i = 0; i < n * n; i++) minE = Math.min(minE, elev[i]);
  const baseY = minE * VEX / 1000 - 0.12, yOf = e => e * VEX / 1000, X = i => (i / (n - 1) - 0.5) * S;
  const nv = n * n + 8 * n, tv = new Float32Array(nv * 7);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const id = j * n + i, o = id * 7;
    const hx = (yOf(elev[j * n + Math.min(i + 1, n - 1)]) - yOf(elev[j * n + Math.max(i - 1, 0)])) / (2 * S / (n - 1));
    const hz = (yOf(elev[Math.min(j + 1, n - 1) * n + i]) - yOf(elev[Math.max(j - 1, 0) * n + i])) / (2 * S / (n - 1));
    const l = Math.hypot(hx, 1, hz);
    tv.set([X(i), yOf(elev[id]), X(j), -hx / l, 1 / l, -hz / l, elev[id]], o);
  }
  const tIdx = new Uint16Array((n - 1) * (n - 1) * 6 + 4 * (n - 1) * 6);
  let off = gridIdx(n, tIdx, 0, 0), vb = n * n;
  const edges = [[i => i, 0, -1], [i => (n - 1) * n + i, 0, 1], [i => i * n, -1, 0], [i => i * n + n - 1, 1, 0]];
  for (const [f, nx, nz] of edges) {
    for (let i = 0; i < n; i++) {
      const s = f(i) * 7;
      tv.set([tv[s], tv[s + 1], tv[s + 2], nx, 0, nz, 1e4], (vb + 2 * i) * 7);
      tv.set([tv[s], baseY, tv[s + 2], nx, 0, nz, 1e4], (vb + 2 * i + 1) * 7);
      if (i < n - 1) { const a = vb + 2 * i; tIdx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], off); off += 6; }
    }
    vb += 2 * n;
  }
  const terrVao = vao(PT.p, [['aP', tv, 3, 7, 0], ['aN', tv, 3, 7, 3], ['aE', tv, 1, 7, 6]], tIdx);

  // ----- water grid -----
  const wv = new Float32Array(WM * WM * 2);
  for (let j = 0; j < WM; j++) for (let i = 0; i < WM; i++) wv.set([i / (WM - 1), j / (WM - 1)], (j * WM + i) * 2);
  const wIdx = new Uint16Array((WM - 1) * (WM - 1) * 6); gridIdx(WM, wIdx, 0, 0);
  const watVao = vao(PW.p, [['aU', wv, 2, 2, 0]], wIdx);

  // ----- pin + north arrow -----
  const cE = elev[(n >> 1) * n + (n >> 1)], pinTop = Math.max(yOf(cE), 0) + 0.45;
  const fv = new Float32Array([0, Math.min(yOf(cE), 0), 0, 0, pinTop, 0,
    0, 0.003, -S / 2 - 0.42, -0.13, 0.003, -S / 2 - 0.1, 0, 0.003, -S / 2 - 0.18,
    0, 0.003, -S / 2 - 0.42, 0.13, 0.003, -S / 2 - 0.1, 0, 0.003, -S / 2 - 0.18]);
  const flatVao = vao(PF.p, [['aP', fv, 3, 3, 0]]);

  // ----- phase texture -----
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let swell = { dir: sceneData.normal ?? 270, t: 0, h: 0 };
  function upload() {
    const T = swell.t > 1 ? swell.t : 10;
    const data = phaseField(elev, n, cell, swell.dir || 0, T);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, data);
  }

  // ----- colours from CSS -----
  const cc = document.createElement('canvas'); cc.width = cc.height = 1;
  const cx = cc.getContext('2d', { willReadFrequently: true });
  let C = {};
  function rgb(name, fb) {
    let v = ''; try { v = getComputedStyle(canvas).getPropertyValue(name).trim(); } catch (e) { /* ignore */ }
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = fb; cx.fillStyle = v || fb; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
  function readColours() {
    const P = dark ? PAL.dark : PAL.light;
    const w = P.w.map((fb, i) => rgb('--water-' + i, fb));
    C = { w: w.flat(), land: rgb('--land', P.land), ink: rgb('--ink', P.ink), accent: rgb('--accent', P.accent), foam: rgb('--foam', P.foam) };
    C.wat = dark ? w[3] : w[2];
  }

  // ----- camera -----
  const yaw0 = Math.PI - (sceneData.normal ?? 180) * Math.PI / 180;
  const cam = { yaw: yaw0, pitch: 0.62, dist: 8.2 };
  const reset = () => { cam.yaw = yaw0; cam.pitch = 0.62; cam.dist = 8.2; kick(); };
  const ptrs = new Map(); let pinch = 0, dist0 = 0;
  const pd = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const on = (t, ev, f, o) => { t.addEventListener(ev, f, o); offs.push(() => t.removeEventListener(ev, f, o)); };
  const offs = [];
  on(canvas, 'pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { pinch = pd(); dist0 = cam.dist; }
  });
  on(canvas, 'pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      cam.yaw -= dx * 0.006; cam.pitch = Math.min(1.45, Math.max(0.12, cam.pitch + dy * 0.005));
    } else if (ptrs.size === 2 && pinch) cam.dist = Math.min(16, Math.max(2.5, dist0 * pinch / Math.max(pd(), 1)));
    kick();
  });
  const up = e => { ptrs.delete(e.pointerId); pinch = 0; if (ptrs.size === 2) { pinch = pd(); dist0 = cam.dist; } };
  on(canvas, 'pointerup', up); on(canvas, 'pointercancel', up);
  on(canvas, 'wheel', e => { e.preventDefault(); cam.dist = Math.min(16, Math.max(2.5, cam.dist * Math.exp(e.deltaY * 0.0012))); kick(); }, { passive: false });
  on(canvas, 'dblclick', reset);
  on(canvas, 'webglcontextlost', e => { e.preventDefault(); lost = true; });
  on(document, 'visibilitychange', () => kick());
  if (mq) on(mq, 'change', () => kick());

  // ----- size / visibility -----
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  const ro = window.ResizeObserver ? new ResizeObserver(() => { fit(); kick(); }) : null; ro?.observe(canvas);
  const io = window.IntersectionObserver ? new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; kick(); }) : null;
  io?.observe(canvas);

  // ----- render -----
  const L = (() => { const v = [-0.45, 0.8, -0.4], l = Math.hypot(...v); return v.map(x => x / l); })();
  let simT = 0, last = 0, raf = 0;
  const animating = () => !eco && !(mq && mq.matches) && swell.h > 0;
  function kick() { if (!raf && !disposed && !lost && onScreen && !document.hidden) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0; if (disposed || lost || !onScreen || document.hidden) { last = 0; return; }
    const anim = animating();
    if (anim) {
      if (last && now - last < 32) { raf = requestAnimationFrame(frame); return; }
      if (last) simT += Math.min(now - last, 100) / 1000;
      last = now;
    } else last = 0;
    draw();
    if (anim) raf = requestAnimationFrame(frame);
  }
  function draw() {
    fit();
    const W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const cp = Math.cos(cam.pitch), eye = [cam.dist * cp * Math.sin(cam.yaw), cam.dist * Math.sin(cam.pitch), cam.dist * cp * Math.cos(cam.yaw)];
    const M = mul(persp(0.75, W / H, 0.05, 60), lookAt(eye, [0, -0.15, 0]));
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(true);
    // terrain
    gl.useProgram(PT.p); let u = PT.u;
    gl.uniformMatrix4fv(u.uM, false, M); gl.uniform3fv(u.uW, C.w); gl.uniform3fv(u.uLand, C.land);
    gl.uniform3fv(u.uInk, C.ink); gl.uniform3fv(u.uL, L); gl.uniform1f(u.uDark, dark ? 1 : 0);
    gl.bindVertexArray(terrVao); gl.drawElements(gl.TRIANGLES, tIdx.length, gl.UNSIGNED_SHORT, 0);
    // water
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    gl.useProgram(PW.p); u = PW.u;
    const T = swell.t > 1 ? swell.t : 10, w = 2 * Math.PI / T, h0 = swell.h > 0 ? swell.h : 0;
    const hb = hbOpt ?? swell.hb ?? (h0 > 0 ? 0.39 * Math.pow(G, 0.2) * Math.pow(T * h0 * h0, 0.4) : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uT, 0); gl.uniform1i(u.uN, n); gl.uniform1f(u.uTime, simT * TSCALE); gl.uniform1f(u.uW, w);
    gl.uniform1f(u.uH0, h0); gl.uniform1f(u.uHb, hb); gl.uniform1f(u.uCg0, G * T / (4 * Math.PI)); gl.uniform1f(u.uEx, WEX);
    gl.uniform1f(u.uCell, sizeM / (WM - 1)); gl.uniformMatrix4fv(u.uM, false, M);
    gl.uniform3fv(u.uWat, C.wat); gl.uniform3fv(u.uFoam, C.foam); gl.uniform3fv(u.uL, L); gl.uniform3fv(u.uEye, eye);
    gl.uniform1f(u.uDark, dark ? 1 : 0);
    gl.bindVertexArray(watVao); gl.drawElements(gl.TRIANGLES, wIdx.length, gl.UNSIGNED_SHORT, 0);
    // pin + north arrow
    gl.depthMask(true); gl.useProgram(PF.p); u = PF.u; gl.uniformMatrix4fv(u.uM, false, M);
    gl.bindVertexArray(flatVao);
    gl.uniform4f(u.uC, ...C.ink, dark ? 0.7 : 0.8); gl.uniform1f(u.uRd, 0); gl.drawArrays(gl.TRIANGLES, 2, 6);
    gl.uniform4f(u.uC, ...C.accent, 1); gl.drawArrays(gl.LINES, 0, 2);
    gl.uniform1f(u.uRd, 1); gl.uniform1f(u.uPs, 9 * Math.min(window.devicePixelRatio || 1, 1.5)); gl.drawArrays(gl.POINTS, 1, 1);
    gl.bindVertexArray(null);
  }

  readColours(); upload(); fit(); kick();

  return {
    setSwell(s) {
      if (!s) return;
      const re = s.dir !== swell.dir || s.t !== swell.t;
      swell = { dir: +s.dir || 0, t: +s.t || 0, h: +s.h || 0, hb: s.hb };
      if (s.hb != null) hbOpt = s.hb;
      if (re) upload();
      kick();
    },
    setEco(v) { eco = !!v; kick(); },
    setTheme(d) { dark = !!d; readColours(); kick(); },
    dispose() {
      if (disposed) return; disposed = true;
      if (raf) cancelAnimationFrame(raf); raf = 0;
      ro?.disconnect(); io?.disconnect(); offs.forEach(f => f());
      bufs.forEach(b => gl.deleteBuffer(b)); vaos.forEach(v => gl.deleteVertexArray(v));
      progs.forEach(p => gl.deleteProgram(p)); gl.deleteTexture(tex);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
