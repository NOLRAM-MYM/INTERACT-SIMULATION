/**
 * frontend/src/modules/shared/three-utils.js
 * ============================================
 * Lifecycle helpers shared by the five Three.js scenes.
 *
 * Every page rebuilds its scene on each solve, and the forms re-solve on a
 * 350 ms debounce — so a rebuild happens roughly per keystroke. Removing an
 * object from a scene only unlinks it; its geometry, material and textures stay
 * resident on the GPU until disposed explicitly. Four of the five scenes never
 * did that, so a few minutes of parameter tweaking leaked hundreds of buffers
 * and eventually stalled or lost the WebGL context.
 *
 * THREE is read from the global installed by the vendored <script> tag in the
 * templates (apps/core/static/core/vendor/three.min.js, r128), not imported
 * from npm — the npm package resolves to 0.166, ~38 revisions ahead, including
 * r155's redefinition of light intensity units.
 */

/**
 * Recursively release every GPU resource owned by an object and its children.
 *
 * Safe to call on `null`, and safe to call twice: three's `dispose()` is
 * idempotent. Does NOT remove the object from its parent — call
 * `scene.remove(obj)` first, or use `disposeAndRemove`.
 *
 * @param {THREE.Object3D|null} root
 */
export function disposeObject3D(root) {
  if (!root) return;

  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();

    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        // Textures are not reached by material.dispose() and leak separately.
        for (const key of Object.keys(material)) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      }
    }
  });
}

/**
 * Detach an object from its parent and release its GPU resources.
 *
 * @param {THREE.Scene|THREE.Object3D|null} parent
 * @param {THREE.Object3D|null} obj
 * @returns {null} so callers can write `this.mesh = disposeAndRemove(scene, this.mesh)`
 */
export function disposeAndRemove(parent, obj) {
  if (!obj) return null;
  if (parent) parent.remove(obj);
  disposeObject3D(obj);
  return null;
}

/**
 * Resize a renderer and camera to match the canvas's CSS box.
 *
 * `renderer.setSize(w, h)` defaults `updateStyle` to true, which writes
 * `style.width`/`style.height` in pixels onto the canvas — overwriting the
 * stylesheet's `width: 100%; height: 78vh`. Since the resize handlers measure
 * `canvas.offsetWidth`, they then read back the pixel value they just pinned,
 * so the viewport froze at whatever size the window had on first load and never
 * responded to the window or to a floating panel opening. Passing `false` keeps
 * CSS in charge of layout and lets the drawing buffer follow it.
 *
 * Memoized and null-tolerant, so it is safe both from a resize listener and
 * from inside an animation loop.
 *
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {THREE.PerspectiveCamera|null} camera
 * @param {HTMLCanvasElement|null} canvas
 * @returns {boolean} whether the size actually changed
 */
export function resizeRendererToCanvas(renderer, camera, canvas) {
  if (!renderer || !camera || !canvas) return false;

  // clientWidth, not offsetWidth: the stylesheet gives #three-canvas a 1px
  // border, and sizing the drawing buffer to the border box would stretch the
  // render by two pixels.
  //
  // Falling back to the parent covers the physics page, where switching tabs
  // hides a canvas — a hidden element measures 0, and resizing to 0 would blow
  // away the viewport's aspect before it is shown again.
  const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
  const height = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
  if (width === 0 || height === 0) return false;

  // Memoized, so this is cheap enough to call once per animation frame as well
  // as from a resize listener. That is what lets the per-frame `checkSize()`
  // copies the pages used to carry collapse into this one function.
  if (renderer.__syncedWidth === width && renderer.__syncedHeight === height) {
    return false;
  }
  renderer.__syncedWidth = width;
  renderer.__syncedHeight = height;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  return true;
}

/**
 * Drive an animation loop that can actually be stopped.
 *
 * The scenes previously called `requestAnimationFrame` directly and kept no
 * handle, so nothing could cancel a loop: a "paused" viewport still woke up 60
 * times a second, and pausing then resuming within one frame started a second
 * concurrent loop that made everything run at double speed for the rest of the
 * session. This also parks the loop while the tab is hidden, which the browser
 * throttles anyway but which otherwise keeps burning battery on a page nobody
 * is looking at.
 *
 * @param {() => void} onFrame — called once per animation frame while running
 * @returns {{start: () => void, stop: () => void, isRunning: () => boolean}}
 */
export function createAnimationLoop(onFrame) {
  let handle = null;
  // Whether the caller wants this loop running, kept separate from whether it
  // is running right now. Without the distinction, becoming visible again would
  // resume every loop on the page — including the ones a tab switch had
  // deliberately stopped, which on the physics page means two hidden 3D
  // viewports quietly restarting behind the visible one.
  let wanted = false;

  const tick = () => {
    // Schedule first so an exception in onFrame doesn't silently kill the loop.
    handle = requestAnimationFrame(tick);
    onFrame();
  };

  const resume = () => {
    if (handle !== null) return; // already running — do not stack a second loop
    handle = requestAnimationFrame(tick);
  };

  const suspend = () => {
    if (handle === null) return;
    cancelAnimationFrame(handle);
    handle = null;
  };

  const start = () => {
    wanted = true;
    if (!document.hidden) resume();
  };

  const stop = () => {
    wanted = false;
    suspend();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else if (wanted) resume();
  });

  return { start, stop, isRunning: () => handle !== null };
}
