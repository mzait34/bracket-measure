# Bracket Measure (web, iPhone Safari / Android Chrome)

Live camera, no freezing. A printed ArUco marker of known size is tracked every frame; landmarks are stored in the
marker's plane (mm), so they stay pinned to the tooth while the phone moves. Pure static files, no build step.

## Use
1. Open `marker.html`, print at **100%**, measure the black square with a ruler, enter that value in Settings.
2. Tape the marker flat next to the tooth, in the same plane as the facial surface. Phone ~15-25 cm away, roughly perpendicular.
3. Start camera. Aim the `+` and press it for: Incisal edge, Gingival margin, Mesial, Distal (tapping the screen also places a point).
4. Crown height/width and the bracket position (default middle/middle, or a fixed mm height from the incisal edge) are shown in mm.

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
