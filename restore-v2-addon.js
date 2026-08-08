/* 2026-08-06 recovery additions: EP/TP review points + quad replay sync. */
(() => {
  const STORE_PREFIX = 'codelaggy.review-points.v1.';
  const ACTUAL_STORE = 'codelaggy.actual-trades.v1';
  let markerMode = null;
  let actualTrades = [];
  let actualTradesVisible = true;
  const style = document.createElement('style');
  style.textContent = `
    body.embed-mode #toolbar { display:none !important; }
    body.embed-mode #main { display:block !important; height:100vh; }
    body.embed-mode #main > .panel:not(#p10m), body.embed-mode #boardPanel, body.embed-mode #ayumiPanel, body.embed-mode .resizer { display:none !important; }
    body.embed-mode #p10m { display:block !important; position:absolute; inset:0; grid-area:auto !important; }
    #reviewPanel { position:fixed; z-index:600; right:10px; top:48px; width:min(390px,calc(100vw - 20px)); max-height:55vh; overflow:auto; display:none; padding:10px; border:1px solid #4f83ff; border-radius:6px; color:#d1d4dc; background:rgba(19,23,34,.97); box-shadow:0 10px 28px rgba(0,0,0,.5); font:12px system-ui,sans-serif; }
    #reviewPanel.open { display:block; } #reviewPanel h3 { margin:0 0 8px; color:#f6c85f; font-size:13px; }
    #reviewPanel .review-row { display:grid; grid-template-columns:64px 88px 1fr 24px; gap:6px; align-items:start; padding:7px 0; border-top:1px solid #2a2e39; }
    #reviewPanel .ep-buy { color:#42a5f5; } #reviewPanel .ep-sell { color:#ffb300; } #reviewPanel .tp { color:#26a69a; }
    #reviewPanel button { border:0; border-radius:3px; padding:2px 5px; background:#9c2f3a; color:#fff; cursor:pointer; }
  `;
  document.head.appendChild(style);
  const params = new URLSearchParams(location.search);
  if (params.get('embed') === '1') document.body.classList.add('embed-mode');
  function code() { return (document.getElementById('r2Symbol')?.value || currentSymbolCode || 'unknown').toUpperCase(); }
  function read() { try { return JSON.parse(localStorage.getItem(STORE_PREFIX + code()) || '[]'); } catch (_) { return []; } }
  function write(rows) { localStorage.setItem(STORE_PREFIX + code(), JSON.stringify(rows)); }
  function markerTime(entry, time) { return entry.tf.sec >= 86400 ? Math.floor(Number(time) / 86400) * 86400 : Number(time); }
  function displayBucket(entry, displayTime) {
    return toDisplay(bucketTimeUTC(Number(displayTime) - JST_OFFSET, entry.tf.sec));
  }
  function applyMultiDayView(days = 3) {
    requestAnimationFrame(() => charts.forEach(entry => {
      const scale = entry.chart.timeScale(); const count = entry.lastCandleCount || 0;
      if (!count) return;
      if (entry.tf.sec >= 86400) { scale.fitContent(); return; }
      const barsPerDay = entry.tf.sec === 15 ? 1600 : entry.tf.sec === 120 ? 210 : entry.tf.sec === 600 ? 44 : 250;
      scale.setVisibleLogicalRange({ from: Math.max(0, count - barsPerDay * days), to: count + 8 });
    }));
  }
  function applyOneDayView() {
    requestAnimationFrame(() => charts.forEach(entry => {
      const scale = entry.chart.timeScale(); const count = entry.lastCandleCount || 0;
      if (!count) return;
      if (entry.tf.sec >= 86400) { scale.fitContent(); return; }
      const barsPerDay = entry.tf.sec === 15 ? 1600 : entry.tf.sec === 120 ? 210 : entry.tf.sec === 600 ? 44 : 250;
      scale.setVisibleLogicalRange({ from: Math.max(0, count - barsPerDay), to: count + 8 });
    }));
  }
  function matchingActualTrades() { return actualTrades.filter(row => String(row.symbol_code) === code()); }
  function refreshMarkers() {
    const rows = read();
    charts.forEach(entry => {
      const markers = rows.map(row => ({ time: markerTime(entry, row.time), position: row.kind === 'TP' ? 'aboveBar' : row.side === 'SELL' ? 'aboveBar' : 'belowBar', color: row.kind === 'TP' ? '#26a69a' : row.side === 'SELL' ? '#ffb300' : '#42a5f5', shape: row.kind === 'TP' ? 'circle' : row.side === 'SELL' ? 'arrowDown' : 'arrowUp', text: row.kind === 'TP' ? 'TP' : `EP ${row.side}` }));
      if (actualTradesVisible) matchingActualTrades().forEach(row => {
        const buy = row.entry_side === 'BUY';
        markers.push({ time: displayBucket(entry, row.entry_display_time), position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#40a9ff' : '#ff9800', shape: buy ? 'arrowUp' : 'arrowDown', text: `IN ${buy ? 'BUY' : 'SELL'} ¥${Number(row.entry_price).toLocaleString()}` });
        markers.push({ time: displayBucket(entry, row.exit_display_time), position: buy ? 'aboveBar' : 'belowBar', color: '#ef5350', shape: 'circle', text: `OUT ¥${Number(row.exit_price).toLocaleString()}` });
      });
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      try { entry.candleSeries.setMarkers(markers); } catch (_) {}
    });
  }
  function setMode(next) { markerMode = markerMode === next ? null : next; setDrawMode(markerMode ? markerMode.toLowerCase() : null); document.getElementById('btnEP')?.classList.toggle('active', markerMode === 'EP'); document.getElementById('btnTP')?.classList.toggle('active', markerMode === 'TP'); }
  window.__reviewMarkerClick = (entry, price, time) => {
    const kind = markerMode === 'TP' ? 'TP' : 'EP';
    let side = 'BUY';
    if (kind === 'EP') { const answer = prompt('EPの方向を入力（BUY または SELL）', 'BUY'); if (answer == null) return; side = String(answer).trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY'; }
    const memo = prompt(`${kind}${kind === 'EP' ? ' ' + side : ''} のメモ（任意）`, '') ?? '';
    const rows = read(); rows.push({ id:`${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, side, price, time:Number(time), memo, createdAt:new Date().toISOString() }); write(rows); refreshMarkers(); renderReviewPanel(); setMode(null);
  };
  function formatTime(time) { return new Date(Number(time) * 1000).toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  function escapeText(value) { return String(value || '—').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function renderReviewPanel() {
    const panel = document.getElementById('reviewPanel'); if (!panel) return; const rows = read().sort((a,b) => b.time - a.time);
    panel.innerHTML = `<h3>${code()} — EP / TP 記録</h3>${rows.length ? rows.map(row => `<div class="review-row"><b class="${row.kind === 'TP' ? 'tp' : row.side === 'SELL' ? 'ep-sell' : 'ep-buy'}">${row.kind}${row.kind === 'EP' ? ' '+row.side : ''}</b><span>${formatTime(row.time)}<br>¥${Number(row.price).toLocaleString()}</span><span>${escapeText(row.memo)}</span><button data-id="${row.id}" title="削除">×</button></div>`).join('') : '<div>記録はありません。EP または TP を押してチャートをクリックします。</div>'}`;
    panel.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => { write(read().filter(row => row.id !== button.dataset.id)); refreshMarkers(); renderReviewPanel(); }));
  }
  const panel = document.createElement('aside'); panel.id = 'reviewPanel'; document.body.appendChild(panel);
  document.getElementById('btnEP')?.addEventListener('click', () => setMode('EP'));
  document.getElementById('btnTP')?.addEventListener('click', () => setMode('TP'));
  document.getElementById('btnActualTrades')?.addEventListener('click', event => { actualTradesVisible = !actualTradesVisible; event.currentTarget.classList.toggle('active', actualTradesVisible); refreshMarkers(); });
  document.getElementById('btnMultiDayView')?.addEventListener('click', () => applyMultiDayView(3));
  document.getElementById('btnOneDayView')?.addEventListener('click', applyOneDayView);
  document.getElementById('btnActualTradeImport')?.addEventListener('click', () => document.getElementById('actualTradeFile')?.click());
  document.getElementById('actualTradeFile')?.addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const text = await file.text(); const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/); const headers = lines.shift()?.split(',').map(x => x.trim()) || [];
    const parsed = lines.map(line => { const cols = line.match(/(?:"([^"]*(?:""[^"]*)*)"|([^,]*))(?:,|$)/g)?.map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || []; return Object.fromEntries(headers.map((key, i) => [key, cols[i] || ''])); }).filter(row => row.symbol_code && row.trade_date);
    const normalize = row => ({ ...row, symbol_code:String(row.symbol_code), entry_side:String(row.entry_side).toUpperCase(), entry_display_time:Date.parse(`${row.trade_date}T${row.entry_time}:00Z`) / 1000, exit_display_time:Date.parse(`${row.trade_date}T${row.exit_time}:00Z`) / 1000 });
    const merged = new Map(actualTrades.map(row => [row.id, row])); parsed.map(normalize).forEach(row => merged.set(row.id, row)); actualTrades = [...merged.values()]; localStorage.setItem(ACTUAL_STORE, JSON.stringify(actualTrades)); refreshMarkers(); alert(`${parsed.length}件の実取引を追加しました`); event.target.value = '';
  });
  document.getElementById('btnReviewList')?.addEventListener('click', () => { renderReviewPanel(); panel.classList.toggle('open'); });
  const originalRender = render; render = function recoveredRender() { originalRender(); refreshMarkers(); };
  const originalInitCharts = initCharts; initCharts = function recoveredInitCharts() { originalInitCharts(); refreshMarkers(); };
  const originalInitialChartView = applyInitialChartView;
  applyInitialChartView = function recoveredInitialChartView() {
    originalInitialChartView();
    const from = params.get('from'); const to = params.get('to');
    if (from && to && from !== to) setTimeout(() => applyMultiDayView(3), 80);
  };
  window.addEventListener('message', event => { if (event.data?.type === 'codelaggy-step') step(Number(event.data.delta) || 0); });
  if (window.parent !== window) window.addEventListener('keydown', event => { if (event.target.matches('input,select,textarea')) return; const key = event.key.toLowerCase(); if (key !== 'z' && key !== 'x') return; event.preventDefault(); event.stopImmediatePropagation(); window.parent.postMessage({ type:'codelaggy-quad-step', delta:key === 'z' ? -1 : 1 }, location.origin); }, true);
  (async () => {
    try { actualTrades = JSON.parse(localStorage.getItem(ACTUAL_STORE) || '[]'); } catch (_) {}
    if (!actualTrades.length) { try { actualTrades = await (await fetch('actual-trades.json', { cache:'no-store' })).json(); localStorage.setItem(ACTUAL_STORE, JSON.stringify(actualTrades)); } catch (_) {} }
    refreshMarkers();
  })();
  setTimeout(refreshMarkers, 1200);
})();
