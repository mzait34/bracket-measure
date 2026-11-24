# Bracket Measure (web, iPhone Safari / Android Chrome)

Live camera, no freezing. A printed ArUco marker of known size is tracked every frame; landmarks are stored in the
marker's plane (mm), so they stay pinned to the tooth while the phone moves. Pure static files, no build step.

## Use
1. Open `marker.html`, print at **100%**, measure the black square with a ruler, enter that value in Settings.
2. Tape the marker flat next to the tooth, in the same plane as the facial surface. Phone ~15-25 cm away, roughly perpendicular.
3. Start camera. Touch the screen at: Incisal edge, Gingival margin, Mesial, Distal (a magnifier shows what is under your finger;
   lift to place). Press on an existing point and drag to correct it. Aiming the centre circle and pressing `+` also works.
4. Crown height/width and the bracket position (default middle/middle, or a fixed mm height from the incisal edge) are shown in mm.

## Guide cards (recommended)
Print `bracket-grid-cards-A4.pdf` (100%): each 60x40 mm card has the marker (20 mm) and a 1/5/10 mm grid. Keep Settings > marker size = 20.
With "Show guide-card grid overlay" on, the app draws a cyan copy of the printed grid over the live view; if it sits on the printed
lines, scale and tracking are right (if not, check print scale / marker size).

## Frame card (most accurate)
Print `bracket-frame-cards-A4.pdf` (100%): 94x62 mm card with 4 markers (ids 11-14, 14 mm) at the corners and a 50x50 mm window with mm ticks.
Cut the window and hold the card flat against the teeth so the tooth is inside the window: the scale and plane are then fitted
(least squares) from all visible markers and the tooth is *between* them (interpolation, not extrapolation). Works with 1-4 markers visible.
The marker-size setting is ignored in this mode. Do not mix cards during one measurement.

## Fixed-distance mode (tripod, no marker each time)
1. Mount the phone on a tripod at the working distance, show a marker/frame card, open Settings and press **Save current scale**.
2. Settings > Scale mode > **Fixed scale**. The scale is saved on the phone; the marker is no longer needed.
3. A dashed **1:1 guide box** (default 20 mm, adjustable) is drawn at the saved scale: hold a real object of that size
   at the tooth's plane and move the phone until it matches the box.
4. Whenever a marker is visible the status line says **move CLOSER / FARTHER / distance matches** (compared with the saved scale) - use it to return to the calibrated distance.
Assumes the camera stays perpendicular to the tooth and at the saved distance (points do not follow if the phone moves).
Tests: `node web/test/run_fixed_e2e.js <static.y4m> [nomarker]`, `node web/test/run_drag_e2e.js <static.y4m>` (drag to correct a point).

## Host it (iPhone camera needs HTTPS)
- Easiest: drag the `web/` folder onto https://app.netlify.com/drop
- Or from a Mac: `cd web && npx serve -l 8080` and, in another terminal, a tunnel such as `npx localtunnel --port 8080`; open the https URL on the iPhone.

## Tests (run in this repo's dev container)
- `node web/test/tooth.test.js` – homography + planning math.
- `python3 web/test/make_scene.py <bits.json> <dir> [static]` then `node web/test/run_e2e.js <dir>/scene.y4m [shot.png]` –
  Chromium with a fake camera plays a synthetic moving scene (marker + tooth with known 18 x 14 mm dots).

## Limits
Measurements are exact only for points in the marker plane; teeth are curved and sit a few mm off it, so treat results as
estimates and validate against a caliper before clinical use. Lens distortion is not corrected. Real-camera jitter is not covered by the synthetic test.
