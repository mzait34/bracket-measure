/* Pure math (no DOM): planar homography + tooth measurement + bracket planning. All lengths in mm. */
(function (root) {
  'use strict';

  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /** 3x3 homography (row-major, 9 numbers) mapping 4 src points to 4 dst points. */
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function invertH(H) {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [A, -(b * i - c * h), b * f - c * e,
            B, a * i - c * g, -(a * f - c * d),
            C, -(a * h - b * g), a * e - b * d].map(v => v / det);
  }

  const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
  const norm = p => { const l = Math.hypot(p[0], p[1]) || 1; return [p[0] / l, p[1] / l]; };

  /** L = {incisal, gingival, mesial, distal}: [x,y] in the marker plane (mm). */
  function measure(L) {
    const inc = L.incisal, gin = L.gingival, mes = L.mesial, dis = L.distal;
    const u = norm(sub(gin, inc));                    // incisal -> gingival
    const md = sub(dis, mes);
    const k = dot(md, u);
    const r = norm([md[0] - k * u[0], md[1] - k * u[1]]); // mesial -> distal, orthogonal to u
    const mid = [(mes[0] + dis[0]) / 2, (mes[1] + dis[1]) / 2];
    const m = {
      origin: inc, u, r,
      height: dot(sub(gin, inc), u),
      width: dot(md, r),
      offset: dot(sub(mid, inc), r),
    };
    /** v: 0 incisal..1 gingival, h: 0 mesial..1 distal */
    m.at = (v, h) => {
      const up = v * m.height, side = m.offset + (h - 0.5) * m.width;
      return [inc[0] + u[0] * up + r[0] * side, inc[1] + u[1] * up + r[1] * side];
    };
    return m;
  }

  const V = { incisal: 0.25, middle: 0.5, gingival: 0.75 };
  const H = { mesial: 0.25, middle: 0.5, distal: 0.75 };

  /** fixedMm > 0 overrides the vertical choice (distance from the incisal edge). */
  function plan(m, vKey, hKey, fixedMm) {
    const v = fixedMm > 0 ? Math.min(1, fixedMm / Math.max(m.height, 1e-6)) : V[vKey];
    return { point: m.at(v, H[hKey]), mmFromIncisal: v * m.height };
  }

  const api = { homography, applyH, invertH, measure, plan, V, H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Tooth = api;
})(typeof window !== 'undefined' ? window : globalThis);
