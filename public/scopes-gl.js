// 0.12.0 video scopes: WebGL2 renderer (no libraries). Input: Y′CbCr planes straight from the decoder (I420 / NV12 —
// the exact code values of the bitstream) or an RGB picture (MSE <video>, JPEG) converted back to Y′CbCr (BT.709).
//  1. ANALYZE   source -> analysis texture (AW x AH, nearest sampling, RGBA8 = Y′, Cb, Cr code values)
//  2. ACCUMULATE  one gl.POINTS draw per scope, vertex shader texelFetch()es its sample by gl_VertexID and places it
//               (waveform: x = column, y = Y′ level; parade: R′ G′ B′ in thirds; vectorscope: (Pb, Pr)); additive
//               blending into RGBA16F targets (EXT_color_buffer_float; RGBA8 fallback)
//  3. DISPLAY   each target -> its panel, brightness 1 - exp(-count x gain), phosphor tint; picture with false colour /
//               zebra LUT on Y′. Graticules / labels are drawn on a 2D overlay (only when the layout changes).
// The pure maths (levels, false-colour bands, vectorscope targets) is shared with the Node tests (module.exports).
(function (root) {
  'use strict';
  // ARRI-style false colour (Rec.709 video levels, SmallHD / ARRI "Exposure Assist"); everything else: greyscale
  const FALSE_COLOR = [
    { lo: -1000, hi: 2.5, rgb: [0.55, 0.0, 0.8], name: 'PURPLE', label: '< 2.5 % crushed' },
    { lo: 2.5, hi: 4, rgb: [0.05, 0.35, 1.0], name: 'BLUE', label: '2.5–4 % near black' },
    { lo: 38, hi: 42, rgb: [0.15, 0.8, 0.15], name: 'GREEN', label: '38–42 % 18 % grey' },
    { lo: 52, hi: 56, rgb: [1.0, 0.45, 0.75], name: 'PINK', label: '52–56 % +1 stop (skin)' },
    { lo: 97, hi: 99, rgb: [1.0, 0.92, 0.0], name: 'YELLOW', label: '97–99 % near clip' },
    { lo: 99, hi: 1000, rgb: [1.0, 0.0, 0.0], name: 'RED', label: '≥ 99 % clipped' },
  ];
  const WFM_LO = -0.10; const WFM_HI = 1.10; // waveform display range (video level 0..1)
  const SKIN_ANGLE = 123; // degrees from +Pb (the "I" / flesh-tone line)
  const VEC_SCALE = 0.9 / 0.5; // Pb / Pr 0.5 -> 90 % of the vectorscope radius
  function falseColorOf(pct) { for (const b of FALSE_COLOR) if (pct >= b.lo && pct < b.hi) return b; return null; }
  // code value (8-bit) -> video level in % (Y′) or Pb/Pr (-0.5..0.5)
  const levelOf = (y, full) => (full ? (y / 255) * 100 : ((y - 16) / 219) * 100);
  const chromaOf = (c, full) => (full ? (c - 128) / 255 : (c - 128) / 224);
  function ycbcrOf(r, g, b, full) { // R′G′B′ 0..1 -> Y′CbCr codes, BT.709
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; const pb = (b - y) / 1.8556; const pr = (r - y) / 1.5748;
    return full ? [y * 255, 128 + pb * 255, 128 + pr * 255] : [16 + 219 * y, 128 + 224 * pb, 128 + 224 * pr];
  }
  function targets() { // vectorscope bar targets (Pb, Pr) at 75 % and 100 %
    const bars = [['R', 1, 0, 0], ['MG', 1, 0, 1], ['B', 0, 0, 1], ['CY', 0, 1, 1], ['G', 0, 1, 0], ['YL', 1, 1, 0]];
    const out = [];
    for (const amp of [0.75, 1]) for (const [name, r, g, b] of bars) { const y = 0.2126 * r * amp + 0.7152 * g * amp + 0.0722 * b * amp; out.push({ name, amp, pb: (b * amp - y) / 1.8556, pr: (r * amp - y) / 1.5748 }); }
    return out;
  }
  const math = { FALSE_COLOR, falseColorOf, levelOf, chromaOf, ycbcrOf, targets, WFM_LO, WFM_HI, SKIN_ANGLE, VEC_SCALE };
  if (typeof module !== 'undefined' && module.exports) { module.exports = math; return; }

  const VS_QUAD = `#version 300 es
  out vec2 v_uv; void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  // source -> Y′CbCr codes /255 (u_src: 0 I420, 1 NV12, 2 RGB)
  const FS_ANALYZE = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D u_y, u_u, u_v; uniform int u_src; uniform ivec2 u_srcSize, u_dstSize;
  out vec4 o;
  void main(){
    ivec2 d = ivec2(gl_FragCoord.xy);
    ivec2 s = ivec2((vec2(d) + 0.5) * vec2(u_srcSize) / vec2(u_dstSize));
    vec3 c;
    if (u_src == 2) { vec3 rgb = texelFetch(u_y, s, 0).rgb; float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      c = vec3(16.0 + 219.0 * y, 128.0 + 224.0 * (rgb.b - y) / 1.8556, 128.0 + 224.0 * (rgb.r - y) / 1.5748) / 255.0; }
    else if (u_src == 1) { c = vec3(texelFetch(u_y, s, 0).r, texelFetch(u_u, s / 2, 0).rg); }
    else { c = vec3(texelFetch(u_y, s, 0).r, texelFetch(u_u, s / 2, 0).r, texelFetch(u_v, s / 2, 0).r); }
    o = vec4(c, 1.0);
  }`;
  const VS_POINTS = `#version 300 es
  precision highp float; precision highp int;
  uniform sampler2D u_an; uniform ivec2 u_anSize; uniform int u_mode; uniform float u_full, u_vgain;
  void main(){
    int n = u_anSize.x * u_anSize.y; int id = gl_VertexID; int ch = 0;
    ivec2 p = ivec2(id % u_anSize.x, id / u_anSize.x);
    // parade: each channel is drawn into a third of the width, so it samples every third column (same cost as WFM)
    if (u_mode == 1) { int cw = u_anSize.x / 3; int nc = cw * u_anSize.y; ch = id / nc; id -= ch * nc; p = ivec2((id % cw) * 3 + 1, id / cw); }
    vec3 c = texelFetch(u_an, p, 0).rgb * 255.0;
    float Y = u_full > 0.5 ? c.r / 255.0 : (c.r - 16.0) / 219.0;
    float Pb = u_full > 0.5 ? (c.g - 128.0) / 255.0 : (c.g - 128.0) / 224.0;
    float Pr = u_full > 0.5 ? (c.b - 128.0) / 255.0 : (c.b - 128.0) / 224.0;
    float x; float v;
    if (u_mode == 2) { gl_Position = vec4(Pb * u_vgain, Pr * u_vgain, 0.0, 1.0); gl_PointSize = 1.0; return; }
    if (u_mode == 1) { vec3 rgb = vec3(Y + 1.5748 * Pr, Y - 0.1873 * Pb - 0.4681 * Pr, Y + 1.8556 * Pb); v = ch == 0 ? rgb.r : ch == 1 ? rgb.g : rgb.b; x = (float(ch) + (float(p.x) + 0.5) / float(u_anSize.x)) / 3.0; }
    else { v = Y; x = (float(p.x) + 0.5) / float(u_anSize.x); }
    float y = (v - ${WFM_LO.toFixed(3)}) / (${(WFM_HI - WFM_LO).toFixed(3)});
    gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0;
  }`;
  const FS_ONE = `#version 300 es
  precision mediump float; out vec4 o; void main(){ o = vec4(1.0); }`;
  const FS_SCOPE = `#version 300 es
  precision highp float;
  in vec2 v_uv; uniform sampler2D u_acc; uniform float u_k; uniform int u_tint; out vec4 o;
  void main(){
    float c = texture(u_acc, v_uv).r; float b = 1.0 - exp(-sqrt(c * u_k) * 1.2);
    vec3 t = vec3(0.55, 1.0, 0.65);
    if (u_tint == 1) { float th = v_uv.x * 3.0; t = th < 1.0 ? vec3(1.0, 0.3, 0.3) : th < 2.0 ? vec3(0.35, 1.0, 0.35) : vec3(0.4, 0.55, 1.0); }
    else if (u_tint == 2) t = vec3(0.75, 1.0, 0.8);
    o = vec4(t * b + vec3(b * b * 0.35), 1.0);
  }`;
  const FS_PICTURE = `#version 300 es
  precision highp float;
  in vec2 v_uv; uniform sampler2D u_y, u_u, u_v; uniform int u_src, u_view; uniform float u_full, u_zebra, u_time;
  uniform vec2 u_px; uniform vec4 u_band[6]; uniform vec3 u_bandRgb[6]; uniform int u_matrix;
  out vec4 o;
  void main(){
    vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
    vec3 ycc; vec3 rgb;
    if (u_src == 2) { rgb = texture(u_y, uv).rgb; float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722)); ycc = vec3(y, (rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748); }
    else {
      float Yc = texture(u_y, uv).r * 255.0; vec2 C = u_src == 1 ? texture(u_u, uv).rg * 255.0 : vec2(texture(u_u, uv).r, texture(u_v, uv).r) * 255.0;
      ycc = u_full > 0.5 ? vec3(Yc / 255.0, (C - 128.0) / 255.0) : vec3((Yc - 16.0) / 219.0, (C - 128.0) / 224.0);
      if (u_matrix == 1) rgb = vec3(ycc.x + 1.402 * ycc.z, ycc.x - 0.344136 * ycc.y - 0.714136 * ycc.z, ycc.x + 1.772 * ycc.y);
      else rgb = vec3(ycc.x + 1.5748 * ycc.z, ycc.x - 0.1873 * ycc.y - 0.4681 * ycc.z, ycc.x + 1.8556 * ycc.y);
    }
    float pct = ycc.x * 100.0;
    if (u_view == 1) {
      vec3 g = vec3(clamp(ycc.x, 0.0, 1.0) * 0.85);
      for (int i = 0; i < 6; i++) if (pct >= u_band[i].x && pct < u_band[i].y) g = u_bandRgb[i];
      o = vec4(g, 1.0); return;
    }
    if (u_view == 2 && pct >= u_zebra) { float s = mod((gl_FragCoord.x + gl_FragCoord.y) / 8.0 + u_time * 4.0, 2.0); if (s < 1.0) rgb = vec3(1.0, 1.0, 1.0) * 0.95; else rgb *= 0.35; }
    o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); const nm = a.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }

  class ScopesGL {
    constructor(canvas, { preserve = false, analysisWidth = 640 } = {}) {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: preserve, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available in this browser');
      this.gl = gl; this.canvas = canvas; this.maxAW = analysisWidth;
      this.floatOk = !!gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
      this.prog = { an: compile(gl, VS_QUAD, FS_ANALYZE), pts: compile(gl, VS_POINTS, FS_ONE), scope: compile(gl, VS_QUAD, FS_SCOPE), pic: compile(gl, VS_QUAD, FS_PICTURE) };
      this.vao = gl.createVertexArray();
      this.tex = { y: this._tex(), u: this._tex(), v: this._tex() };
      this.src = null; // {mode: 0 I420 | 1 NV12 | 2 RGB, w, h}
      this.targets = {};
      this.opts = { full: false, gain: 1, vgain: 1, view: 0, zebra: 95, matrix: 0, show: { pic: true, wfm: true, parade: true, vec: true } };
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }
    _tex(filter) { const gl = this.gl; const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR], [gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; }
    _target(name, w, h, float) {
      const gl = this.gl; let t = this.targets[name];
      if (t && t.w === w && t.h === h) return t;
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      const tex = this._tex(gl.NEAREST); const fl = float && this.floatOk;
      if (fl) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (fl) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); }
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = this.targets[name] = { tex, fb, w, h, float: fl }; return t;
    }
    // planes: {format:'I420'|'NV12', width, height, data: Uint8Array, layout:[{offset, stride}...]} (VideoFrame.copyTo)
    uploadPlanes(f) {
      const gl = this.gl; gl.activeTexture(gl.TEXTURE7); const { width: w, height: h, data, layout } = f; const cw = Math.ceil(w / 2); const ch = Math.ceil(h / 2);
      const plane = (tex, i, pw, ph, ifmt, fmt, bpp) => {
        gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[i].stride / bpp);
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, pw, ph, 0, fmt, gl.UNSIGNED_BYTE, data, layout[i].offset);
      };
      if (f.format === 'NV12') { plane(this.tex.y, 0, w, h, gl.R8, gl.RED, 1); plane(this.tex.u, 1, cw, ch, gl.RG8, gl.RG, 2); this.src = { mode: 1, w, h }; }
      else { plane(this.tex.y, 0, w, h, gl.R8, gl.RED, 1); plane(this.tex.u, 1, cw, ch, gl.R8, gl.RED, 1); plane(this.tex.v, 2, cw, ch, gl.R8, gl.RED, 1); this.src = { mode: 0, w, h }; }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    }
    // RGB picture: VideoFrame, HTMLVideoElement, HTMLImageElement, ImageBitmap, canvas
    uploadImage(img, w, h) {
      const gl = this.gl; gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.tex.y);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.src = { mode: 2, w, h };
    }
    // raw I420 bytes (tests / reference frames)
    uploadI420(data, w, h) { const cw = w / 2; const ch = h / 2; this.uploadPlanes({ format: 'I420', width: w, height: h, data, layout: [{ offset: 0, stride: w }, { offset: w * h, stride: cw }, { offset: w * h + cw * ch, stride: cw }] }); }
    set(o) { Object.assign(this.opts, o); }
    get analysisSize() { const s = this.src; if (!s) return [0, 0]; const aw = Math.min(this.maxAW, s.w); return [aw, Math.max(1, Math.round((aw * s.h) / s.w))]; }
    _bindSrc(p) {
      const gl = this.gl; const s = this.src;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex.y); gl.uniform1i(p.u.u_y, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex.u); gl.uniform1i(p.u.u_u, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tex.v); gl.uniform1i(p.u.u_v, 2);
      gl.uniform1i(p.u.u_src, s.mode);
    }
    // the RGB path is always delivered as legal-range codes by ANALYZE; the picture shader handles RGB itself
    get effFull() { return this.src && this.src.mode === 2 ? false : !!this.opts.full; }
    // panels: {pic, wfm, parade, vec}: [x, y, w, h] in canvas pixels (top-left origin) or null
    render(panels, time = 0) {
      const gl = this.gl; const s = this.src; const W = this.canvas.width; const Hc = this.canvas.height; const o = this.opts;
      gl.bindVertexArray(this.vao); gl.disable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, Hc); gl.disable(gl.SCISSOR_TEST); gl.clearColor(0.03, 0.035, 0.04, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!s) return;
      const [aw, ah] = this.analysisSize; const full = this.effFull ? 1 : 0;
      for (const unit of [3, 4]) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, null); } // no feedback loops
      // 1. analyze
      const an = this._target('an', aw, ah, false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, an.fb); gl.viewport(0, 0, aw, ah); gl.disable(gl.BLEND);
      const pa = this.prog.an; gl.useProgram(pa.p); this._bindSrc(pa); gl.uniform2i(pa.u.u_srcSize, s.w, s.h); gl.uniform2i(pa.u.u_dstSize, aw, ah);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // 2. accumulate
      const pp = this.prog.pts; gl.useProgram(pp.p);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, an.tex); gl.uniform1i(pp.u.u_an, 3);
      gl.uniform2i(pp.u.u_anSize, aw, ah); gl.uniform1f(pp.u.u_full, full); gl.uniform1f(pp.u.u_vgain, VEC_SCALE * (o.vgain || 1));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(gl.FUNC_ADD); gl.clearColor(0, 0, 0, 0);
      const acc = (name, w, h, mode, count) => { const t = this._target(name, w, h, true); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT); gl.uniform1i(pp.u.u_mode, mode); gl.drawArrays(gl.POINTS, 0, count); };
      const scale8 = this.floatOk ? 1 : 255; // RGBA8 fallback saturates at 1 count: brightness is then on/off
      if (panels.wfm) acc('wfm', aw, 512, 0, aw * ah);
      if (panels.parade) acc('parade', aw, 512, 1, Math.floor(aw / 3) * ah * 3);
      if (panels.vec) acc('vec', 512, 512, 2, aw * ah);
      gl.disable(gl.BLEND); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
      // 3. display
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.enable(gl.SCISSOR_TEST);
      const vp = (r) => { const [x, y, w, h] = r; gl.viewport(x, Hc - y - h, w, h); gl.scissor(x, Hc - y - h, w, h); };
      const g = Math.max(0.05, o.gain || 1);
      const ps = this.prog.scope;
      const show = (name, r, k, tint) => { if (!r) return; vp(r); gl.useProgram(ps.p); gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.targets[name].tex); gl.uniform1i(ps.u.u_acc, 4); gl.uniform1f(ps.u.u_k, k * g * scale8); gl.uniform1i(ps.u.u_tint, tint); gl.drawArrays(gl.TRIANGLES, 0, 3); };
      show('wfm', panels.wfm, 40 / ah, 0);
      show('parade', panels.parade, 40 / ah, 1);
      show('vec', panels.vec, (512 * 512) / (aw * ah) * 0.35, 2);
      if (panels.pic) {
        vp(panels.pic); const pc = this.prog.pic; gl.useProgram(pc.p); this._bindSrc(pc);
        gl.uniform1i(pc.u.u_view, o.view | 0); gl.uniform1f(pc.u.u_full, full); gl.uniform1f(pc.u.u_zebra, o.zebra); gl.uniform1f(pc.u.u_time, time); gl.uniform1i(pc.u.u_matrix, o.matrix | 0);
        gl.uniform4fv(pc.u.u_band, FALSE_COLOR.flatMap((b) => [b.lo, b.hi, 0, 0])); gl.uniform3fv(pc.u.u_bandRgb, FALSE_COLOR.flatMap((b) => b.rgb));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    finish() { this.gl.finish(); }
    sync() { this.readCanvas(0, 0); } // a 1-pixel read waits for the GPU: draw-cost measurement only
    // test / measurement helpers: accumulated counts (r channel) of a scope target, analysis texel codes
    readTarget(name) {
      const gl = this.gl; const t = this.targets[name]; if (!t) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      let out;
      if (t.float) { const f = new Float32Array(t.w * t.h * 4); gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, f); out = f; }
      else { const b = new Uint8Array(t.w * t.h * 4); gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, b); out = Float32Array.from(b, (v) => v / 255); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const r = new Float32Array(t.w * t.h); for (let i = 0; i < r.length; i++) r[i] = out[i * 4];
      return { w: t.w, h: t.h, data: r };
    }
    readAnalysis() { const gl = this.gl; const t = this.targets.an; if (!t) return null; gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); const b = new Uint8Array(t.w * t.h * 4); gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, b); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { w: t.w, h: t.h, data: b }; }
    readCanvas(x, y, w = 1, h = 1) { const gl = this.gl; const b = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(x, this.canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; }
  }

  // 2D graticules for the overlay canvas (ctx in device pixels; r = [x, y, w, h])
  function drawGraticule(ctx, kind, r, { full = false, dpr = 1, vgain = 1 } = {}) {
    const [x, y, w, h] = r; const f = (px) => Math.round(px * dpr);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.font = `${f(10)}px ui-monospace, Menlo, monospace`; ctx.lineWidth = Math.max(1, dpr * 0.75);
    if (kind === 'wfm' || kind === 'parade') {
      const yOf = (lvl) => y + h - ((lvl - WFM_LO) / (WFM_HI - WFM_LO)) * h;
      for (let l = 0; l <= 100; l += 10) {
        const yy = Math.round(yOf(l / 100)) + 0.5; ctx.strokeStyle = l === 0 || l === 100 ? 'rgba(255,200,80,0.55)' : 'rgba(255,200,80,0.22)';
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
        ctx.fillStyle = 'rgba(255,210,120,0.8)'; ctx.fillText(String(l), x + f(3), yy - f(2));
        if (l === 0 || l === 100 || l === 50) { const code = full ? Math.round((l / 100) * 255) : Math.round(16 + 2.19 * l); const t = String(code); ctx.fillStyle = 'rgba(255,210,120,0.45)'; ctx.fillText(t, x + w - ctx.measureText(t).width - f(3), yy - f(2)); }
      }
      ctx.setLineDash([f(4), f(4)]); ctx.strokeStyle = 'rgba(255,90,90,0.5)';
      for (const l of [109.5, -7.3]) { const yy = Math.round(yOf(l / 100)) + 0.5; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
      ctx.setLineDash([]);
      if (kind === 'parade') { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; for (const k of [1, 2]) { const xx = Math.round(x + (w * k) / 3) + 0.5; ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); ctx.stroke(); }
        ['R', 'G', 'B'].forEach((c, i) => { ctx.fillStyle = ['#f66', '#6f6', '#79f'][i]; ctx.fillText(c, x + (w * (i + 0.5)) / 3, y + f(12)); }); }
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(kind === 'wfm' ? 'WAVEFORM Y′ %' : 'RGB PARADE %', x + f(26), y + f(12));
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; const rl = full ? 'FULL 0–255' : 'LEGAL 16–235'; ctx.fillText(rl, x + w - ctx.measureText(rl).width - f(4), y + f(12));
    } else if (kind === 'vec') {
      const cx = x + w / 2; const cy = y + h / 2; const R = Math.min(w, h) / 2; const k = VEC_SCALE * vgain; // Pb/Pr -> fraction of R
      ctx.strokeStyle = 'rgba(255,200,80,0.35)'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,200,80,0.18)'; ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      const a = (SKIN_ANGLE * Math.PI) / 180; ctx.strokeStyle = 'rgba(255,170,120,0.7)'; ctx.setLineDash([f(5), f(3)]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,170,120,0.85)'; ctx.fillText('SKIN', cx + Math.cos(a) * R * 0.92 - f(10), cy - Math.sin(a) * R * 0.92 + f(10));
      for (const t of targets()) {
        const px = cx + t.pb * k * R; const py = cy - t.pr * k * R; const s = f(t.amp === 1 ? 5 : 7);
        ctx.strokeStyle = t.amp === 1 ? 'rgba(255,255,255,0.75)' : 'rgba(255,200,80,0.85)';
        if (t.amp === 1) { ctx.beginPath(); ctx.arc(px, py, s * 0.7, 0, Math.PI * 2); ctx.stroke(); } else ctx.strokeRect(px - s, py - s, 2 * s, 2 * s);
        if (t.amp === 1) { ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText(t.name, px + (t.pb >= 0 ? f(8) : -f(22)), py + (t.pr >= 0 ? -f(6) : f(14))); }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(`VECTORSCOPE${vgain !== 1 ? ` ×${vgain}` : ''}`, x + f(4), y + f(12));
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText('□ 75 %  ○ 100 %', x + f(4), y + h - f(5));
    }
    ctx.restore();
  }

  root.ScopesGL = ScopesGL; root.ScopesMath = { ...math, drawGraticule };
})(typeof window !== 'undefined' ? window : globalThis);
