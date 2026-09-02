(() => {
  "use strict";

  const doc = document.documentElement;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------------------------------------------------------------------
   * Theme toggle
   * ------------------------------------------------------------------- */
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = themeToggle.querySelector(".theme-toggle__icon");

  function applyTheme(theme) {
    if (theme === "light") {
      doc.setAttribute("data-theme", "light");
      themeIcon.textContent = "☀️";
      themeToggle.setAttribute("aria-label", "Switch to dark theme");
      themeToggle.setAttribute("aria-pressed", "true");
    } else {
      doc.setAttribute("data-theme", "dark");
      themeIcon.textContent = "🌙";
      themeToggle.setAttribute("aria-label", "Switch to light theme");
      themeToggle.setAttribute("aria-pressed", "false");
    }
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem("theme"); } catch (e) { /* ignore */ }
    if (stored === "light" || stored === "dark") {
      applyTheme(stored);
      return;
    }
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  }

  themeToggle.addEventListener("click", () => {
    const next = doc.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  });

  initTheme();

  /* ---------------------------------------------------------------------
   * Lissajous curve navigation
   * ------------------------------------------------------------------- */
  const sections = Array.from(document.querySelectorAll(".section:not(.section-clone)"));
  const popSections = Array.from(document.querySelectorAll(".section"));
  const basePath = document.getElementById("curve-path-base");
  const tracePath = document.getElementById("curve-path-trace");
  const marker = document.getElementById("curve-marker");
  const dotsContainer = document.getElementById("curve-dots");
  const homeSection = document.getElementById("home");
  const homeLoopSection = document.getElementById("home-loop");
  const contactSection = document.getElementById("contact");
  const contactLoopSection = document.getElementById("contact-loop");

  /* nx:ny = 3:2 Lissajous ratio with phase δ = k·(π/2), k = 2 (i.e. δ = π on
     the x axis, none on y — standard Lissajous notation). tOffset moves the
     curve's chosen start point (u = 0, where the Home dot sits) away from
     t = 0: for this ratio/phase combo the raw curve self-intersects at
     t = 0 and t = π, so starting exactly there would put a dot on top of a
     crossing (verified by rendering the un-offset version). z shares x's
     frequency (c: 3, matching a) but is 90° out of phase with it (dz: π/2
     vs dx: π) so it's never a fixed multiple of x or y — genuine depth, not
     a flat shape that just looks skewed as it rotates. perspective is kept
     low: even without any rotation, a nonzero z still pulls points nearer/
     farther from center, and at higher values that alone was enough to
     visibly warp the resting (unscrolled) shape — verified by rendering it
     at a few values. */
  const CURVE = {
    R: 38, cx: 50, cy: 50,
    a: 3, b: 2, c: 3,
    dx: Math.PI, dy: 0, dz: Math.PI / 2,
    tOffset: Math.PI / 4,
    numPoints: 320,
    /* Must be a whole number of turns — theta = progress * rotationTurns * 2π
       needs to land back on the same angle (mod 2π) at progress 1 as at
       progress 0, or the entire rotated curve visibly snaps to a different
       orientation at the seamless wrap instead of matching. A fractional
       value here was exactly that bug. */
    rotationTurns: 1,
    perspective: 0.05,
  };

  const TRACE_PALETTE = ["#38bdf8", "#f472b6", "#a78bfa", "#34d399", "#fbbf24"];
  let loopIndex = 0;

  /* The curve's own trace alternates between just these two colors — each
     completed loop's color becomes the *next* loop's color again (not a
     new one), so the pair keeps handing off to each other for continuity
     rather than marching through the full palette. The attractor still
     cycles through the full TRACE_PALETTE-driven ATTRACTOR_PALETTES below,
     independent of this. */
  const TRACE_COLORS = [TRACE_PALETTE[0], TRACE_PALETTE[1]];
  let traceColorIndex = 0;

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /* u is "distance traveled around the loop from the curve's chosen start
     point" (0..2π) — what scroll progress and section placement are driven
     by. t is the underlying trig phase (t = tOffset + u). Keeping the two
     separate lets tOffset move the start point off the self-crossing
     without disturbing the trace-so-far math, which compares u values. */
  function curveAtU(u) {
    const t = CURVE.tOffset + u;
    return {
      u,
      x: Math.sin(CURVE.a * t + CURVE.dx),
      y: Math.sin(CURVE.b * t + CURVE.dy),
      z: Math.sin(CURVE.c * t + CURVE.dz),
    };
  }

  function project(raw, theta) {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const xr = raw.x * cos + raw.z * sin;
    const zr = -raw.x * sin + raw.z * cos;
    const persp = 1 / (1 + zr * CURVE.perspective);
    return {
      u: raw.u,
      x: CURVE.cx + xr * CURVE.R * persp,
      y: CURVE.cy + raw.y * CURVE.R * persp,
    };
  }

  function pathFromPoints(points) {
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");
  }

  const rawPoints = [];
  for (let i = 0; i <= CURVE.numPoints; i++) {
    const u = (i / CURVE.numPoints) * Math.PI * 2;
    rawPoints.push(curveAtU(u));
  }

  /* Seamless wrap: #home-loop is a pixel-identical, inert copy of #home
     placed after Contact. wrapOffset is the scroll distance between the two —
     once scrollY reaches it, we silently subtract that same distance, landing
     back on the real Home at the exact same sub-position. Because the two
     sections render identically, nothing visibly changes: no jump, no zoom.
     sectionScrollable also drives dot placement below: each dot sits at the
     point on the curve reached when scroll actually arrives at that section,
     so dots land proportionally to how much content each section has rather
     than being spaced evenly by count. */
  let homeOffset = 0;
  let wrapOffset = 0;
  let sectionScrollable = 1;

  function measureLayout() {
    homeOffset = homeSection.offsetTop;
    wrapOffset = homeLoopSection.offsetTop - homeSection.offsetTop;
    sectionScrollable = Math.max(wrapOffset - window.innerHeight, 1);
  }
  measureLayout();

  function sectionU(section) {
    /* Cap below 1.0: a fraction of exactly 1 maps to the same point as
       fraction 0 (Home) — verified this collision live, Contact's dot was
       landing exactly on top of Home's. */
    const fraction = Math.min(0.94, Math.max(0, (section.offsetTop - homeOffset) / sectionScrollable));
    return fraction * Math.PI * 2;
  }

  function refreshDotPositions() {
    sections.forEach((section, i) => {
      dotRaws[i] = curveAtU(sectionU(section));
    });
  }

  const dotButtons = [];
  const dotLabels = [];
  const dotRaws = [];
  const dotLabelDirs = [];
  sections.forEach((section, i) => {
    dotRaws.push(curveAtU(sectionU(section)));

    /* Fixed compass direction per dot, evenly spaced — used to offset each
       label so it stays in a stable position relative to its dot instead of
       being recomputed from the live (rotating) projection, which gets
       numerically unstable whenever a dot swings close to the center. */
    const labelAngle = (i / sections.length) * Math.PI * 2 - Math.PI / 2;
    dotLabelDirs.push({ x: Math.cos(labelAngle), y: Math.sin(labelAngle) });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "curve-dot";
    btn.setAttribute("aria-label", `Go to ${section.dataset.title}`);
    btn.dataset.sectionId = section.id;
    btn.dataset.index = String(i);
    btn.addEventListener("click", () => {
      section.scrollIntoView({ behavior: prefersReducedMotion.matches ? "auto" : "smooth" });
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = dotButtons[(i + 1) % dotButtons.length];
        next.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = dotButtons[(i - 1 + dotButtons.length) % dotButtons.length];
        prev.focus();
      }
    });
    dotsContainer.appendChild(btn);
    dotButtons.push(btn);

    const label = document.createElement("span");
    label.className = "curve-dot-label";
    label.textContent = section.dataset.title;
    label.setAttribute("aria-hidden", "true");
    dotsContainer.appendChild(label);
    dotLabels.push(label);
  });

  function positionDot(index, projected) {
    const dir = dotLabelDirs[index];
    const labelX = Math.min(98, Math.max(2, projected.x + dir.x * 4.5));
    const labelY = Math.min(98, Math.max(2, projected.y + dir.y * 4.5));

    dotButtons[index].style.left = `${projected.x}%`;
    dotButtons[index].style.top = `${projected.y}%`;
    dotLabels[index].style.left = `${labelX}%`;
    dotLabels[index].style.top = `${labelY}%`;
  }

  function setTraceColor(hex) {
    doc.style.setProperty("--curve-trace", hex);
  }
  setTraceColor(TRACE_COLORS[traceColorIndex]);

  let isAutoScrolling = false;
  /* Scrolling up past Home only wraps back to Contact once a full forward
     loop has happened — before that, #contact-loop has no layout height
     (see .is-locked in style.css) so there's nothing to scroll into and
     this flag never even gets checked. */
  let hasCompletedFirstLoop = false;

  function updateCurveFromScroll() {
    if (isAutoScrolling) return;

    const relativeScrollY = window.scrollY - homeOffset;
    const progress = wrapOffset > 0 ? Math.min(1, Math.max(0, relativeScrollY / sectionScrollable)) : 0;
    const u = progress * Math.PI * 2;
    const theta = progress * CURVE.rotationTurns * Math.PI * 2;

    const projectedFull = rawPoints.map((r) => project(r, theta));
    basePath.setAttribute("d", pathFromPoints(projectedFull));

    const tracePoints = projectedFull.filter((p) => p.u <= u);
    const current = project(curveAtU(u), theta);
    tracePoints.push(current);
    tracePath.setAttribute("d", pathFromPoints(tracePoints));

    marker.setAttribute("cx", current.x.toFixed(2));
    marker.setAttribute("cy", current.y.toFixed(2));

    dotRaws.forEach((raw, i) => positionDot(i, project(raw, theta)));

    if (wrapOffset > 0 && relativeScrollY >= wrapOffset - 0.5) {
      wrapSeamlessly();
    } else if (hasCompletedFirstLoop && relativeScrollY < -0.5) {
      wrapBackward();
    }
  }

  function wrapSeamlessly() {
    isAutoScrolling = true;

    /* The just-finished loop's color becomes the new "idle" color for the
       base curve (the untraced portion, drawn behind the trace) instead of
       resetting to neutral gray — giving color continuity between loops.
       This works safely under rotation because basePath is already redrawn
       live every scroll tick in step with theta; unlike a frozen snapshot,
       there's no separate copy of the geometry to fall out of sync. */
    doc.style.setProperty("--curve-base", hexToRgba(TRACE_COLORS[traceColorIndex], 0.5));

    tracePath.setAttribute("d", "");

    /* Hand off to the *other* of the two trace colors — since there are
       only two, this always lands back on whichever one was used two loops
       ago, so the pair keeps recurring instead of cycling onward. */
    traceColorIndex = 1 - traceColorIndex;
    try { localStorage.setItem("traceColorIndex", String(traceColorIndex)); } catch (e) { /* ignore */ }
    setTraceColor(TRACE_COLORS[traceColorIndex]);

    loopIndex = (loopIndex + 1) % TRACE_PALETTE.length;
    try { localStorage.setItem("loopIndex", String(loopIndex)); } catch (e) { /* ignore */ }
    advanceAttractorPalette();

    if (!hasCompletedFirstLoop) {
      /* Unlocking gives #contact-loop real height, which pushes every
         offsetTop below it (including Home's) further down the page —
         remeasure before computing where "Home's top" now actually is. */
      hasCompletedFirstLoop = true;
      contactLoopSection.classList.remove("is-locked");
      measureLayout();
      refreshDotPositions();
    }

    const previousScrollBehavior = doc.style.scrollBehavior;
    doc.style.scrollBehavior = "auto";
    window.scrollTo(0, homeOffset);
    doc.style.scrollBehavior = previousScrollBehavior;

    homeSection.classList.add("is-active");

    requestAnimationFrame(() => {
      isAutoScrolling = false;
      updateCurveFromScroll();
    });
  }

  function wrapBackward() {
    isAutoScrolling = true;

    /* Land exactly on Contact's own top, same as the forward wrap always
       lands exactly on Home's top (homeOffset) rather than at whatever
       relative offset the crossing happened to occur at. Using
       window.scrollY + wrapOffset instead would snap you right up against
       the Home-loop boundary — barely inside Contact at all — because the
       trigger fires the instant relativeScrollY dips just under 0. */
    const previousScrollBehavior = doc.style.scrollBehavior;
    doc.style.scrollBehavior = "auto";
    window.scrollTo(0, contactSection.offsetTop);
    doc.style.scrollBehavior = previousScrollBehavior;

    contactSection.classList.add("is-active");

    requestAnimationFrame(() => {
      isAutoScrolling = false;
      updateCurveFromScroll();
    });
  }

  try {
    const storedLoop = parseInt(localStorage.getItem("loopIndex"), 10);
    if (!Number.isNaN(storedLoop) && storedLoop >= 0 && storedLoop < TRACE_PALETTE.length) {
      loopIndex = storedLoop;
    }
    const storedTraceColor = parseInt(localStorage.getItem("traceColorIndex"), 10);
    if (storedTraceColor === 0 || storedTraceColor === 1) {
      traceColorIndex = storedTraceColor;
      setTraceColor(TRACE_COLORS[traceColorIndex]);
    }
  } catch (e) { /* ignore */ }

  let scrollTicking = false;
  window.addEventListener("scroll", () => {
    if (!scrollTicking) {
      scrollTicking = true;
      requestAnimationFrame(() => {
        updateCurveFromScroll();
        scrollTicking = false;
      });
    }
  }, { passive: true });

  window.addEventListener("resize", () => {
    measureLayout();
    refreshDotPositions();
    updateCurveFromScroll();
  });
  updateCurveFromScroll();

  /* Active-section tracking: aria-current, pulse, label, pop-in boxes
     (popSections includes the hidden #home-loop clone so it also pops in
     as you scroll into it, keeping the illusion consistent right up to
     the seamless wrap).

     threshold is a fraction of the *target's own* area, not the viewport's —
     for a section taller than the viewport (e.g. Experience, which has far
     more cards than the others and grows tall on the narrow mobile layout),
     a fixed fraction like 0.3 of its own height can be mathematically
     unreachable, leaving it permanently un-toggled. Using threshold: 0 with
     a rootMargin that shrinks the root to a thin band around the viewport's
     vertical center instead triggers on crossing that band, independent of
     how tall the section itself is. */
  const SCROLLSPY_OPTS = { threshold: 0, rootMargin: "-45% 0px -45% 0px" };

  const popObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      entry.target.classList.toggle("is-active", entry.isIntersecting);
    });
  }, SCROLLSPY_OPTS);
  popSections.forEach((s) => popObserver.observe(s));

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const index = dotButtons.findIndex((b) => b.dataset.sectionId === entry.target.id);
      if (index === -1) return;
      const btn = dotButtons[index];
      if (entry.isIntersecting) {
        dotButtons.forEach((b) => b.removeAttribute("aria-current"));
        dotLabels.forEach((l) => l.classList.remove("is-current"));
        btn.setAttribute("aria-current", "true");
        dotLabels[index].classList.add("is-current");
        btn.classList.add("is-pulsing");
        setTimeout(() => btn.classList.remove("is-pulsing"), 500);
      }
    });
  }, SCROLLSPY_OPTS);

  sections.forEach((s) => sectionObserver.observe(s));

  document.getElementById("year").textContent = new Date().getFullYear();

  /* ---------------------------------------------------------------------
   * Strange attractor background — a different system each page load
   * ------------------------------------------------------------------- */
  const canvas = document.getElementById("attractor-canvas");
  const ctx = canvas.getContext("2d");

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /* Two families: 2D chaotic maps (De Jong, Clifford) iterate directly in the
     plane; the classic ODE systems (Lorenz, Rössler, Thomas, Aizawa) are
     integrated in 3D with small Euler substeps and then projected down to 2D.
     Every type exposes the same step()/project() interface so the render
     loop below doesn't need to know which system is active. */
  const ATTRACTOR_TYPES = [
    {
      name: "clifford",
      kind: "map",
      params: { a: -1.4, b: 1.6, c: 1.0, d: 0.7 },
      init: () => ({ x: rand(-1, 1), y: rand(-1, 1) }),
      step(p, params) {
        const nx = Math.sin(params.a * p.y) + params.c * Math.cos(params.a * p.x);
        const ny = Math.sin(params.b * p.x) + params.d * Math.cos(params.b * p.y);
        p.x = nx;
        p.y = ny;
      },
      project: (p) => ({ x: p.x, y: p.y }),
      burnIn: 60,
    },
    {
      name: "dejong",
      kind: "map",
      params: { a: -2, b: -2, c: -1.2, d: 2 },
      init: () => ({ x: rand(-1, 1), y: rand(-1, 1) }),
      step(p, params) {
        const nx = Math.sin(params.a * p.y) - Math.cos(params.b * p.x);
        const ny = Math.sin(params.c * p.x) - Math.cos(params.d * p.y);
        p.x = nx;
        p.y = ny;
      },
      project: (p) => ({ x: p.x, y: p.y }),
      burnIn: 60,
    },
    {
      name: "lorenz",
      kind: "ode3",
      params: { sigma: 10, rho: 28, beta: 8 / 3 },
      init: () => ({ x: rand(-1, 1) * 5, y: rand(-1, 1) * 5, z: 20 + rand(-1, 1) * 5 }),
      deriv(p, params) {
        return {
          dx: params.sigma * (p.y - p.x),
          dy: p.x * (params.rho - p.z) - p.y,
          dz: p.x * p.y - params.beta * p.z,
        };
      },
      dt: 0.008,
      substeps: 6,
      project: (p) => ({ x: p.x / 11, y: (p.z - 25) / 14 }),
      burnIn: 400,
    },
    {
      name: "rossler",
      kind: "ode3",
      params: { a: 0.2, b: 0.2, c: 5.7 },
      init: () => ({ x: rand(-1, 1) * 4, y: rand(-1, 1) * 4, z: rand(0, 1) * 4 }),
      deriv(p, params) {
        return {
          dx: -p.y - p.z,
          dy: p.x + params.a * p.y,
          dz: params.b + p.z * (p.x - params.c),
        };
      },
      dt: 0.02,
      substeps: 5,
      project: (p) => ({ x: p.x / 6, y: p.y / 6 }),
      burnIn: 500,
    },
    {
      name: "thomas",
      kind: "ode3",
      params: { b: 0.208186 },
      init: () => ({ x: rand(-1, 1) * 2, y: rand(-1, 1) * 2, z: rand(-1, 1) * 2 }),
      deriv(p, params) {
        return {
          dx: Math.sin(p.y) - params.b * p.x,
          dy: Math.sin(p.z) - params.b * p.y,
          dz: Math.sin(p.x) - params.b * p.z,
        };
      },
      dt: 0.05,
      substeps: 4,
      project: (p) => ({ x: p.x / 2.1, y: p.y / 2.1 }),
      burnIn: 500,
    },
    {
      name: "aizawa",
      kind: "ode3",
      params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 },
      /* Random small values often fall into this system's trivial fixed
         point at the origin instead of the chaotic attractor — seeding near
         the canonical (0.1, 0, 0) reliably lands particles on the attractor. */
      init: () => ({ x: 0.1 + rand(-0.05, 0.05), y: rand(-0.05, 0.05), z: rand(-0.05, 0.05) }),
      deriv(p, params) {
        const r2 = p.x * p.x + p.y * p.y;
        return {
          dx: (p.z - params.b) * p.x - params.d * p.y,
          dy: params.d * p.x + (p.z - params.b) * p.y,
          dz: params.c + params.a * p.z - (p.z ** 3) / 3 - r2 * (1 + params.e * p.z) + params.f * p.z * p.x ** 3,
        };
      },
      dt: 0.01,
      substeps: 5,
      project: (p) => ({ x: p.x / 0.85, y: (p.z - 0.6) / 0.85 }),
      burnIn: 600,
    },
  ];

  function pickAttractorType() {
    let lastIndex = -1;
    try { lastIndex = parseInt(localStorage.getItem("attractorTypeIndex"), 10); } catch (e) { /* ignore */ }
    let index = Math.floor(Math.random() * ATTRACTOR_TYPES.length);
    if (ATTRACTOR_TYPES.length > 1 && index === lastIndex) {
      index = (index + 1) % ATTRACTOR_TYPES.length;
    }
    try { localStorage.setItem("attractorTypeIndex", String(index)); } catch (e) { /* ignore */ }
    return ATTRACTOR_TYPES[index];
  }

  const attractorType = pickAttractorType();

  function stepParticle(p) {
    if (attractorType.kind === "map") {
      attractorType.step(p, attractorType.params);
      return;
    }
    const { dt, substeps, params } = attractorType;
    for (let s = 0; s < substeps; s++) {
      const d = attractorType.deriv(p, params);
      p.x += d.dx * dt;
      p.y += d.dy * dt;
      p.z += d.dz * dt;
    }
  }

  let particles = [];
  let attractorScale = 1;
  let attractorOffsetX = 0;
  let attractorOffsetY = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  /* Color pairs the attractor cycles through in step with the curve's own
     loop palette (see loopIndex / TRACE_PALETTE) — a new pair each time the
     seamless wrap completes a "turn". */
  const ATTRACTOR_PALETTES = [
    [[56, 132, 255], [239, 68, 68]],   // blue / red
    [[167, 139, 250], [52, 211, 153]], // violet / emerald
    [[251, 191, 36], [236, 72, 153]],  // amber / pink
    [[45, 212, 191], [248, 113, 113]], // teal / red
    [[96, 165, 250], [251, 146, 60]],  // sky / orange
  ];
  let attractorColorA = ATTRACTOR_PALETTES[0][0];
  let attractorColorB = ATTRACTOR_PALETTES[0][1];

  function advanceAttractorPalette() {
    const pair = ATTRACTOR_PALETTES[loopIndex % ATTRACTOR_PALETTES.length];
    attractorColorA = pair[0];
    attractorColorB = pair[1];
  }

  const PARTICLE_COUNT = 400;
  const TRAIL_LENGTH = 6;

  let stageWidth = 0;
  let stageHeight = 0;

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    stageWidth = rect.width;
    stageHeight = rect.height;
    canvas.width = stageWidth * dpr;
    canvas.height = stageHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scaleBasis = Math.min(stageWidth, stageHeight);
    attractorScale = scaleBasis / 3.0;
    attractorOffsetX = stageWidth / 2;
    attractorOffsetY = stageHeight / 2;
  }

  function snapshot(p) {
    return attractorType.kind === "map" ? { x: p.x, y: p.y } : { x: p.x, y: p.y, z: p.z };
  }

  function initParticles() {
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = attractorType.init();
      p.slot = i % 2;
      const burnIn = attractorType.burnIn + Math.floor(Math.random() * attractorType.burnIn * 0.3);
      for (let s = 0; s < burnIn; s++) stepParticle(p);
      p.history = [snapshot(p)];
      particles.push(p);
    }
  }

  function stepAndRecord(p) {
    stepParticle(p);
    p.history.push(snapshot(p));
    if (p.history.length > TRAIL_LENGTH) p.history.shift();
  }

  function drawPoint(raw, color, alpha, radius) {
    const proj = attractorType.project(raw);
    const px = attractorOffsetX + proj.x * attractorScale;
    const py = attractorOffsetY + proj.y * attractorScale;
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawParticle(p, alphaScale) {
    const color = p.slot === 0 ? attractorColorA : attractorColorB;
    const n = p.history.length;
    for (let i = 0; i < n; i++) {
      const age = (i + 1) / n; // 0 (oldest) .. 1 (current position)
      drawPoint(p.history[i], color, alphaScale * (0.12 + 0.88 * age * age), 0.9 + 1.1 * age);
    }
  }

  let rafId = null;
  let frameCount = 0;

  function animateAttractor() {
    frameCount++;
    if (frameCount % 3 === 0) {
      particles.forEach((p) => stepAndRecord(p));
    }
    ctx.clearRect(0, 0, stageWidth, stageHeight);
    particles.forEach((p) => drawParticle(p, 1));
    rafId = requestAnimationFrame(animateAttractor);
  }

  function drawStaticAttractor() {
    ctx.clearRect(0, 0, stageWidth, stageHeight);
    particles.forEach((p) => {
      for (let s = 0; s < 60; s++) {
        stepParticle(p);
        drawPoint(p, p.slot === 0 ? attractorColorA : attractorColorB, 0.25, 1.9);
      }
    });
  }

  function startAttractor() {
    if (rafId) cancelAnimationFrame(rafId);
    resizeCanvas();
    initParticles();
    if (prefersReducedMotion.matches) {
      drawStaticAttractor();
    } else {
      animateAttractor();
    }
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(startAttractor, 200);
  });

  prefersReducedMotion.addEventListener("change", startAttractor);

  startAttractor();
})();
