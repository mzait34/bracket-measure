/* Live tooth measurement: tracks a printed ArUco marker every frame, so landmarks (stored in the
   marker plane, mm) stay pinned to the tooth while the phone moves. No frame freezing. */
(function () {
  'use strict';
  const { homography, applyH, invertH, measure, plan } = Tooth;
  const $ = id => document.getElementById(id);
  const canvas = $('view'), ctx = canvas.getContext('2d');
  const video = $('cam');
  const det = document.createElement('canvas'), dctx = det.getContext('2d', { willReadFrequently: true });
  const detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12' });

  const STEPS = ['incisal', 'gingival', 'mesial', 'distal'];
  const LABEL = { incisal: 'INCISAL EDGE', gingival: 'GINGIVAL MARGIN', mesial: 'MESIAL point', distal: 'DISTAL point' };
  const COLOR = { incisal: '#ff4d4d', gingival: '#4dff88', mesial: '#4da6ff', distal: '#ffd24d' };

  const S = { running: false, dpr: 1, cw: 0, ch: 0, s: 1, ox: 0, oy: 0, vw: 0, vh: 0 };
  let corners = null, H = null, Hinv = null, lastSeen = 0;
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
  function detect() {
    const dw = Math.min(960, S.vw), dh = Math.round(S.vh * dw / S.vw);
    if (det.width !== dw || det.height !== dh) { det.width = dw; det.height = dh; }
    dctx.drawImage(video, 0, 0, dw, dh);
    const img = dctx.getImageData(0, 0, dw, dh);
    const found = detector.detect(img);
    const id = parseInt($('markerId').value, 10);
    const ok = found.filter(m => m.id === id);           // ignore look-alike false positives
    if (!ok.length) return;
    ok.sort((a, b) => a.hammingDistance - b.hammingDistance);
    const k = S.vw / dw;
    const c = ok[0].corners.map(p => [p.x * k, p.y * k]);
    if (corners) {   // smooth only tiny (jitter-sized) motion; real motion passes through with no lag
      let d = 0;
      for (let i = 0; i < 4; i++) d += Math.hypot(c[i][0] - corners[i][0], c[i][1] - corners[i][1]) / 4;
      const a = d < 0.8 ? 0.3 : 1;                  // weight of the new measurement
      if (a < 1) for (let i = 0; i < 4; i++) c[i] = [corners[i][0] * (1 - a) + c[i][0] * a, corners[i][1] * (1 - a) + c[i][1] * a];
    }
    corners = c;
    const m = markerMm();
    const h = homography([[0, 0], [m, 0], [m, m], [0, m]], corners);   // plane mm -> video px
    const hi = h && invertH(h);
    if (h && hi) { H = h; Hinv = hi; lastSeen = performance.now(); }
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

    if (H && corners) {
      const ok = markerOk();
      ctx.beginPath();
      corners.forEach((c, i) => { const p = toScreen(c[0], c[1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath(); ctx.strokeStyle = ok ? '#5df08f' : '#ff7b7b'; ctx.lineWidth = 2; ctx.stroke();
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
    st.textContent = ok ? 'Marker: OK (' + markerMm() + ' mm)' : 'Marker: not found';
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
    state: () => ({ corners, H, running: S.running })
  };
  updateUI();
})();
