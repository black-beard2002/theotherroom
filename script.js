(() => {
  'use strict';

  // ---------- Scene constants (all distances in reference px: the 1536 × 1024 design) ----------
  const REF_W = 1536, REF_H = 1024;
  const P = 2200;            // CSS perspective distance
  const FACE_W = 600, FACE_H = 450;   // card faces are 600 × 450 (the 4:3 project images), scaled into place
  const FLOOR = 390;         // floor plane for the soft contact shadows (below the scene centre)
  const DEG = Math.PI / 180;
  const KNOT_OFFSET = { x: -18, y: 10 };                     // knot centre relative to the scene centre
  const FOCUS_Z = 420, FOCUS_Y = -24;                        // where a focused card hangs, square to the viewer
  const AXIS = [0, -Math.sin(30 * DEG), Math.cos(30 * DEG)]; // orbit axis: the view axis tipped back 30°
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Home poses. Focus-plane cards were solved from the reference's measured corners
  // (max 3px error at P = 2200). Out-of-focus cards use the screen centre (sx, sy) and width (sw)
  // read off the reference, pushed to depth z — depth drives their blur.
  const POSES = {
    clap:         { x: -196, y: -277, z: 0, rx: 28.7, ry: 33.6, rz: -0.2, w: 241 },
    iris:         { x: 203,  y: -283, z: 0, rx: 27.9, ry: -27.8, rz: 2.2, w: 226 },
    yamas:        { x: -416, y: -76,  z: 0, rx: 15.3, ry: 48.8, rz: -0.2, w: 263 },
    skybar:       { x: 419,  y: -15,  z: 0, rx: 17,   ry: -51.8, rz: 1.8, w: 252 },
    humburg:      { x: -191, y: 278,  z: 0, rx: 34.4, ry: 36.8, rz: -0.5, w: 257 },
    functionalab: { x: 175,  y: 247,  z: 0, rx: 33.1, ry: -28.9, rz: -1.3, w: 273 },
    madamebun:    { sx: 410,  sy: 312, sw: 130, z: -380, rx: 25, ry: 45,  rz: 8 },
    platsduchef:  { sx: 1222, sy: 297, sw: 135, z: -260, rx: 24, ry: -34, rz: -9 },
    loq:          { sx: 1068, sy: 408, sw: 125, z: -420, rx: 14, ry: -30, rz: -4 },
    lyne:         { sx: 340,  sy: 637, sw: 180, z: 210,  rx: 20, ry: 34,  rz: 6 },
    fleurdelys:   { sx: 800,  sy: 697, sw: 80,  z: -650, rx: 22, ry: 8,   rz: 2 },
    hoof:         { sx: 1230, sy: 702, sw: 150, z: -260, rx: 20, ry: -30, rz: -5 },
  };

  // ---------- Math helpers ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const approach = (rate, dt) => 1 - Math.pow(1 - rate, dt);   // frame-rate independent easing
  const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
  const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  function rotAxis(p, k, a) {   // Rodrigues' rotation of p about unit axis k
    const c = Math.cos(a), s = Math.sin(a);
    const d = (k[0] * p[0] + k[1] * p[1] + k[2] * p[2]) * (1 - c);
    return [
      p[0] * c + (k[1] * p[2] - k[2] * p[1]) * s + k[0] * d,
      p[1] * c + (k[2] * p[0] - k[0] * p[2]) * s + k[1] * d,
      p[2] * c + (k[0] * p[1] - k[1] * p[0]) * s + k[2] * d,
    ];
  }
  const blurAt = (z) => Math.min(4.5, Math.max(0, Math.abs(z) - 90) * 0.015);  // depth of field
  const facing = (x) => -40 * Math.tanh(x / 260);   // cards turn toward the centre as they orbit

  // ---------- DOM ----------
  const stage = document.getElementById('stage');
  const scene = document.getElementById('scene');
  const caption = document.getElementById('caption');

  const cards = [...scene.querySelectorAll('.card')].map((el, i) => {
    const p = POSES[el.dataset.id];
    if (p.sx !== undefined) {
      const k = P / (P - p.z);
      Object.assign(p, { x: (p.sx - REF_W / 2) / k, y: (p.sy - REF_H / 2) / k, w: p.sw / (k * Math.cos(p.ry * DEG)) });
    }
    const shadow = document.createElement('span');
    shadow.className = 'shadow';
    scene.insertBefore(shadow, scene.querySelector('.card'));
    const c = {
      el, shadow, pose: p,
      phase: i * 1.7,
      stiff: 0.05 + (i % 5) * 0.012,
      isHover: false, hover: 0, focus: 0,
      lean: { x: 0, y: 0, z: 0 }, push: { x: 0, y: 0, z: 0 },
      lastBlur: -1, lastOpacity: -1,
    };
    el.addEventListener('pointerenter', () => { c.isHover = true; });
    el.addEventListener('pointerleave', () => { c.isHover = false; });
    el.addEventListener('click', (e) => { e.stopPropagation(); setFocus(focused === c ? null : c); });
    return c;
  });

  // ---------- State ----------
  const pointer = { x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0, inside: false, moved: false };
  const smooth = { x: 0, y: 0, vx: 0, vy: 0 };
  const drag = { active: false, moved: false, x0: 0, y0: 0, lastX: 0, lastT: 0 };
  let theta = 0, thetaV = 0;
  let focused = null, focusAmt = 0;
  let s = 1;            // reference px → CSS px
  let knot = null;

  function setFocus(c) {
    focused = c;
    stage.classList.toggle('is-focus', !!c);
    caption.classList.toggle('is-on', !!c);
    for (const o of cards) o.el.setAttribute('aria-pressed', String(o === c));
  }

  // on-screen width of a focused card: nearly full width on phones, a comfortable size elsewhere
  const focusWidth = () => innerWidth < 760
    ? Math.min(innerWidth * 0.95, innerHeight * 0.7 * FACE_W / FACE_H)
    : Math.min(innerWidth * 0.62, innerHeight * 0.56 * FACE_W / FACE_H, 900);

  function resize() {
    const vw = innerWidth, vh = innerHeight;
    s = vw < 760 ? Math.min(vw / 760, vh / 1150) : Math.min(vw / REF_W, vh / REF_H);
    stage.style.perspective = `${P * s}px`;
    // the close hint sits just under the focused card
    const bottom = vh / 2 + FOCUS_Y * s * (P / (P - FOCUS_Z)) + (focusWidth() * FACE_H) / FACE_W / 2;
    caption.style.top = `${Math.round(bottom + 14)}px`;
    if (knot) knot.resize(vw, vh, s);
  }

  // ---------- Per-frame ----------
  function updateCard(c, t, dt, ax, ay) {
    const p = c.pose;
    const bob = reduceMotion ? 0 : Math.sin(t * 0.7 + c.phase) * 7;

    // orbit, then drift toward the pointer (nearer cards more), then tilt with the pointer
    let v = rotAxis([p.x, p.y + bob, p.z], AXIS, theta);
    const depth = 1 + v[2] / 900;
    v[0] += smooth.x * 16 * depth;
    v[1] += smooth.y * 11 * depth;
    v = rotX(rotY(v, ay), ax);

    // lean into the pointer's direction of travel; each card lags at its own stiffness
    const lk = approach(c.stiff, dt);
    c.lean.y += (clamp(smooth.vx * 320, -16, 16) - c.lean.y) * lk;
    c.lean.x += (clamp(-smooth.vy * 260, -12, 12) - c.lean.x) * lk;
    c.lean.z += (clamp(-smooth.vx * 140, -8, 8) - c.lean.z) * lk;

    // make room around the cursor
    let tx = 0, ty = 0, tz = 0;
    if (pointer.inside && !focused && !drag.moved) {
      const persp = P / (P - v[2]);
      const dx = v[0] * persp * s - (pointer.x - innerWidth / 2);
      const dy = v[1] * persp * s - (pointer.y - innerHeight / 2);
      const d = Math.hypot(dx, dy), r0 = 240 * s;
      if (d < r0 && d > 0.001) {
        const f = (1 - d / r0) ** 2;
        tx = (dx / d) * f * 34; ty = (dy / d) * f * 34; tz = f * 30;
      }
    }
    const pk = approach(0.08, dt);
    c.push.x += (tx - c.push.x) * pk;
    c.push.y += (ty - c.push.y) * pk;
    c.push.z += (tz - c.push.z) * pk;
    c.hover += ((c.isHover && !focused ? 1 : 0) - c.hover) * approach(0.12, dt);
    c.focus += ((focused === c ? 1 : 0) - c.focus) * approach(0.085, dt);

    let x = v[0] + c.push.x, y = v[1] + c.push.y, z = v[2] + c.push.z + c.hover * 60;
    let rx = p.rx + smooth.y * 7 + c.lean.x;
    let ry = p.ry + facing(x) - facing(p.x) + smooth.x * 10 + c.lean.y;
    let rz = p.rz + c.lean.z;
    let scale = (p.w / FACE_W) * (1 + c.hover * 0.05);
    let blur = blurAt(z) * (1 - c.hover);
    let opacity = 1 - Math.min(0.3, Math.max(0, -z - 250) * 0.0006);

    if (focused && focused !== c) { blur += 5 * focusAmt; opacity *= 1 - 0.72 * focusAmt; }
    if (c.focus > 0.001) {          // fly to the front, square to the viewer
      const f = smoothstep(clamp(c.focus, 0, 1));
      const fp = P / (P - FOCUS_Z);
      const fs = focusWidth() / (FACE_W * fp * s);
      x = lerp(x, 0, f); y = lerp(y, FOCUS_Y, f); z = lerp(z, FOCUS_Z, f);
      rx = lerp(rx, smooth.y * 4, f); ry = lerp(ry, smooth.x * 6, f); rz = lerp(rz, 0, f);
      scale = lerp(scale, fs, f); blur = lerp(blur, 0, f); opacity = lerp(opacity, 1, f);
    }

    const k = scale * s;
    c.el.style.transform =
      `translate3d(${(x * s).toFixed(2)}px,${(y * s).toFixed(2)}px,${(z * s).toFixed(2)}px) ` +
      `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) ` +
      `scale3d(${k.toFixed(4)},${k.toFixed(4)},${k.toFixed(4)})`;

    // filter radius is in the card's local space, so undo the scale + perspective that will shrink it
    const screenBlur = blur * s;
    const localBlur = screenBlur < 0.4 ? 0 : Math.round((screenBlur / (k * (P / (P - z)))) * 4) / 4;
    if (localBlur !== c.lastBlur) { c.el.style.filter = localBlur ? `blur(${localBlur}px)` : 'none'; c.lastBlur = localBlur; }
    if (Math.abs(opacity - c.lastOpacity) > 0.004) { c.el.style.opacity = opacity.toFixed(3); c.lastOpacity = opacity; }

    // soft contact shadow on the floor, stronger the closer the card hangs to it
    const bottom = y + (FACE_H * scale) / 2;
    const near = clamp(1 - (FLOOR - bottom) / 380, 0, 1);
    const shadowOp = near * near * 0.65 * (1 - c.focus) * (1 - 0.6 * focusAmt);
    const sw = (FACE_W * scale * 1.05 * s) / 200, sd = (FACE_W * scale * 0.8 * s) / 200;
    c.shadow.style.transform = `translate3d(${(x * s).toFixed(2)}px,${(FLOOR * s).toFixed(2)}px,${(z * s).toFixed(2)}px) rotateX(90deg) scale(${sw.toFixed(3)},${sd.toFixed(3)})`;
    c.shadow.style.opacity = shadowOp.toFixed(3);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last) / 16.667;   // in 60fps frames
    last = now;
    const t = now / 1000;

    const px = smooth.x, py = smooth.y;
    const mk = approach(0.075, dt);
    smooth.x += (pointer.nx - smooth.x) * mk;
    smooth.y += (pointer.ny - smooth.y) * mk;
    smooth.vx = (smooth.x - px) / dt;
    smooth.vy = (smooth.y - py) / dt;

    if (!drag.active) { theta += thetaV * dt; thetaV *= Math.pow(0.93, dt); }
    focusAmt += ((focused ? 1 : 0) - focusAmt) * approach(0.09, dt);

    const ax = -smooth.y * 5 * DEG, ay = smooth.x * 8 * DEG;
    for (const c of cards) updateCard(c, t, dt, ax, ay);

    if (knot) {
      if (pointer.moved) {
        pointer.moved = false;
        const overCard = cards.some((c) => c.isHover);
        stage.classList.toggle('is-knot-hover', !focused && !overCard && !drag.moved && knot.hit(pointer.x, pointer.y));
      }
      knot.update(t, dt, smooth.x, smooth.y, theta);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Input ----------
  function setPointer(e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.nx = (e.clientX / innerWidth) * 2 - 1;
    pointer.ny = (e.clientY / innerHeight) * 2 - 1;
    pointer.inside = true; pointer.moved = true;
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    setPointer(e);
    Object.assign(drag, { active: true, moved: false, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastT: performance.now() });
  });

  addEventListener('pointermove', (e) => {
    setPointer(e);
    if (!drag.active) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) {
      drag.moved = true;
      stage.classList.add('is-dragging');
      if (focused) setFocus(null);
    }
    if (drag.moved) {
      const now = performance.now();
      const d = ((e.clientX - drag.lastX) * 0.005) / Math.max(s, 0.4);
      theta += d;
      thetaV = d / Math.max(1, (now - drag.lastT) / 16.667);
      drag.lastT = now;
    }
    drag.lastX = e.clientX;
  });

  addEventListener('pointerup', (e) => {
    if (drag.active) { drag.active = false; stage.classList.remove('is-dragging'); }
    if (e.pointerType !== 'mouse') { pointer.nx = pointer.ny = 0; pointer.inside = false; }
  });
  addEventListener('pointercancel', () => { drag.active = false; stage.classList.remove('is-dragging'); });
  document.documentElement.addEventListener('pointerleave', () => { pointer.nx = pointer.ny = 0; pointer.inside = false; });

  // a drag that ends over a card must not also open it
  addEventListener('click', (e) => { if (drag.moved) { e.stopPropagation(); e.preventDefault(); } }, true);

  stage.addEventListener('click', (e) => {
    if (focused) { setFocus(null); return; }
    if (knot && knot.hit(e.clientX, e.clientY)) knot.poke();
  });

  addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
    thetaV = clamp(thetaV + clamp(d, -120, 120) * 0.00011, -0.08, 0.08);
    if (focused) setFocus(null);
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && focused) setFocus(null);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') thetaV += 0.012;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') thetaV -= 0.012;
  });

  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  // ---------- The red knot (three.js, loaded on demand) ----------
  async function initKnot() {
    const canvas = document.getElementById('knot');
    const [THREE, { GLTFLoader }, { DRACOLoader }, { RGBELoader }] = await Promise.all([
      import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/RGBELoader.js'),
    ]);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;

    const scene3 = new THREE.Scene();
    // the studio around the logo, recovered from the logo's product shots: each reflection seen in those photos was
    // traced back to the direction it came from (128 × 64 equirect, camera looking down -Z)
    const studio = await new RGBELoader().loadAsync('assets/r-logo-env.hdr');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene3.environment = pmrem.fromEquirectangular(studio).texture;
    studio.dispose();
    pmrem.dispose();
    const camera = new THREE.PerspectiveCamera(30, 1, 10, 20000);

    // The "R": a light copy of the sculpted GLB (same geometry, Draco-compressed), finished as glossy red chrome
    const LOGO_H = 355;      // on-screen height in reference px, same as the earlier procedural R
    const FRONT_YAW = 355, FRONT_TILT = -2;   // resting view (deg), matched to the logo's main product shot
    const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('assets/r-logo.glb');
    draco.dispose();
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    const fit = new THREE.Group();
    fit.add(model);
    fit.scale.setScalar(LOGO_H / box.getSize(new THREE.Vector3()).y);
    fit.rotation.y = FRONT_YAW * DEG;
    let mesh;
    model.traverse((o) => { if (o.isMesh) mesh = o; });
    // colour, metal, gloss and coat fitted to the product shots under the studio above
    mesh.material.dispose();
    mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xef0c00, metalness: 0.975, roughness: 0.02, clearcoat: 0.25, clearcoatRoughness: 0.03 });
    const body = new THREE.Group();
    body.add(fit);
    const holder = new THREE.Group();
    holder.add(body);
    scene3.add(holder);

    let sc = 1, spin = 0, spinV = 0, wobble = 0;
    const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), ray = new THREE.Ray(), inv = new THREE.Matrix4();

    return {
      resize(w, h, scale) {
        sc = scale;
        renderer.setSize(w, h, false);
        Object.assign(canvas.style, { width: `${w}px`, height: `${h}px`, left: `${-w / 2}px`, top: `${-h / 2}px` });
        camera.aspect = w / h;
        camera.fov = (2 * Math.atan(h / 2 / (P * sc))) / DEG;   // same projection as the CSS perspective
        camera.position.set(0, 0, P * sc);
        camera.updateProjectionMatrix();
        holder.scale.setScalar(sc);
      },
      update(t, dt, mx, my, th) {
        spin += spinV * dt;
        spinV *= Math.pow(0.95, dt);
        wobble *= Math.pow(0.94, dt);
        const idle = reduceMotion ? 0 : 1;
        holder.rotation.set(FRONT_TILT * DEG + my * 0.35 + Math.sin(t * 0.5) * 0.03 * idle, mx * 0.5 + th * 0.35 + spin, Math.sin(t * 0.4) * 0.025 * idle);
        holder.position.set(KNOT_OFFSET.x * sc, (-KNOT_OFFSET.y + Math.sin(t * 0.8) * 5 * idle) * sc, 0);
        const w = Math.sin(t * 16) * 0.07 * wobble;
        body.scale.set(1 + w, 1 - w, 1 + w * 0.5);
        renderer.render(scene3, camera);
      },
      hit(x, y) {
        ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        // ponytail: tests the model's bounding box, not its ~2M triangles (a full raycast costs tens of ms per pointer move),
        // so the poke cursor also shows in the box's empty corners; add a low-poly hit proxy if that matters
        return ray.copy(raycaster.ray).applyMatrix4(inv.copy(mesh.matrixWorld).invert()).intersectsBox(mesh.geometry.boundingBox);
      },
      poke() { spinV += 0.22; wobble = 1; },
    };
  }

  initKnot()
    .then((k) => { knot = k; resize(); })
    .catch((err) => console.warn('3D knot unavailable:', err));
})();
