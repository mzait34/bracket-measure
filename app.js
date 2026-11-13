/* Live tooth measurement: tracks a printed ArUco marker every frame, so landmarks (stored in the
   marker plane, mm) stay pinned to the tooth while the phone moves. No frame freezing. */
(function () {
  'use strict';
  const { homographyLS, applyH, invertH, measure, plan } = Tooth;
  const $ = id => document.getElementById(id);
  const canvas = $('view'), ctx = canvas.getContext('2d');
  const video = $('cam');
  const det = document.createElement('canvas'), dctx = det.getContext('2d', { willReadFrequently: true });
  const detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });

  const STEPS = ['incisal', 'gingival', 'mesial', 'distal'];
  const LABEL = { incisal: 'INCISAL EDGE', gingival: 'GINGIVAL MARGIN', mesial: 'MESIAL point', distal: 'DISTAL point' };
  const COLOR = { incisal: '#ff4d4d', gingival: '#4dff88', mesial: '#4da6ff', distal: '#ffd24d' };

  const S = { running: false, dpr: 1, cw: 0, ch: 0, s: 1, ox: 0, oy: 0, vw: 0, vh: 0 };
  let H = null, Hinv = null, lastSeen = 0;
  const L = {};                 // landmarks in marker-plane mm
  let result = null;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  ['markerMm', 'markerId', 'vKey', 'hKey', 'fixedMm'].forEach(id => {
    $(id).value = store.get('bm_' + id, $(id).value);
    $(id).addEventListener('change', () => { store.set('bm_' + id, $(id).value); compute(); });
  });
  $('cardGuide').checked = store.get('bm_cardGuide', '1') === '1';
  $('cardGuide').addEventListener('change', () => store.set('bm_cardGuide', $('cardGuide').checked ? '1' : '0'));
  const markerMm = () => Math.max(1, parseFloat($('markerMm').value) || 20);

  // ---------- camera ----------
  async function startCamera(demo) {
    $('err').textContent = '';
    S.demo = demo === true;
    try {
      if (S.demo) { video.srcObject = null; video.src = 'demo.mp4'; video.loop = true; }
      else { const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      video.srcObject = stream; }
      await video.play();
      $('start').hidden = true;
      S.running = true;
      requestAnimationFrame(loop);
    } catch (e) {
      $('err').textContent = 'Camera error: ' + (e && e.message || e) + '. Allow camera access (HTTPS required).';
    }
  }
  $('startBtn').addEventListener('click', () => startCamera(false));
  $('demoBtn').addEventListener('click', () => startCamera(true));

  // ---------- geometry helpers ----------
  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = window.innerWidth, ch = window.innerHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    S.dpr = dpr; S.cw = cw; S.ch = ch;
    S.vw = video.videoWidth; S.vh = video.videoHeight;
    S.s = (S.demo ? Math.min : Math.max)(cw / S.vw, ch / S.vh);   // camera: cover, demo video: contain
    S.ox = (cw - S.vw * S.s) / 2; S.oy = (ch - S.vh * S.s) / 2;
  }
  const toScreen = (x, y) => [x * S.s + S.ox, y * S.s + S.oy];
  const toVideo = (x, y) => [(x - S.ox) / S.s, (y - S.oy) / S.s];
  const planeToScreen = p => { const v = applyH(H, p[0], p[1]); return toScreen(v[0], v[1]); };
  const screenToPlane = (x, y) => { const v = toVideo(x, y); return applyH(Hinv, v[0], v[1]); };
  const markerOk = () => !!H && performance.now() - lastSeen < 400;

  // ---------- marker tracking ----------
  // Frame card (bracket-frame-cards-A4.pdf): 4 markers (ids 11-14, black square 14 mm) at the corners of a 94x62 mm card,
  // given as black-square top-left corners in card mm (y down). The tooth sits in the window between them.
  const FRAME = { 11: [4, 4], 12: [76, 4], 13: [4, 44], 14: [76, 44] }, FRAME_SIDE = 14;
  const WINDOW = { x0: 22, y0: 6, x1: 72, y1: 56 };
  let mode = 'single', outlines = [];
  const prev = {};                                       // last corners per marker id (for jitter smoothing)

  function smooth(id, c) {   // smooth only tiny (jitter-sized) motion; real motion passes through with no lag
    const p = prev[id];
    if (p) {
      let d = 0;
      for (let i = 0; i < 4; i++) d += Math.hypot(c[i][0] - p[i][0], c[i][1] - p[i][1]) / 4;
      const a = d < 0.8 ? 0.3 : 1;                       // weight of the new measurement
      if (a < 1) for (let i = 0; i < 4; i++) c[i] = [p[i][0] * (1 - a) + c[i][0] * a, p[i][1] * (1 - a) + c[i][1] * a];
    }
    prev[id] = c;
    return c;
  }

  function detect() {
    const dw = Math.min(960, S.vw), dh = Math.round(S.vh * dw / S.vw);
    if (det.width !== dw || det.height !== dh) { det.width = dw; det.height = dh; }
    dctx.drawImage(video, 0, 0, dw, dh);
    const found = detector.detect(dctx.getImageData(0, 0, dw, dh));
    const k = S.vw / dw;
    const best = {};                                     // best detection per id; look-alike false positives are ignored
    found.forEach(m => { if ((m.id in FRAME || m.id === parseInt($('markerId').value, 10)) && (!best[m.id] || m.hammingDistance < best[m.id].hammingDistance)) best[m.id] = m; });
    const frameIds = Object.keys(best).filter(i => i in FRAME);
    const singleId = parseInt($('markerId').value, 10);
    const hasLandmarks = STEPS.some(s => L[s]);
    let want = frameIds.length ? 'frame' : (best[singleId] ? 'single' : null);
    if (hasLandmarks) want = mode;                       // landmarks are stored in one plane: never switch mid-measurement
    if (!want) return;
    const src = [], dst = [], used = [];
    const add = (id, plane) => {
      if (!best[id]) return;
      const c = smooth(id, best[id].corners.map(p => [p.x * k, p.y * k]));
      used.push(c);
      for (let i = 0; i < 4; i++) { src.push(plane[i]); dst.push(c[i]); }
    };
    if (want === 'frame') {
      frameIds.forEach(id => { const [x, y] = FRAME[id], s = FRAME_SIDE; add(+id, [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]); });
    } else {
      const m = markerMm(); add(singleId, [[0, 0], [m, 0], [m, m], [0, m]]);   // plane mm -> video px
    }
    if (!used.length) return;
    const h = homographyLS(src, dst), hi = h && invertH(h);
    if (h && hi) { H = h; Hinv = hi; mode = want; outlines = used; lastSeen = performance.now(); }
  }

  // ---------- landmarks ----------
  const nextStep = () => STEPS.find(s => !L[s]);

  function placeAtScreen(x, y) {
    if (!markerOk()) return false;
    return placeAtPlane(screenToPlane(x, y));
  }
  function placeAtPlane(p) {
    const step = nextStep();
    if (!step) return false;
    L[step] = [p[0], p[1]];
    compute(); updateUI();
    return true;
  }
  function undo() {
    for (let i = STEPS.length - 1; i >= 0; i--) if (L[STEPS[i]]) { delete L[STEPS[i]]; break; }
    compute(); updateUI();
  }
  function clearAll() { STEPS.forEach(s => delete L[s]); compute(); updateUI(); }

  function compute() {
    result = null;
    if (!STEPS.every(s => L[s])) return;
    const m = measure(L);
    const fixed = parseFloat($('fixedMm').value) || 0;
    const pl = plan(m, $('vKey').value, $('hKey').value, fixed);
    result = { m, point: pl.point, mmFromIncisal: pl.mmFromIncisal };
    updateUI();
  }

  function updateUI() {
    const step = nextStep();
    $('hint').textContent = !S.running ? $('hint').textContent
      : !markerOk() && step ? 'Show the printed marker card to the camera first'
      : step ? 'Aim the + at the ' + LABEL[step] + ' and press +' : 'Done – bracket planned';
    $('plus').disabled = !step || !markerOk();
    const r = $('result');
    if (result) {
      const hk = fixedLabel();
      r.hidden = false;
      r.textContent = 'Crown height: ' + result.m.height.toFixed(1) + ' mm\n' +
        'Crown width: ' + result.m.width.toFixed(1) + ' mm\n' +
        'Bracket: ' + hk + '\n= ' + result.mmFromIncisal.toFixed(1) + ' mm from incisal edge';
    } else r.hidden = true;
  }
  function fixedLabel() {
    const f = parseFloat($('fixedMm').value) || 0;
    return (f > 0 ? 'fixed ' + f + ' mm' : $('vKey').value) + ' / ' + $('hKey').value;
  }

  // ---------- drawing ----------
  function text(t, x, y, color) {
    ctx.font = '600 14px -apple-system,system-ui,sans-serif';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(t, x, y);
    ctx.fillStyle = color || '#fff'; ctx.fillText(t, x, y);
  }
  function line(a, b, color, w) {
    ctx.strokeStyle = color; ctx.lineWidth = w || 2; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }
  function dot(p, color) {
    ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fill(); ctx.stroke();
  }

  function draw() {
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.cw, S.ch);
    ctx.drawImage(video, S.ox, S.oy, S.vw * S.s, S.vh * S.s);

    if (H) {
      const ok = markerOk();
      outlines.forEach(corners => {
        ctx.beginPath();
        corners.forEach((c, i) => { const p = toScreen(c[0], c[1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
        ctx.closePath(); ctx.strokeStyle = ok ? '#5df08f' : '#ff7b7b'; ctx.lineWidth = 2; ctx.stroke();
      });
    }
    if (H) {
      const P = {};
      STEPS.forEach(s => { if (L[s]) P[s] = planeToScreen(L[s]); });
      const seg = (a, b) => {
        if (!P[a] || !P[b]) return;
        line(P[a], P[b], '#ffffff', 2);
        const mm = dist(L[a], L[b]);
        text(mm.toFixed(1) + ' mm', (P[a][0] + P[b][0]) / 2 + 8, (P[a][1] + P[b][1]) / 2 - 8);
      };
      seg('incisal', 'gingival'); seg('mesial', 'distal');
      STEPS.forEach(s => P[s] && dot(P[s], COLOR[s]));
      if (result) {                                   // bracket pad ~3x3 mm aligned with the tooth axes
        const { m, point } = result, h = 1.5;
        const q = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([a, b]) => planeToScreen([
          point[0] + m.r[0] * a + m.u[0] * b, point[1] + m.r[1] * a + m.u[1] * b]));
        ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
        ctx.fillStyle = 'rgba(40,200,255,.55)'; ctx.fill(); ctx.strokeStyle = '#7fe3ff'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    // Virtual copy of the printed guide-card grid (see test/make_card_sheet.py): 25x25 mm, its bottom-left corner sits at
    // (27, 20) mm in marker coordinates (marker black square = 0..20 mm, y pointing down). If it lies on the printed grid, scale is right.
    if (H && markerOk() && $('cardGuide').checked && mode === 'frame') {   // window outline + 5 mm grid of the frame card
      ctx.save();
      for (let x = Math.ceil(WINDOW.x0 / 5) * 5; x <= WINDOW.x1; x += 5) line(planeToScreen([x, WINDOW.y0]), planeToScreen([x, WINDOW.y1]), 'rgba(0,220,255,.45)', 1);
      for (let y = Math.ceil(WINDOW.y0 / 5) * 5; y <= WINDOW.y1; y += 5) line(planeToScreen([WINDOW.x0, y]), planeToScreen([WINDOW.x1, y]), 'rgba(0,220,255,.45)', 1);
      const w = [[WINDOW.x0, WINDOW.y0], [WINDOW.x1, WINDOW.y0], [WINDOW.x1, WINDOW.y1], [WINDOW.x0, WINDOW.y1]].map(planeToScreen);
      ctx.beginPath(); w.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.strokeStyle = 'rgba(0,220,255,.95)'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.restore();
    } else if (H && markerOk() && $('cardGuide').checked && mode === 'single' && Math.abs(markerMm() - 20) < 0.05) {
      const gx = 27, gy0 = -5, G = 25;
      ctx.save(); ctx.lineCap = 'butt';
      for (let i = 0; i <= G; i += 5) {
        ctx.strokeStyle = i % 10 === 0 ? 'rgba(0,220,255,.95)' : 'rgba(0,220,255,.55)'; ctx.lineWidth = i % 10 === 0 ? 1.6 : 1;
        const v1 = planeToScreen([gx + i, gy0]), v2 = planeToScreen([gx + i, gy0 + G]);
        const h1 = planeToScreen([gx, gy0 + G - i]), h2 = planeToScreen([gx + G, gy0 + G - i]);
        line(v1, v2, ctx.strokeStyle, ctx.lineWidth); line(h1, h2, ctx.strokeStyle, ctx.lineWidth);
      }
      ctx.restore();
    }
    // reticle at screen center
    const cx = S.cw / 2, cy = S.ch / 2, ok = markerOk();
    ctx.strokeStyle = ok ? '#fff' : 'rgba(255,255,255,.4)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 7); ctx.stroke();
    ctx.fillStyle = ok ? '#fff' : 'rgba(255,255,255,.4)'; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 7); ctx.fill();
  }

  // ---------- main loop ----------
  let n = 0;
  function loop() {
    if (S.running) requestAnimationFrame(loop);
    if (video.readyState < 2 || !video.videoWidth) return;
    layout();
    detect();
    draw();
    const ok = markerOk();
    const st = $('status');
    st.textContent = !ok ? 'Marker: not found' : mode === 'frame' ? 'Frame card: ' + outlines.length + '/4 markers' : 'Marker: OK (' + markerMm() + ' mm)';
    st.className = 'chip ' + (ok ? 'ok' : 'bad');
    if ((n++ & 7) === 0) updateUI();
    const hook = window.__bracket && window.__bracket.onFrame;     // test hook: runs on the exact frame just processed
    if (hook) hook({ det, k: S.vw / det.width, H, markerOk: ok });
  }

  // ---------- input ----------
  $('plus').addEventListener('click', () => placeAtScreen(S.cw / 2, S.ch / 2));
  $('undo').addEventListener('click', undo);
  $('clear').addEventListener('click', clearAll);
  canvas.addEventListener('click', e => placeAtScreen(e.clientX, e.clientY));   // tap anywhere also works

  // Test / debugging hook
  window.__bracket = {
    L, placeAtPlane, placeAtScreen, undo, clearAll, markerOk,
    result: () => result, planeToScreen: p => planeToScreen(p), toScreen, toVideo,
    state: () => ({ outlines, mode, H, running: S.running })
  };
  updateUI();
})();
