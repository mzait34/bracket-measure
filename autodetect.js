/* Classical (no ML) tooth outline detection around a seed point the user touches.
   Region-grows in CIE Lab from the seed (stops at strong colour edges: gum = pink, mouth/gaps = dark), fills holes
   (specular highlights), finds the gum side from the colour just outside the outline, then returns the crown's
   incisal, gingival, left and right extreme points in image pixels. Pure: works on any {width,height,data(RGBA)}. */
(function (root) {
  'use strict';
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function lab(r, g, b) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const fx = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), fy = f(R * 0.2126 + G * 0.7152 + B * 0.0722),
      fz = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function detect(img, seed, opt) {
    opt = opt || {};
    const W = img.width, H = img.height, D = img.data, N = W * H;
    const T1 = opt.t1 || 25, T2 = opt.t2 || 9, MAXF = opt.maxFrac || 0.3, MINPX = opt.minPx || 150;
    const Lc = new Float32Array(N).fill(NaN), Ac = new Float32Array(N), Bc = new Float32Array(N);
    const get = i => { if (Lc[i] !== Lc[i]) { const o = i * 4, c = lab(D[o], D[o + 1], D[o + 2]); Lc[i] = c[0]; Ac[i] = c[1]; Bc[i] = c[2]; } };
    const sx = Math.round(seed[0]), sy = Math.round(seed[1]);
    if (sx < 3 || sy < 3 || sx >= W - 3 || sy >= H - 3) return { ok: false, reason: 'seed outside image' };

    // seed colour = per-channel median of a 7x7 patch (robust to noise / highlights)
    const ls = [], as = [], bs = [];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const i = (sy + dy) * W + sx + dx; get(i); ls.push(Lc[i]); as.push(Ac[i]); bs.push(Bc[i]); }
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    const S = [med(ls), med(as), med(bs)];
    const dSeed = i => Math.hypot(Lc[i] - S[0], Ac[i] - S[1], Bc[i] - S[2]);
    const dPair = (i, j) => Math.hypot(Lc[i] - Lc[j], Ac[i] - Ac[j], Bc[i] - Bc[j]);
    if (S[0] < 40) return { ok: false, reason: 'touch the tooth itself (that spot is too dark)' };

    // region growing
    const mask = new Uint8Array(N), q = new Int32Array(N);
    let head = 0, tail = 0, count = 0;
    let s0 = sy * W + sx; mask[s0] = 1; q[tail++] = s0; count = 1;
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x, ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (mask[j]) continue;
        get(j);
        if (dSeed(j) < T1 && dPair(i, j) < T2) {
          mask[j] = 1; q[tail++] = j;
          if (++count > MAXF * N) return { ok: false, reason: 'no clear tooth edge found (region leaked)' };
        }
      }
    }
    if (count < MINPX) return { ok: false, reason: 'tooth region too small - move closer' };

    // fill holes (highlights, stains): background flood from the bounding-box border
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let i = 0; i < N; i++) if (mask[i]) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W - 1, x1 + 1); y1 = Math.min(H - 1, y1 + 1);
    const outside = new Uint8Array(N); head = tail = 0;
    const push = (x, y) => { const i = y * W + x; if (!mask[i] && !outside[i]) { outside[i] = 1; q[tail++] = i; } };
    for (let x = x0; x <= x1; x++) { push(x, y0); push(x, y1); }
    for (let y = y0; y <= y1; y++) { push(x0, y); push(x1, y); }
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      if (x > x0) push(x - 1, y); if (x < x1) push(x + 1, y); if (y > y0) push(x, y - 1); if (y < y1) push(x, y + 1);
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (!outside[i] && !mask[i]) { mask[i] = 1; count++; } }

    // centroid, covariance, and which side touches the gingiva (pink just outside the outline)
    let cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0, nEdge = 0, gx = 0, gy = 0, gn = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * W + x]) { cx += x + 0.5; cy += y + 0.5; }
    cx /= count; cy /= count;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x; if (!mask[i]) continue;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      let edge = false;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || mask[ny * W + nx]) continue;
        edge = true;
        const px = x + ox * 3, py = y + oy * 3;                       // probe 3 px outside
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const j = py * W + px; get(j);
        if (Ac[j] > 15 && Lc[j] > 25) { gx += x + 0.5; gy += y + 0.5; gn++; }   // pink = gingiva
      }
      if (edge) nEdge++;
    }
    const gumVisible = gn >= Math.max(5, nEdge * 0.05);

    // long axis: toward the gingiva if it is visible, else principal axis pointing up on screen
    let u;
    if (gumVisible) u = [gx / gn - cx, gy / gn - cy];
    else { const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); u = [Math.cos(th), Math.sin(th)]; if (u[1] > 0) u = [-u[0], -u[1]]; }
    const ul = Math.hypot(u[0], u[1]) || 1; u = [u[0] / ul, u[1] / ul];
    let r = [-u[1], u[0]]; if (r[0] < 0) r = [-r[0], -r[1]];       // r points to screen right
    const tOf = i => (i % W + 0.5 - cx) * u[0] + (((i / W) | 0) + 0.5 - cy) * u[1];

    // translucent incisal enamel (grey / bluish, not dark, not pink) often fails the colour test: extend the crown
    // outward on the incisal side only, by at most 30 % of the crown length
    let tLo = Infinity, tHi = -Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (mask[i]) { const t = tOf(i); if (t < tLo) tLo = t; if (t > tHi) tHi = t; } }
    const tStop = tLo - 0.3 * (tHi - tLo);
    head = tail = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (mask[i] && tOf(i) < tLo + 3) q[tail++] = i; }
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx; if (mask[j]) continue;
        const t = tOf(j); if (t > tLo + 3 || t < tStop) continue;
        get(j);
        if (Lc[j] > 45 && Math.abs(Ac[j]) < 10 && Bc[j] < 8 && dPair(i, j) < 30) {   // grey-bluish only: not yellowish lower teeth
          mask[j] = 1; q[tail++] = j; count++;
          if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
        }
      }
    }

    // projections of all crown pixels + outline for display
    let tmin = Infinity, tmax = -Infinity, smin = Infinity, smax = -Infinity;
    const T = [], Sx = [], boundary = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x; if (!mask[i]) continue;
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, t = dx * u[0] + dy * u[1], s = dx * r[0] + dy * r[1];
      T.push(t); Sx.push(s);
      if (s < smin) smin = s; if (s > smax) smax = s;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) boundary.push([x + 0.5, y + 0.5]);
    }
    const sMid = (smin + smax) / 2, band = 0.2 * (smax - smin);
    let tl = 0, tln = 0, tr = 0, trn = 0;
    for (let k = 0; k < T.length; k++) {
      if (Math.abs(Sx[k] - sMid) < band) { if (T[k] < tmin) tmin = T[k]; if (T[k] > tmax) tmax = T[k]; }
      if (Sx[k] < smin + 1.5) { tl += T[k]; tln++; }
      if (Sx[k] > smax - 1.5) { tr += T[k]; trn++; }
    }
    tmin -= 0.5; tmax += 0.5; smin -= 0.5; smax += 0.5;               // pixel centre -> pixel edge
    const P = (t, s) => [cx + u[0] * t + r[0] * s, cy + u[1] * t + r[1] * s];
    const step = Math.max(1, Math.floor(boundary.length / 600));
    return {
      ok: true,
      incisal: P(tmin, sMid), gingival: P(tmax, sMid),
      left: P(tl / tln, smin), right: P(tr / trn, smax),
      boundary: boundary.filter((_, k) => k % step === 0),
      areaPx: count, gumVisible,
      // crowns are rarely > 2x taller than wide (lower incisors ~1.7); more usually means touching lower teeth were merged in
      suspicious: (tmax - tmin) > 2.0 * (smax - smin)
    };
  }

  const api = { detect, lab };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ToothAuto = api;
})(typeof window !== 'undefined' ? window : globalThis);
