/* ===== Layout switcher & resizable dividers ===== */

(function () {
  const main = document.getElementById('main');
  const layoutSelect = document.getElementById('layoutSelect');
  const btnReset = document.getElementById('btnResetLayout');

  // Default sizes per layout (CSS var values)
  // Board & ayumi columns are ~1.5x wider than before (200→300)
  const DEFAULTS = {
    a: { '--col-daily': '320px', '--col-a': '1.75fr', '--col-b': '0.85fr', '--col-c': '280px', '--col-d': '270px', '--row-1': '1.05fr', '--row-2': '0.95fr' },
    b: { '--col-daily': '320px', '--col-a': '2.00fr', '--col-b': '0.90fr', '--col-c': '280px', '--col-d': '270px', '--row-1': '1.05fr', '--row-2': '0.95fr' },
    c: { '--col-daily': '320px', '--col-a': '2.00fr', '--col-b': '0.90fr', '--col-c': '280px', '--col-d': '270px', '--row-1': '1.05fr', '--row-2': '0.95fr' },
    d: { '--col-daily': '300px', '--col-a': '2.00fr', '--col-b': '0.90fr', '--col-c': '280px', '--col-d': '270px', '--row-1': '1.05fr', '--row-2': '0.95fr' },
    e: { '--col-daily': '300px', '--col-a': '0.85fr', '--col-b': '1.70fr', '--col-c': '0px', '--col-d': '0px', '--row-1': '1fr', '--row-2': '1fr' },
    f: { '--col-daily': '300px', '--col-a': '0.85fr', '--col-b': '1.70fr', '--col-c': '0px', '--col-d': '0px', '--row-1': '1fr', '--row-2': '1fr' },
  };

  let currentLayout = null;

  function applyDefaults(layout) {
    const d = DEFAULTS[layout] || DEFAULTS.b;
    for (const k in d) main.style.setProperty(k, d[k]);
  }

  function setLayout(layout) {
    const previousLayout = currentLayout;
    main.classList.remove('layout-a', 'layout-b', 'layout-c', 'layout-d', 'layout-e', 'layout-f');
    main.classList.add('layout-' + layout);
    currentLayout = layout;
    applyDefaults(layout);
    updateResizerVisibility(layout);
    if (layout === 'e' && window.__applyLayoutEPreset) {
      window.__applyLayoutEPreset();
    } else if (layout === 'f' && window.__applyLayoutTradePreset) {
      window.__applyLayoutTradePreset();
    } else if ((previousLayout === 'e' || previousLayout === 'f') && window.__restoreStandardTimeframes) {
      window.__restoreStandardTimeframes();
    }
    // Reflow charts and reposition resizers after CSS applies
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      positionResizers();
    });
  }

  function updateResizerVisibility(layout) {
    // v3 only exists between col-c and col-d (layout-b and layout-d: both have board+ayumi columns)
    document.getElementById('rz-v3').style.display = (layout === 'b' || layout === 'd') ? '' : 'none';
    // v2 exists in layout a, b, d (chart/right-col boundary)
    document.getElementById('rz-v2').style.display = (layout === 'c' || layout === 'e' || layout === 'f') ? 'none' : '';
    // v1: charts a/b boundary — in layout-d p2m spans both chart cols, so hide it
    document.getElementById('rz-v1').style.display = (layout === 'd' || layout === 'e' || layout === 'f') ? 'none' : '';
    // h1 always visible
  }

  layoutSelect.addEventListener('change', () => {
    setLayout(layoutSelect.value);
    if (/^https?:$/.test(location.protocol)) {
      const url = new URL(location.href);
      url.searchParams.set('layout', layoutSelect.value);
      history.replaceState(null, '', url);
    }
  });
  btnReset.addEventListener('click', () => setLayout(layoutSelect.value));

  // ===== Position resizers based on actual panel rects =====
  function positionResizers() {
    const mainRect = main.getBoundingClientRect();
    const rz = {
      v1: document.getElementById('rz-v1'),
      v2: document.getElementById('rz-v2'),
      v3: document.getElementById('rz-v3'),
      h1: document.getElementById('rz-h1'),
    };
    // v1: boundary between col-a and col-b → right edge of p2m
    const p2m = document.getElementById('p2m').getBoundingClientRect();
    rz.v1.style.left = (p2m.right - mainRect.left) + 'px';
    // v2: right edge of p5m (boundary to right column)
    const p5m = document.getElementById('p5m').getBoundingClientRect();
    rz.v2.style.left = (p5m.right - mainRect.left) + 'px';
    // v3: right edge of boardPanel
    const bp = document.getElementById('boardPanel').getBoundingClientRect();
    if (rz.v3.style.display !== 'none') {
      rz.v3.style.left = (bp.right - mainRect.left) + 'px';
    }
    // h1: bottom edge of top row (p2m bottom)
    const hBoundary = (main.classList.contains('layout-e') || main.classList.contains('layout-f'))
      ? document.getElementById('p1d').getBoundingClientRect().bottom
      : p2m.bottom;
    rz.h1.style.top = (hBoundary - mainRect.top) + 'px';
  }

  // Reposition after any window resize
  window.addEventListener('resize', () => requestAnimationFrame(positionResizers));

  // ===== Drag handlers =====
  function startDrag(e, kind) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.classList.add('dragging');
    const mainRect = main.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const isVertical = kind.startsWith('v');
    document.body.classList.add('resizing', isVertical ? 'resizing-v' : 'resizing-h');

    // Snapshot current grid template sizes in px
    const cs = getComputedStyle(main);
    const cols = cs.gridTemplateColumns.split(' ').map(s => parseFloat(s));
    const rows = cs.gridTemplateRows.split(' ').map(s => parseFloat(s));

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const layout = main.classList.contains('layout-b') ? 'b' :
                     main.classList.contains('layout-c') ? 'c' :
                     main.classList.contains('layout-d') ? 'd' : 'a';
      const activeLayout = main.classList.contains('layout-e') ? 'e' : layout;

      // In layout-d the grid has a leading --col-daily column, so indices shift by 1
      const off = (activeLayout === 'd') ? 1 : 0;

      if (kind === 'v1') {
        // Adjust col-a (cols[off]) by +dx, col-b (cols[off+1]) by -dx
        const newA = Math.max(200, cols[off] + dx);
        const newB = Math.max(120, cols[off + 1] - dx);
        main.style.setProperty('--col-a', newA + 'px');
        main.style.setProperty('--col-b', newB + 'px');
      } else if (kind === 'v2') {
        // Between col-b and col-c
        const newB = Math.max(120, cols[off + 1] + dx);
        const newC = Math.max(100, cols[off + 2] - dx);
        main.style.setProperty('--col-b', newB + 'px');
        main.style.setProperty('--col-c', newC + 'px');
      } else if (kind === 'v3') {
        // Between col-c and col-d
        const newC = Math.max(100, cols[off + 2] + dx);
        const newD = Math.max(100, cols[off + 3] - dx);
        main.style.setProperty('--col-c', newC + 'px');
        main.style.setProperty('--col-d', newD + 'px');
      } else if (kind === 'h1') {
        const newR1 = Math.max(100, rows[0] + dy);
        const newR2 = Math.max(100, rows[1] - dy);
        main.style.setProperty('--row-1', newR1 + 'px');
        main.style.setProperty('--row-2', newR2 + 'px');
      }

      positionResizers();
      // Throttled resize (raf)
      if (!window.__resizeRaf) {
        window.__resizeRaf = requestAnimationFrame(() => {
          window.__resizeRaf = null;
          window.dispatchEvent(new Event('resize'));
        });
      }
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v', 'resizing-h');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.dispatchEvent(new Event('resize'));
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  ['v1', 'v2', 'v3', 'h1'].forEach(kind => {
    const el = document.getElementById('rz-' + kind);
    el.addEventListener('mousedown', (e) => startDrag(e, kind));
  });

  // ===== Floating Daily panel: click to expand / shrink =====
  const daily = document.getElementById('p1d');
  if (daily) {
    daily.addEventListener('click', (e) => {
      if (main.classList.contains('layout-d') || main.classList.contains('layout-e') || main.classList.contains('layout-f')) return;
      // Prevent clicks on the embedded chart from bubbling and toggling
      // (lightweight-charts absorbs clicks when expanded, so only react to
      // clicks on the panel itself, the label, or the hint)
      if (e.target !== daily && !e.target.classList.contains('panel-label')
          && !e.target.classList.contains('expand-hint')) {
        return;
      }
      daily.classList.toggle('expanded');
      // After CSS transition, notify chart to resize
      setTimeout(() => window.dispatchEvent(new Event('resize')), 280);
    });
  }

  // Daily corner position selector
  const dailyCornerSel = document.getElementById('dailyCorner');
  const dailyEl = document.getElementById('p1d');
  function setDailyCorner(corner) {
    if (!dailyEl) return;
    ['corner-bl', 'corner-br', 'corner-tl', 'corner-tr'].forEach(c => dailyEl.classList.remove(c));
    dailyEl.classList.add('corner-' + corner);
    // Charts may need resize after repositioning
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  if (dailyCornerSel) {
    dailyCornerSel.addEventListener('change', () => setDailyCorner(dailyCornerSel.value));
    setDailyCorner(dailyCornerSel.value);
  }

  // Initial apply: URL can request a shareable preset, otherwise layout-b.
  const requestedLayout = new URLSearchParams(location.search).get('layout');
  const initialLayout = ['a', 'b', 'c', 'd', 'e', 'f'].includes(requestedLayout) ? requestedLayout : 'b';
  layoutSelect.value = initialLayout;
  setLayout(initialLayout);
  // Position after first paint
  setTimeout(positionResizers, 100);
  setTimeout(positionResizers, 300); // re-run after charts mount
})();
