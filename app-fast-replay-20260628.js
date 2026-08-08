/* ===== Tick → Multi-TF Candle Viewer v3 ===== */

// ---------- state ----------
let ticks = [];          // [{time: unix_sec (UTC), price, volume}, ...] sorted asc
let cursor = 0;
let replaySeriesCache = null; // pre-aggregated candles/VWAP for fast Z/X replay
let autoPlay = null;
let drawMode = null;     // null | 'hline' | 'ray' | 'rr'
let drawnLines = [];     // [{price, type, pricelines:[]}]
window.__drawnLines = drawnLines;  // expose for board.js color matching
let crosshairSyncEnabled = true;
let __syncingCrosshair = false;    // reentrancy guard
let vwapVisible = true;
let vwapColor = '#2962ff';  // default: blue
let vwapLabelVisible = false;
let volumeCandleEnabled = true;
let boardProfileVisible = true;
let executedProfileVisible = false;
let executedProfileLabelsVisible = false;
let followMode = false;  // default OFF: do not auto-scroll to right edge
let autoReplayOnLoad = true;
let multiSymbolDataset = null; // { symbols:[{code,name,ticks,master}], sourceName, dateLabel }
let currentSymbolCode = null;
let singleChartMode = false;
let activeChartPanelId = 'p10m';
let symbolSearchIndex = 0;

// RR tool state
let rrClicks = [];       // collecting up to 3 prices: [entry, sl, tp]
let rrCurrent = null;    // current RR overlay: {entry, sl, tp, items:[]}

// ---------- constants ----------
const JST_OFFSET = 9 * 3600;  // +9h in seconds

// ---------- charts ----------
const TF = [
  { key: '2m',  sec: 120,   el: 'p2m'  },
  { key: '10m', sec: 600,   el: 'p5m'  },   // slot renamed: now 10分足
  { key: '15s', sec: 15,    el: 'p10m' },   // slot renamed: now 15秒足
  { key: '1d',  sec: 86400, el: 'p1d'  },   // floating daily
];

const charts = [];   // [{chart, candleSeries, volumeSeries, vwapSeries, tf}]

const SYMBOL_NAME_FALLBACKS = window.JP_STOCK_SYMBOLS || {};

const CANDLE_COLORS = {
  up: '#00e676',
  down: '#ff5252',
};
const VOLUME_CANDLE_OPEN_SECONDS = 9 * 3600;
const VOLUME_CANDLE_CLOSE_SECONDS = 15 * 3600 + 30 * 60;
const VOLUME_CANDLE_HIGHLIGHT_PERCENTILE = 0.85;
const AUCTION_CANDLE_COLOR = '#ffd54f';
const STANDARD_CANDLE_OPTIONS = {
  upColor: CANDLE_COLORS.up,
  downColor: CANDLE_COLORS.down,
  borderUpColor: CANDLE_COLORS.up,
  borderDownColor: CANDLE_COLORS.down,
  wickUpColor: CANDLE_COLORS.up,
  wickDownColor: CANDLE_COLORS.down,
};
const HIDDEN_CANDLE_OPTIONS = {
  upColor: 'rgba(0,0,0,0)',
  downColor: 'rgba(0,0,0,0)',
  borderUpColor: 'rgba(0,0,0,0)',
  borderDownColor: 'rgba(0,0,0,0)',
  wickUpColor: 'rgba(0,0,0,0)',
  wickDownColor: 'rgba(0,0,0,0)',
};
const boardProfileTfKeys = new Set(['2m', '10m']);
const executedProfileTfKeys = new Set(['2m', '10m']);

// ============================================================
//  TIME HELPERS
//  Lightweight Charts renders timestamps as UTC.
//  To display JST on the axis we store "fake UTC" = real UTC + 9h.
//  All internal tick.time values stay as real UTC.
//  toDisplay() converts real UTC → fake UTC for chart data.
// ============================================================
function toDisplay(utcSec) {
  return utcSec + JST_OFFSET;
}

// Session open = 09:00 JST of the tick's calendar day (JST).
function sessionOpenUTC(utcSec) {
  const jstSec = utcSec + JST_OFFSET;
  const dayStart = Math.floor(jstSec / 86400) * 86400; // midnight JST as UTC-equiv
  return dayStart - JST_OFFSET; // back to real UTC: midnight JST in UTC = dayStart - 9h
  // 09:00 JST = dayStart - JST_OFFSET + 9*3600 = dayStart
  // Actually let's be precise:
  // midnight JST in UTC = dayStart - JST_OFFSET
  // 09:00 JST in UTC = dayStart - JST_OFFSET + 9*3600 = dayStart
}

// Bucket time in real UTC, aligned to 09:00 JST
function bucketTimeUTC(utcSec, tfSec) {
  if (tfSec === 604800) {
    const jstSec = utcSec + JST_OFFSET;
    const dayStart = Math.floor(jstSec / 86400) * 86400;
    const weekday = new Date(dayStart * 1000).getUTCDay(); // Sunday=0
    const mondayStart = dayStart - ((weekday + 6) % 7) * 86400;
    return mondayStart - JST_OFFSET;
  }
  if (tfSec >= 86400) {
    // daily: bucket = midnight JST → as real UTC
    const jstSec = utcSec + JST_OFFSET;
    const dayStart = Math.floor(jstSec / 86400) * 86400;
    return dayStart - JST_OFFSET;
  }
  // Intraday: offset from 09:00 JST
  const openUTC = sessionOpenUTC(utcSec);
  const elapsed = utcSec - openUTC;
  return openUTC + Math.floor(elapsed / tfSec) * tfSec;
}

// ---------- Init charts ----------
function initCharts() {
  charts.forEach(c => c.chart.remove());
  charts.length = 0;

  TF.forEach(tf => {
    const container = document.getElementById(tf.el);
    const label = container.querySelector('.panel-label');
    while (container.lastChild && container.lastChild !== label) {
      container.removeChild(container.lastChild);
    }

    const chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
    });

    const candleSeries = chart.addCandlestickSeries(
      volumeCandleEnabled ? HIDDEN_CANDLE_OPTIONS : STANDARD_CANDLE_OPTIONS
    );

    const vwapSeries = chart.addLineSeries({
      color: vwapColor,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: true,
      title: vwapLabelVisible ? 'VWAP' : '',
      visible: vwapVisible,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // click handler for drawing lines & RR
    chart.subscribeClick((param) => {
      if (!drawMode || !param.point) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null || isNaN(price)) return;
      const rounded = Math.round(price * 10) / 10;

      if (drawMode === 'ep' || drawMode === 'tp') {
        window.__reviewMarkerClick?.(entry, rounded, getDisplayTimeFromPoint(entry, param));
        return;
      }

      if (drawMode === 'rr') {
        handleRRClick(rounded, getDisplayTimeFromPoint(entry, param));
        return;
      }

      // For ray: get the display-time at the clicked X position
      let clickTime = null;
      if (drawMode === 'ray' && param.time) {
        clickTime = param.time;
      }
      addLine(rounded, drawMode, clickTime);
      setDrawMode(null);
    });

    const executedProfileCanvas = document.createElement('canvas');
    executedProfileCanvas.className = 'executed-profile-layer';
    executedProfileCanvas.style.display = shouldShowExecutedProfile(tf) ? 'block' : 'none';
    container.appendChild(executedProfileCanvas);

    const boardProfileCanvas = document.createElement('canvas');
    boardProfileCanvas.className = 'board-profile-layer';
    boardProfileCanvas.style.display = shouldShowBoardProfile(tf) ? 'block' : 'none';
    container.appendChild(boardProfileCanvas);

    const volumeCandleCanvas = document.createElement('canvas');
    volumeCandleCanvas.className = 'volume-candle-layer';
    volumeCandleCanvas.style.display = volumeCandleEnabled ? 'block' : 'none';
    container.appendChild(volumeCandleCanvas);

    const rrRayCanvas = document.createElement('canvas');
    rrRayCanvas.className = 'rr-ray-layer';
    rrRayCanvas.style.display = 'none';
    container.appendChild(rrRayCanvas);

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    container.appendChild(tooltip);

    const entry = {
      chart,
      candleSeries,
      volumeSeries,
      vwapSeries,
      tf,
      volumeCandleCanvas,
      boardProfileCanvas,
      executedProfileCanvas,
      rrRayCanvas,
      tooltip,
      volumeCandleData: [],
    };
    charts.push(entry);

    const redrawChartLayers = () => drawChartOverlays(entry);
    const timeScale = chart.timeScale();
    if (timeScale.subscribeVisibleTimeRangeChange) {
      timeScale.subscribeVisibleTimeRangeChange(redrawChartLayers);
    }
    if (timeScale.subscribeVisibleLogicalRangeChange) {
      timeScale.subscribeVisibleLogicalRangeChange(redrawChartLayers);
    }
  });

  // Daily chart: wider bar spacing so single bars are visible
  const dailyChart = charts.find(c => c.tf.sec >= 86400);
  if (dailyChart) {
    dailyChart.chart.timeScale().applyOptions({
      barSpacing: 80,
      minBarSpacing: 40,
    });
  }

  // ===== Crosshair synchronization across all charts =====
  charts.forEach((entry) => {
    entry.chart.subscribeCrosshairMove((param) => {
      updateChartTooltip(entry, param);
      if (!crosshairSyncEnabled) return;
      if (__syncingCrosshair) return;
      // Only broadcast when source chart actually has a crosshair point
      if (!param.point || !param.time) {
        __syncingCrosshair = true;
        charts.forEach((other) => {
          if (other === entry) return;
          try { other.chart.clearCrosshairPosition(); } catch (_) {}
          hideChartTooltip(other);
        });
        __syncingCrosshair = false;
        if (window.__boardHighlightPrice) window.__boardHighlightPrice(null);
        return;
      }
      const price = entry.candleSeries.coordinateToPrice(param.point.y);
      if (price == null || isNaN(price)) return;
      __syncingCrosshair = true;
      charts.forEach((other) => {
        if (other === entry) return;
        try { other.chart.setCrosshairPosition(price, param.time, other.candleSeries); } catch (_) {}
      });
      __syncingCrosshair = false;
      if (window.__boardHighlightPrice) window.__boardHighlightPrice(price);
    });
  });

  reapplyLines();
  handleResize();
}

function handleResize() {
  charts.forEach(c => {
    const el = document.getElementById(c.tf.el);
    c.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    drawChartOverlays(c);
  });
}
window.addEventListener('resize', handleResize);

function setActiveChartPanel(panelId) {
  if (!['p2m', 'p5m', 'p10m', 'p1d'].includes(panelId)) return;
  activeChartPanelId = panelId;
  document.querySelectorAll('#p2m, #p5m, #p10m, #p1d').forEach(panel => {
    panel.classList.toggle('single-active', panel.id === activeChartPanelId);
    panel.classList.toggle('tf-active', panel.id === activeChartPanelId);
  });
}

function applySingleChartMode() {
  document.body.classList.toggle('single-chart-mode', singleChartMode);
  setActiveChartPanel(activeChartPanelId);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function toggleSingleChartMode() {
  singleChartMode = !singleChartMode;
  applySingleChartMode();
}

function setupActiveChartTracking() {
  document.addEventListener('mousedown', (e) => {
    const panel = e.target.closest && e.target.closest('#p2m, #p5m, #p10m, #p1d');
    if (panel) setActiveChartPanel(panel.id);
  });
}

function parseTimeframeSpec(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (raw === 'D' || raw === '1D' || raw === 'DAILY') {
    return { sec: 86400, key: '1d', label: 'Daily', input: 'D' };
  }
  if (raw === 'W' || raw === '1W' || raw === 'WEEKLY') {
    return { sec: 604800, key: '1w', label: 'Weekly', input: 'W' };
  }
  let sec = null;
  if (/^\d+S$/.test(raw)) sec = parseInt(raw, 10);
  else if (/^\d+(M|MIN)$/.test(raw)) sec = parseInt(raw, 10) * 60;
  else if (/^\d+H$/.test(raw)) sec = parseInt(raw, 10) * 3600;
  else if (/^\d+$/.test(raw)) sec = parseInt(raw, 10) * 60;
  if (!sec || sec < 1 || sec > 86400) return null;
  if (sec === 86400) return { sec, key: '1d', label: 'Daily', input: 'D' };
  if (sec < 60) return { sec, key: `${sec}s`, label: `${sec} sec`, input: `${sec}s` };
  const minutes = sec / 60;
  return {
    sec,
    key: Number.isInteger(minutes) ? `${minutes}m` : `${sec}s`,
    label: Number.isInteger(minutes) ? `${minutes} min` : `${sec} sec`,
    input: Number.isInteger(minutes) ? String(minutes) : `${sec}s`,
  };
}

function setPanelTimeframe(panelId, value, { renderNow = true } = {}) {
  const parsed = typeof value === 'object' ? value : parseTimeframeSpec(value);
  const tf = TF.find(item => item.el === panelId);
  if (!parsed || !tf) return false;
  tf.sec = parsed.sec;
  tf.key = parsed.key;
  const label = document.querySelector(`#${panelId} .panel-label`);
  if (label) label.textContent = parsed.label;
  if (renderNow && charts.length && ticks.length) {
    render();
    applyInitialChartView();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  return true;
}

function applyTimeframeSet(items) {
  items.forEach(([panelId, value]) => setPanelTimeframe(panelId, value, { renderNow: false }));
  if (charts.length && ticks.length) {
    render();
    applyInitialChartView();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}

window.__applyLayoutEPreset = function () {
  applyTimeframeSet([
    ['p1d', 'D'],
    ['p2m', '2'],
    ['p10m', '15s'],
  ]);
  setActiveChartPanel('p10m');
};

window.__restoreStandardTimeframes = function () {
  applyTimeframeSet([
    ['p2m', '2'],
    ['p5m', '10'],
    ['p10m', '15s'],
    ['p1d', 'D'],
  ]);
};

const timeframeDialog = document.getElementById('timeframeDialog');
const timeframeInput = document.getElementById('timeframeInput');
const timeframeDialogTitle = document.getElementById('timeframeDialogTitle');

function openTimeframeDialog() {
  if (!timeframeDialog || !timeframeInput) return;
  const tf = TF.find(item => item.el === activeChartPanelId);
  if (!tf) return;
  const parsed = parseTimeframeSpec(tf.key === '1d' ? 'D' : tf.key);
  timeframeDialogTitle.textContent = `${tf.el} の時間足を変更`;
  timeframeInput.value = parsed?.input || tf.key;
  timeframeDialog.classList.add('open');
  timeframeDialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    timeframeInput.focus();
    timeframeInput.select();
  });
}

function closeTimeframeDialog() {
  if (!timeframeDialog) return;
  timeframeDialog.classList.remove('open');
  timeframeDialog.setAttribute('aria-hidden', 'true');
}

if (timeframeInput) {
  timeframeInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTimeframeDialog();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const parsed = parseTimeframeSpec(timeframeInput.value);
    if (!parsed) {
      timeframeInput.setCustomValidity('15s / 15 / 60 / D / W の形式で入力してください');
      timeframeInput.reportValidity();
      return;
    }
    timeframeInput.setCustomValidity('');
    setPanelTimeframe(activeChartPanelId, parsed);
    closeTimeframeDialog();
  });
}

function drawChartOverlays(entry) {
  drawExecutedProfile(entry);
  drawBoardProfile(entry);
  drawVolumeCandles(entry);
  drawRRRays(entry);
}

function shouldShowBoardProfile(tf) {
  return boardProfileVisible && tf && boardProfileTfKeys.has(tf.key);
}

function shouldShowExecutedProfile(tf) {
  return executedProfileVisible && tf && executedProfileTfKeys.has(tf.key);
}

function getDisplayTimeFromX(entry, x) {
  if (!entry || x == null || !isFinite(x)) return getCurrentDisplayTime();
  const timeScale = entry.chart.timeScale();
  if (timeScale.coordinateToTime) {
    const direct = timeScale.coordinateToTime(x);
    if (direct != null) return direct;
  }
  const range = getVisibleDisplayRange(entry);
  const panel = document.getElementById(entry.tf.el);
  const width = panel ? panel.clientWidth : 0;
  if (range && width > 0 && range.from != null && range.to != null) {
    const ratio = Math.max(0, Math.min(1, x / width));
    return range.from + (range.to - range.from) * ratio;
  }
  return getCurrentDisplayTime();
}

function getDisplayTimeFromPoint(entry, param) {
  if (param?.time != null) return param.time;
  return getDisplayTimeFromX(entry, param?.point?.x);
}

function resizeLayerCanvas(canvas, entry) {
  if (!canvas) return null;
  const panel = document.getElementById(entry.tf.el);
  const width = panel.clientWidth;
  const height = panel.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.floor(width * dpr));
  const targetHeight = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function resizeVolumeCandleCanvas(entry) {
  const canvas = entry.volumeCandleCanvas;
  return resizeLayerCanvas(canvas, entry);
}

function drawBoardProfile(entry) {
  const canvas = entry.boardProfileCanvas;
  if (!canvas) return;
  const resized = resizeLayerCanvas(canvas, entry);
  if (!resized) return;
  const { ctx, width, height } = resized;

  if (!shouldShowBoardProfile(entry.tf)) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';

  const profile = window.__getBoardVolumeProfile ? window.__getBoardVolumeProfile() : null;
  if (!profile || !profile.rows || !profile.rows.length || !profile.maxQty) return;

  const rightPad = 66;
  const maxBarWidth = Math.max(72, Math.min(width * 0.28, 240));
  const minRowHeight = 2;
  const tickStep = Math.max(1, Number(profile.tickSize) || 1);
  const priceFormatter = new Intl.NumberFormat('ja-JP');

  ctx.save();
  ctx.font = '10px Menlo, Monaco, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  for (const row of profile.rows) {
    const y = entry.candleSeries.priceToCoordinate(row.price);
    if (y == null || y < -8 || y > height + 8) continue;
    const nextY = entry.candleSeries.priceToCoordinate(row.price + tickStep);
    const rawHeight = nextY == null ? 6 : Math.abs(nextY - y);
    const barHeight = Math.max(minRowHeight, Math.min(13, rawHeight * 0.74 || 6));
    const ratio = Math.sqrt(row.remaining / profile.maxQty);
    const barWidth = Math.max(3, maxBarWidth * ratio);
    const x = width - rightPad - barWidth;
    const color = row.side === 'ask'
      ? 'rgba(239, 83, 80, 0.32)'
      : row.side === 'bid'
      ? 'rgba(38, 166, 154, 0.32)'
      : 'rgba(255, 213, 79, 0.42)';

    ctx.fillStyle = color;
    ctx.fillRect(x, y - barHeight / 2, barWidth, barHeight);

    if (barWidth > 48 && barHeight >= 7) {
      ctx.fillStyle = row.side === 'ask' ? 'rgba(255,190,190,0.86)' : 'rgba(190,255,232,0.86)';
      ctx.fillText(priceFormatter.format(row.remaining), x + 5, y);
    }
  }
  ctx.restore();
}

function getVisibleDisplayRange(entry) {
  const range = entry.chart.timeScale().getVisibleRange
    ? entry.chart.timeScale().getVisibleRange()
    : null;
  if (!range || range.from == null || range.to == null) return null;
  return range;
}

function getExecutedProfileBinSize(entry, visibleTicks, tickSize) {
  if (!visibleTicks.length) return tickSize;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  visibleTicks.forEach(t => {
    minPrice = Math.min(minPrice, t.price);
    maxPrice = Math.max(maxPrice, t.price);
  });
  const range = Math.max(tickSize, maxPrice - minPrice);
  const targetBins = entry.tf.key === '10m' ? 24 : 34;
  const raw = range / targetBins;
  const multiplier = Math.max(1, Math.ceil(raw / tickSize));
  return tickSize * multiplier;
}

function drawExecutedProfile(entry) {
  const canvas = entry.executedProfileCanvas;
  if (!canvas) return;
  const resized = resizeLayerCanvas(canvas, entry);
  if (!resized) return;
  const { ctx, width, height } = resized;

  if (!shouldShowExecutedProfile(entry.tf)) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';

  if (!ticks.length || cursor < 0) return;
  const visibleRange = getVisibleDisplayRange(entry);
  const tickSize = Math.max(0.0001, Number(window.__getBoardVolumeProfile?.().tickSize) || 1);
  const slice = ticks.slice(0, cursor + 1);
  const visibleTicks = visibleRange
    ? slice.filter(t => {
        const displayTime = toDisplay(t.time);
        return displayTime >= visibleRange.from && displayTime <= visibleRange.to;
      })
    : slice;
  if (!visibleTicks.length) return;

  const binSize = getExecutedProfileBinSize(entry, visibleTicks, tickSize);
  const bins = new Map();
  let totalVolume = 0;
  for (const t of visibleTicks) {
    const volume = Number(t.volume) || 0;
    if (volume <= 0) continue;
    const low = Math.floor(t.price / binSize) * binSize;
    const key = String(Math.round(low / tickSize) * tickSize);
    const prev = bins.get(key) || { low, high: low + binSize, volume: 0 };
    prev.volume += volume;
    bins.set(key, prev);
    totalVolume += volume;
  }
  if (!bins.size || !totalVolume) return;

  const rows = [...bins.values()]
    .filter(row => row.volume > 0)
    .sort((a, b) => b.volume - a.volume);
  const maxVolume = rows[0]?.volume || 1;
  const minLabelVolume = Math.max(totalVolume * 0.012, maxVolume * 0.18);
  const maxBarWidth = Math.max(110, width * 0.48);
  const leftPad = 0;
  const labelFormatter = new Intl.NumberFormat('ja-JP');

  ctx.save();
  ctx.font = '12px Menlo, Monaco, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  rows
    .sort((a, b) => a.low - b.low)
    .forEach(row => {
      const yLow = entry.candleSeries.priceToCoordinate(row.low);
      const yHigh = entry.candleSeries.priceToCoordinate(row.high);
      if (yLow == null || yHigh == null) return;
      const top = Math.min(yLow, yHigh);
      const bottom = Math.max(yLow, yHigh);
      if (bottom < 0 || top > height) return;

      const bandHeight = Math.max(4, Math.min(34, bottom - top));
      const y = (top + bottom) / 2;
      const ratio = row.volume / maxVolume;
      const barWidth = Math.max(12, maxBarWidth * ratio);

      ctx.fillStyle = 'rgba(255, 224, 64, 0.18)';
      ctx.strokeStyle = 'rgba(255, 232, 96, 0.32)';
      ctx.fillRect(leftPad, y - bandHeight / 2, barWidth, bandHeight);
      ctx.strokeRect(leftPad, y - bandHeight / 2, barWidth, bandHeight);

      if (executedProfileLabelsVisible && row.volume >= minLabelVolume) {
        const percent = row.volume / totalVolume * 100;
        const label = `${percent.toFixed(2)}% (vol: ${labelFormatter.format(row.volume)})`;
        const labelX = Math.min(leftPad + barWidth + 5, width - 180);
        ctx.fillStyle = 'rgba(215, 218, 226, 0.86)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 3;
        ctx.strokeText(label, labelX, y);
        ctx.fillText(label, labelX, y);
      }
    });

  ctx.restore();
}

function drawRRRays(entry) {
  const canvas = entry.rrRayCanvas;
  if (!canvas) return;
  const resized = resizeLayerCanvas(canvas, entry);
  if (!resized) return;
  const { ctx, width, height } = resized;

  if (!rrCurrent || !rrVisible) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';

  const range = getVisibleDisplayRange(entry);
  const lines = [
    { key: 'entry', price: rrCurrent.entry, startTime: rrCurrent.times.entry, color: '#2962ff', label: 'ENTRY', width: 2, dash: [] },
    { key: 'sl', price: rrCurrent.sl, startTime: rrCurrent.times.sl, color: '#ef5350', label: `LC -${Math.abs(rrCurrent.entry - rrCurrent.sl).toFixed(1)}`, width: 1, dash: [6, 4] },
    { key: 'tp', price: rrCurrent.tp, startTime: rrCurrent.times.tp, color: '#26a69a', label: `TP +${Math.abs(rrCurrent.tp - rrCurrent.entry).toFixed(1)}`, width: 1, dash: [6, 4] },
  ];

  ctx.save();
  ctx.font = '11px Menlo, Monaco, monospace';
  ctx.textBaseline = 'middle';

  lines.forEach(line => {
    const y = entry.candleSeries.priceToCoordinate(line.price);
    if (y == null || y < -10 || y > height + 10) return;

    let x = entry.chart.timeScale().timeToCoordinate(line.startTime);
    if (x == null || !isFinite(x)) {
      x = range && line.startTime <= range.from ? 0 : width - 30;
    }
    if (x == null) return;
    x = Math.max(0, Math.min(width - 30, x));

    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.setLineDash(line.dash);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    const tagText = `${line.label}  ${line.price.toFixed(1)}`;
    const metrics = ctx.measureText(tagText);
    const tagW = metrics.width + 12;
    const tagH = 18;
    const tagX = Math.max(x + 6, width - tagW - 8);
    const tagY = Math.max(tagH / 2 + 2, Math.min(height - tagH / 2 - 2, y));
    ctx.setLineDash([]);
    ctx.fillStyle = line.color;
    ctx.fillRect(tagX, tagY - tagH / 2, tagW, tagH);
    ctx.fillStyle = '#fff';
    ctx.fillText(tagText, tagX + 6, tagY);
  });

  ctx.restore();
}

function getVisibleVolumeCandleData(entry) {
  const data = entry.volumeCandleData || [];
  if (!data.length) return [];
  const range = entry.chart.timeScale().getVisibleRange
    ? entry.chart.timeScale().getVisibleRange()
    : null;
  if (!range || range.from == null || range.to == null) return data;
  return data.filter(c => c.time >= range.from && c.time <= range.to);
}

function estimateCandleSlot(entry, visibleData) {
  const coords = visibleData
    .map(c => entry.chart.timeScale().timeToCoordinate(c.time))
    .filter(x => x != null && isFinite(x))
    .sort((a, b) => a - b);
  let slot = 8;
  for (let i = 1; i < coords.length; i++) {
    const gap = coords[i] - coords[i - 1];
    if (gap > 0.5) slot = Math.min(slot === 8 ? gap : slot, gap);
  }
  return Math.max(3, Math.min(28, slot || 8));
}

function displaySecondsOfDay(displayTime) {
  return ((Math.floor(displayTime) % 86400) + 86400) % 86400;
}

function isAuctionVolumeCandle(candle) {
  if (!candle || !candle.time) return false;
  const seconds = displaySecondsOfDay(candle.time);
  return seconds === VOLUME_CANDLE_OPEN_SECONDS || seconds === VOLUME_CANDLE_CLOSE_SECONDS;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] || 0;
}

function brightenHex(hex, amount) {
  const raw = String(hex || '').replace('#', '');
  if (raw.length !== 6) return hex;
  const parts = [0, 2, 4].map(i => parseInt(raw.slice(i, i + 2), 16));
  const bright = parts.map(v => Math.min(255, Math.round(v + (255 - v) * amount)));
  return '#' + bright.map(v => v.toString(16).padStart(2, '0')).join('');
}

function formatVolume(value) {
  const n = Number(value) || 0;
  return Math.round(n).toLocaleString('ja-JP');
}

function findVolumeCandleByTime(entry, time) {
  if (time == null) return null;
  return (entry.volumeCandleData || []).find(c => c.time === time) || null;
}

function hideChartTooltip(entry) {
  if (entry.tooltip) entry.tooltip.style.display = 'none';
}

function updateChartTooltip(entry, param) {
  const tooltip = entry.tooltip;
  if (!tooltip || !param || !param.point || param.time == null) {
    hideChartTooltip(entry);
    return;
  }

  const candle = findVolumeCandleByTime(entry, param.time);
  if (!candle) {
    hideChartTooltip(entry);
    return;
  }

  const panel = document.getElementById(entry.tf.el);
  const isUp = candle.close >= candle.open;
  const direction = isUp ? '上昇' : '下降';
  const directionClass = isUp ? 'tt-up' : 'tt-down';
  const priceDiff = Math.round((candle.close - candle.open) * 100) / 100;
  tooltip.innerHTML = [
    `<div class="tt-title">${entry.tf.key} CandleVolume</div>`,
    `<div class="${directionClass}">${direction} ${priceDiff >= 0 ? '+' : ''}${priceDiff}</div>`,
    `<div>出来高 <span class="tt-vol">${formatVolume(candle.volume)}</span></div>`,
  ].join('');

  const pad = 10;
  const tooltipWidth = 150;
  const tooltipHeight = 64;
  const left = Math.min(
    Math.max(pad, param.point.x + 14),
    Math.max(pad, panel.clientWidth - tooltipWidth - pad)
  );
  const top = Math.min(
    Math.max(pad, param.point.y + 14),
    Math.max(pad, panel.clientHeight - tooltipHeight - pad)
  );
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
  tooltip.style.display = 'block';
}

function drawVolumeCandles(entry) {
  const canvas = entry.volumeCandleCanvas;
  if (!canvas) return;
  const resized = resizeVolumeCandleCanvas(entry);
  if (!resized) return;
  const { ctx, width, height } = resized;

  if (!volumeCandleEnabled) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';

  const visibleData = getVisibleVolumeCandleData(entry);
  if (!visibleData.length) return;

  const regularVolumes = visibleData
    .filter(c => !isAuctionVolumeCandle(c))
    .map(c => Number(c.volume) || 0)
    .filter(v => v > 0);
  const volumeBase = regularVolumes.length ? regularVolumes : visibleData.map(c => Number(c.volume) || 0);
  const highVolumeThreshold = percentile(volumeBase, VOLUME_CANDLE_HIGHLIGHT_PERCENTILE);
  const maxRegularVolume = volumeBase.reduce((max, v) => Math.max(max, v), 0) || 1;
  const slot = estimateCandleSlot(entry, visibleData);
  const baseBodyWidth = Math.max(2, slot * 0.56);
  const auctionBodyWidth = Math.max(baseBodyWidth + 1, slot * 0.78);
  const maxBodyWidth = Math.max(auctionBodyWidth + 1, slot * 1.12);

  ctx.lineCap = 'square';
  visibleData.forEach(c => {
    const x = entry.chart.timeScale().timeToCoordinate(c.time);
    if (x == null || x < -maxBodyWidth || x > width + maxBodyWidth) return;

    const openY = entry.candleSeries.priceToCoordinate(c.open);
    const highY = entry.candleSeries.priceToCoordinate(c.high);
    const lowY = entry.candleSeries.priceToCoordinate(c.low);
    const closeY = entry.candleSeries.priceToCoordinate(c.close);
    if ([openY, highY, lowY, closeY].some(v => v == null || !isFinite(v))) return;

    const isUp = c.close >= c.open;
    const isAuction = isAuctionVolumeCandle(c);
    const rawColor = isUp ? CANDLE_COLORS.up : CANDLE_COLORS.down;
    const volume = Number(c.volume) || 0;
    const isHighVolume = !isAuction && highVolumeThreshold > 0 && volume >= highVolumeThreshold;
    const volumeRatio = isHighVolume
      ? Math.min(1, Math.max(0, (volume - highVolumeThreshold) / Math.max(1, maxRegularVolume - highVolumeThreshold)))
      : 0;
    const bodyWidth = isAuction
      ? auctionBodyWidth
      : isHighVolume
      ? baseBodyWidth + (maxBodyWidth - baseBodyWidth) * (0.45 + volumeRatio * 0.55)
      : baseBodyWidth;
    const color = isAuction ? AUCTION_CANDLE_COLOR : (isHighVolume ? brightenHex(rawColor, 0.28) : rawColor);
    const half = bodyWidth / 2;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(closeY - openY));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = isHighVolume || isAuction ? 1 : 0.9;
    ctx.lineWidth = Math.max(1, Math.min(2, bodyWidth * 0.16));
    ctx.beginPath();
    ctx.moveTo(x, Math.max(0, highY));
    ctx.lineTo(x, Math.min(height, lowY));
    ctx.stroke();

    ctx.fillRect(x - half, bodyTop, bodyWidth, bodyHeight);
  });
  ctx.globalAlpha = 1;
}

function applyVolumeCandleMode() {
  charts.forEach(entry => {
    entry.candleSeries.applyOptions(
      volumeCandleEnabled ? HIDDEN_CANDLE_OPTIONS : STANDARD_CANDLE_OPTIONS
    );
    drawChartOverlays(entry);
  });
}

function updateProfileButtons() {
  const boardButtons = [
    document.getElementById('btnBoardProfile'),
    document.getElementById('btnBoardProfileSettings'),
  ].filter(Boolean);
  boardButtons.forEach(btn => {
    btn.classList.toggle('active', boardProfileVisible);
    if (btn.id === 'btnBoardProfileSettings') {
      btn.textContent = `板出来高: ${boardProfileVisible ? 'ON' : 'OFF'}`;
    }
  });

  const executedButtons = [
    document.getElementById('btnExecutedProfile'),
    document.getElementById('btnExecutedProfileSettings'),
  ].filter(Boolean);
  executedButtons.forEach(btn => {
    btn.classList.toggle('active', executedProfileVisible);
    if (btn.id === 'btnExecutedProfileSettings') {
      btn.textContent = `約定出来高: ${executedProfileVisible ? 'ON' : 'OFF'}`;
    }
  });
}

function toggleBoardProfile() {
  boardProfileVisible = !boardProfileVisible;
  updateProfileButtons();
  charts.forEach(entry => drawBoardProfile(entry));
}

function toggleExecutedProfile() {
  executedProfileVisible = !executedProfileVisible;
  updateProfileButtons();
  charts.forEach(entry => drawExecutedProfile(entry));
}

function setRrToolbarMode(enabled) {
  const overlay = document.getElementById('rrOverlay');
  const dock = document.getElementById('rrDock');
  if (!overlay || !dock) return;
  document.body.classList.toggle('rr-toolbar', enabled);
  if (enabled) {
    dock.style.display = '';
    dock.appendChild(overlay);
  } else {
    dock.style.display = 'none';
    document.body.appendChild(overlay);
  }
  if (rrCurrent && rrVisible) overlay.style.display = enabled ? 'flex' : 'block';
  else overlay.style.display = 'none';
}

function setupProfileTfControls() {
  document.querySelectorAll('.profile-tf').forEach(input => {
    const targetSet = input.dataset.profile === 'executed'
      ? executedProfileTfKeys
      : boardProfileTfKeys;
    input.checked = targetSet.has(input.dataset.tf);
    input.addEventListener('change', () => {
      if (input.checked) targetSet.add(input.dataset.tf);
      else targetSet.delete(input.dataset.tf);
      charts.forEach(entry => {
        drawExecutedProfile(entry);
        drawBoardProfile(entry);
      });
    });
  });
}

// Apply tick size (minMove + precision) to all chart series — called by board.js
// after detecting the instrument's 呼び値 from CSV prices.
window.__applyTickSize = function(tickSize) {
  if (!tickSize || !isFinite(tickSize)) return;
  // Derive decimal precision from tick size
  let precision = 0;
  if (tickSize < 1) {
    const s = tickSize.toString();
    const dot = s.indexOf('.');
    precision = dot < 0 ? 0 : (s.length - dot - 1);
  }
  const fmt = { type: 'price', precision, minMove: tickSize };
  charts.forEach(c => {
    if (c.candleSeries) c.candleSeries.applyOptions({ priceFormat: fmt });
    if (c.vwapSeries) c.vwapSeries.applyOptions({ priceFormat: fmt });
  });
};

// ---------- CSV Parsing ----------
function parseCSV(text, fileName) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerCols = parseCSVLine(lines[0]).map(h => h.replace(/^\uFEFF/, '').trim());
  const header = headerCols.join(',');
  const isQR = header.includes('値段') || header.includes('時刻');

  let dateStr = null;
  const dm = fileName.match(/(\d{8})/);
  if (dm) dateStr = dm[1];

  const result = [];

  if (isQR) {
    const priceIdx = findHeaderIndex(headerCols, ['値段', '価格', 'price']);
    const volumeIdx = findHeaderIndex(headerCols, ['株数', '出来高', 'volume', 'vol']);
    const timeIdx = findHeaderIndex(headerCols, ['時刻', '時間', 'time']);
    const dateIdx = findHeaderIndex(headerCols, ['日付', '年月日', 'date']);
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 4) continue;
      const price = parseNumber(cols[priceIdx >= 0 ? priceIdx : 0]);
      const volume = parseNumber(cols[volumeIdx >= 0 ? volumeIdx : 1]);
      const rawTime = String(cols[timeIdx >= 0 ? timeIdx : 3] || '').trim();
      const rowDate = dateIdx >= 0 ? normalizeDateToken(cols[dateIdx]) : null;

      if (isNaN(price) || isNaN(volume)) continue;

      let unixSec;
      const dateTime = parseDateTimeToken(rawTime);
      if (dateTime) {
        unixSec = dateTime;
      } else if (rowDate || dateStr) {
        const d8 = rowDate || dateStr;
        const y = d8.slice(0, 4);
        const mo = d8.slice(4, 6);
        const d = d8.slice(6, 8);
        unixSec = Date.parse(`${y}-${mo}-${d}T${normalizeTimeToken(rawTime)}+09:00`) / 1000;
      } else {
        const today = new Date().toISOString().slice(0, 10);
        unixSec = Date.parse(`${today}T${normalizeTimeToken(rawTime)}+09:00`) / 1000;
      }

      if (!isNaN(unixSec)) result.push({ time: unixSec, price, volume });
    }
    result.sort((a, b) => a.time - b.time);
  } else {
    for (let i = 0; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;
      const first = cols[0].trim();
      if (isNaN(parseFloat(first)) && isNaN(Date.parse(first))) continue;

      let time;
      if (/^\d{10,13}$/.test(first)) {
        time = parseInt(first, 10);
        if (time > 1e12) time = Math.floor(time / 1000);
      } else {
        time = Math.floor(Date.parse(first) / 1000);
      }
      const price = parseNumber(cols[1]);
      const volume = cols.length >= 3 ? parseNumber(cols[2]) || 0 : 0;

      if (isNaN(time) || isNaN(price)) continue;
      result.push({ time, price, volume });
    }
    result.sort((a, b) => a.time - b.time);
  }

  return result;
}

function parseCSVLine(line) {
  const cols = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cols.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols.map(c => c.trim());
}

function findHeaderIndex(headers, names) {
  const normalized = headers.map(h => h.toLowerCase());
  return normalized.findIndex(h => names.some(name => h === String(name).toLowerCase()));
}

function parseNumber(value) {
  if (value == null) return NaN;
  return parseFloat(String(value).replace(/,/g, '').replace(/"/g, '').trim());
}

function normalizeDateToken(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/"/g, '');
  const compact = raw.replace(/[^\d]/g, '');
  if (/^\d{8}$/.test(compact)) return compact;
  return null;
}

function normalizeTimeToken(value) {
  const raw = String(value || '').trim();
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
    const [h, m, s] = raw.split(':');
    return `${h.padStart(2, '0')}:${m}:${s}`;
  }
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [h, m] = raw.split(':');
    return `${h.padStart(2, '0')}:${m}:00`;
  }
  return raw;
}

function parseDateTimeToken(value) {
  const raw = String(value || '').trim().replace(/\//g, '-');
  if (!/\d{4}-\d{1,2}-\d{1,2}/.test(raw)) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(/\s+/, 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+09:00`;
  const unixSec = Date.parse(withZone) / 1000;
  return isNaN(unixSec) ? null : unixSec;
}

// ---------- Build candles ----------
function buildCandles(tickSlice, tfSec) {
  if (tickSlice.length === 0) return { candles: [], volumes: [], volumeCandles: [] };

  const map = new Map();

  for (const t of tickSlice) {
    const bucketUTC = bucketTimeUTC(t.time, tfSec);
    const displayTime = toDisplay(bucketUTC);  // fake UTC for chart

    if (!map.has(displayTime)) {
      map.set(displayTime, {
        time: displayTime,
        open: t.price, high: t.price, low: t.price, close: t.price,
        vol: t.volume,
      });
    } else {
      const c = map.get(displayTime);
      c.high = Math.max(c.high, t.price);
      c.low = Math.min(c.low, t.price);
      c.close = t.price;
      c.vol += t.volume;
    }
  }

  const sorted = [...map.values()].sort((a, b) => a.time - b.time);
  const candles = sorted.map(c => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  const volumeCandles = sorted.map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.vol,
  }));
  const volumes = sorted.map(c => ({
    time: c.time,
    value: c.vol,
    color: c.close >= c.open ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)',
  }));

  return { candles, volumes, volumeCandles };
}

// ---------- VWAP ----------
// Calculates session VWAP (resets each day at 09:00 JST)
function buildVWAP(tickSlice, tfSec) {
  if (tickSlice.length === 0) return [];

  // Accumulate VWAP per session day, output one point per candle bucket
  let currentDay = -1;
  let cumPV = 0;   // cumulative price * volume
  let cumVol = 0;  // cumulative volume

  const bucketVwap = new Map(); // displayTime -> vwap value

  for (const t of tickSlice) {
    const dayKey = sessionOpenUTC(t.time);

    if (dayKey !== currentDay) {
      currentDay = dayKey;
      cumPV = 0;
      cumVol = 0;
    }

    cumPV += t.price * t.volume;
    cumVol += t.volume;

    const vwap = cumVol > 0 ? cumPV / cumVol : t.price;

    const bucketUTC = bucketTimeUTC(t.time, tfSec);
    const displayTime = toDisplay(bucketUTC);
    bucketVwap.set(displayTime, Math.round(vwap * 100) / 100);
  }

  return [...bucketVwap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
}

// Pre-aggregate every timeframe once per dataset. During replay we only rebuild
// the single candle containing the cursor instead of scanning every prior tick.
function buildReplayTimeframeCache(tf) {
  const candles = [];
  const volumes = [];
  const volumeCandles = [];
  const vwap = [];
  const bars = [];
  let current = null;
  let sessionKey = null;
  let sessionPV = 0;
  let sessionVolume = 0;

  function finishCurrent() {
    if (!current) return;
    const candle = {
      time: current.time,
      open: current.open,
      high: current.high,
      low: current.low,
      close: current.close,
    };
    candles.push(candle);
    volumeCandles.push({ ...candle, volume: current.volume });
    volumes.push({
      time: current.time,
      value: current.volume,
      color: current.close >= current.open
        ? 'rgba(38,166,154,0.4)'
        : 'rgba(239,83,80,0.4)',
    });
    if (tf.sec < 86400) {
      vwap.push({ time: current.time, value: Math.round(current.vwap * 100) / 100 });
    }
    bars.push({
      startIndex: current.startIndex,
      endIndex: current.endIndex,
      sessionPVBefore: current.sessionPVBefore,
      sessionVolumeBefore: current.sessionVolumeBefore,
    });
  }

  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index];
    const nextSessionKey = sessionOpenUTC(tick.time);
    if (nextSessionKey !== sessionKey) {
      sessionKey = nextSessionKey;
      sessionPV = 0;
      sessionVolume = 0;
    }

    const displayTime = toDisplay(bucketTimeUTC(tick.time, tf.sec));
    if (!current || current.time !== displayTime) {
      finishCurrent();
      current = {
        time: displayTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        vwap: tick.price,
        startIndex: index,
        endIndex: index,
        sessionPVBefore: sessionPV,
        sessionVolumeBefore: sessionVolume,
      };
    }

    current.high = Math.max(current.high, tick.price);
    current.low = Math.min(current.low, tick.price);
    current.close = tick.price;
    current.volume += tick.volume;
    current.endIndex = index;
    sessionPV += tick.price * tick.volume;
    sessionVolume += tick.volume;
    current.vwap = sessionVolume > 0 ? sessionPV / sessionVolume : tick.price;
  }
  finishCurrent();

  return { tf, candles, volumes, volumeCandles, vwap, bars };
}

function ensureReplaySeriesCache() {
  if (
    replaySeriesCache &&
    replaySeriesCache.source === ticks &&
    replaySeriesCache.length === ticks.length
  ) return replaySeriesCache;

  const bySeconds = new Map();
  TF.forEach(tf => bySeconds.set(tf.sec, buildReplayTimeframeCache(tf)));
  replaySeriesCache = { source: ticks, length: ticks.length, bySeconds };
  return replaySeriesCache;
}

function findReplayBarIndex(bars, tickIndex) {
  let low = 0;
  let high = bars.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (bars[mid].startIndex <= tickIndex) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function getReplaySeriesData(tf, tickIndex) {
  const replayCache = ensureReplaySeriesCache();
  if (!replayCache.bySeconds.has(tf.sec)) {
    replayCache.bySeconds.set(tf.sec, buildReplayTimeframeCache({ ...tf }));
  }
  const cache = replayCache.bySeconds.get(tf.sec);
  if (!cache || !cache.bars.length || tickIndex < 0) {
    return { candles: [], volumes: [], volumeCandles: [], vwap: [] };
  }

  const barIndex = findReplayBarIndex(cache.bars, tickIndex);
  const meta = cache.bars[barIndex];
  const first = ticks[meta.startIndex];
  let high = first.price;
  let low = first.price;
  let close = first.price;
  let volume = 0;
  let partialPV = 0;
  let partialVolume = 0;

  for (let index = meta.startIndex; index <= tickIndex; index++) {
    const tick = ticks[index];
    high = Math.max(high, tick.price);
    low = Math.min(low, tick.price);
    close = tick.price;
    volume += tick.volume;
    partialPV += tick.price * tick.volume;
    partialVolume += tick.volume;
  }

  const time = cache.candles[barIndex].time;
  const partialCandle = { time, open: first.price, high, low, close };
  const candles = cache.candles.slice(0, barIndex);
  const volumeCandles = cache.volumeCandles.slice(0, barIndex);
  const volumes = cache.volumes.slice(0, barIndex);
  candles.push(partialCandle);
  volumeCandles.push({ ...partialCandle, volume });
  volumes.push({
    time,
    value: volume,
    color: close >= first.price ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)',
  });

  const vwap = tf.sec < 86400 ? cache.vwap.slice(0, barIndex) : [];
  if (tf.sec < 86400) {
    const cumulativePV = meta.sessionPVBefore + partialPV;
    const cumulativeVolume = meta.sessionVolumeBefore + partialVolume;
    vwap.push({
      time,
      value: Math.round((cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : close) * 100) / 100,
    });
  }
  return { candles, volumes, volumeCandles, vwap };
}

// ---------- Render ----------
function render() {
  const renderStartedAt = performance.now();
  let chartRenderMs = 0;
  charts.forEach((entry) => {
    const chartStartedAt = performance.now();
    const { candleSeries, volumeSeries, vwapSeries, chart, tf } = entry;
    const { candles, volumes, volumeCandles, vwap } = getReplaySeriesData(tf, cursor);
    entry.lastCandleCount = candles.length;
    entry.volumeCandleData = volumeCandles;
    candleSeries.setData(candles);
    volumeSeries.setData(volumes);
    drawExecutedProfile(entry);
    drawVolumeCandles(entry);
    drawRRRays(entry);

    // VWAP (skip for daily)
    if (tf.sec < 86400) {
      vwapSeries.setData(vwap);
    } else {
      vwapSeries.setData([]);
    }

    if (candles.length > 0 && followMode) {
      chart.timeScale().scrollToPosition(5, false);
    }
    chartRenderMs += performance.now() - chartStartedAt;
  });

  // Status label with JST time
  const currentTick = ticks[cursor];
  let timeLabel = '';
  if (currentTick) {
    const jstDate = new Date((currentTick.time + JST_OFFSET) * 1000);
    const hh = String(jstDate.getUTCHours()).padStart(2, '0');
    const mm = String(jstDate.getUTCMinutes()).padStart(2, '0');
    const ss = String(jstDate.getUTCSeconds()).padStart(2, '0');
    timeLabel = ` [${hh}:${mm}:${ss}]`;
  }

  document.getElementById('posLabel').textContent =
    `${cursor + 1} / ${ticks.length}${timeLabel}`;

  // Board/Ayumi hook — exposes state for board.js
  const boardStartedAt = performance.now();
  if (window.__boardSync) window.__boardSync(ticks, cursor);
  const boardRenderMs = performance.now() - boardStartedAt;
  const profileStartedAt = performance.now();
  charts.forEach(entry => drawBoardProfile(entry));
  const replayRenderPerf = {
    totalMs: Math.round((performance.now() - renderStartedAt) * 10) / 10,
    chartMs: Math.round(chartRenderMs * 10) / 10,
    boardMs: Math.round(boardRenderMs * 10) / 10,
    profileMs: Math.round((performance.now() - profileStartedAt) * 10) / 10,
    cursor,
    ticks: ticks.length,
  };
  window.__replayRenderPerf = replayRenderPerf;
  document.getElementById('posLabel').dataset.renderPerf = JSON.stringify(replayRenderPerf);
}

window.__requestRender = render;

// ---------- Navigation ----------
function getStepSize() {
  return parseInt(document.getElementById('stepSize').value, 10) || 1;
}

function setStepSize(size) {
  const el = document.getElementById('stepSize');
  if (!el) return;
  el.value = String(size);
}

function captureVisibleRanges() {
  return charts.map(entry => ({
    entry,
    logicalRange: entry.chart.timeScale().getVisibleLogicalRange
      ? entry.chart.timeScale().getVisibleLogicalRange()
      : null,
    timeRange: entry.chart.timeScale().getVisibleRange
      ? entry.chart.timeScale().getVisibleRange()
      : null,
  }));
}

function restoreVisibleRanges(ranges) {
  const apply = () => {
    ranges.forEach(({ entry, logicalRange, timeRange }) => {
      const scale = entry.chart.timeScale();
      if (logicalRange && logicalRange.from != null && logicalRange.to != null) {
        try {
          scale.setVisibleLogicalRange(logicalRange);
          return;
        } catch (_) {}
      }
      if (timeRange && timeRange.from != null && timeRange.to != null) {
        try { scale.setVisibleRange(timeRange); } catch (_) {}
      }
    });
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function step(delta) {
  if (ticks.length === 0) return;
  const ranges = captureVisibleRanges();
  const sz = getStepSize();
  cursor = Math.max(0, Math.min(ticks.length - 1, cursor + delta * sz));
  const prevFollowMode = followMode;
  followMode = false;
  render();
  followMode = prevFollowMode;
  restoreVisibleRanges(ranges);
}

function goStart() {
  cursor = 0;
  render();
  applyMorningReplayView();
}
function goEnd()   { cursor = ticks.length - 1; render(); }

function getCurrentJstDateParts() {
  const base = ticks[cursor] || ticks[0];
  if (!base) return null;
  const jst = new Date((base.time + JST_OFFSET) * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth(),
    date: jst.getUTCDate(),
  };
}

function findLastTickIndexAtOrBefore(targetUtcSec) {
  let lo = 0;
  let hi = ticks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ticks[mid].time <= targetUtcSec) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function jumpToJstClock(hour, minute, second = 0) {
  if (ticks.length === 0) return;
  stopAutoPlay();
  const parts = getCurrentJstDateParts();
  if (!parts) return;
  const targetUtcSec = Date.UTC(parts.year, parts.month, parts.date, hour, minute, second) / 1000 - JST_OFFSET;
  const index = findLastTickIndexAtOrBefore(targetUtcSec);
  cursor = Math.max(0, index >= 0 ? index : 0);
  render();
}

function jumpMorningEnd() {
  jumpToJstClock(11, 30, 0);
}

function jumpAfternoonEnd() {
  jumpToJstClock(15, 30, 0);
}

function getJstDatePartsFromTick(tick) {
  if (!tick) return null;
  const jst = new Date((tick.time + JST_OFFSET) * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth(),
    date: jst.getUTCDate(),
  };
}

function getDisplayTimeForJstClock(parts, hour, minute, second = 0) {
  return Date.UTC(parts.year, parts.month, parts.date, hour, minute, second) / 1000;
}

function applyMorningReplayView() {
  const parts = getJstDatePartsFromTick(ticks[0]);
  if (!parts) return;
  const from = getDisplayTimeForJstClock(parts, 9, 0, 0);
  const to = getDisplayTimeForJstClock(parts, 11, 30, 0);
  requestAnimationFrame(() => {
    charts.forEach(entry => {
      const scale = entry.chart.timeScale();
      if (entry.tf.sec >= 86400) {
        scale.fitContent();
        return;
      }
      try { scale.setVisibleRange({ from, to }); } catch (_) {}
    });
  });
}

function applyInitialChartView() {
  requestAnimationFrame(() => {
    if (cursor <= 0 && ticks.length > 0) {
      applyMorningReplayView();
      return;
    }
    charts.forEach(entry => {
      const count = entry.lastCandleCount || 0;
      const scale = entry.chart.timeScale();
      if (count <= 0) return;
      if (entry.tf.sec >= 86400) {
        scale.fitContent();
        return;
      }
      const barsByTf = entry.tf.key === '2m' ? 130 : entry.tf.key === '10m' ? 90 : 280;
      if (count <= barsByTf) {
        scale.fitContent();
      } else {
        scale.setVisibleLogicalRange({
          from: Math.max(0, count - barsByTf),
          to: count + 8,
        });
      }
    });
  });
}

function toggleAutoPlay() {
  if (autoPlay) {
    clearInterval(autoPlay);
    autoPlay = null;
  } else {
    autoPlay = setInterval(() => {
      if (cursor >= ticks.length - 1) { clearInterval(autoPlay); autoPlay = null; return; }
      const sz = getStepSize();
      cursor = Math.min(ticks.length - 1, cursor + sz);
      render();
    }, 50);
  }
}

function stopAutoPlay() {
  if (!autoPlay) return;
  clearInterval(autoPlay);
  autoPlay = null;
}

function startAutoPlay() {
  if (ticks.length === 0) return;
  stopAutoPlay();
  autoPlay = setInterval(() => {
    if (cursor >= ticks.length - 1) {
      stopAutoPlay();
      setLoadStatus('再生完了');
      return;
    }
    const sz = getStepSize();
    cursor = Math.min(ticks.length - 1, cursor + sz);
    render();
  }, 50);
}

// ---------- Follow mode toggle ----------
function toggleFollow() {
  followMode = !followMode;
  updateFollowButton();
}

function updateFollowButton() {
  const btn = document.getElementById('btnFollow');
  if (!btn) return;
  btn.classList.toggle('active', followMode);
  btn.textContent = `追従: ${followMode ? 'ON' : 'OFF'}`;
}

// ---------- VWAP toggle ----------
function toggleVwap() {
  vwapVisible = true;
  charts.forEach(({ vwapSeries }) => {
    vwapSeries.applyOptions({ visible: true });
  });
}

function changeVwapColor(color) {
  vwapColor = color;
  charts.forEach(({ vwapSeries }) => {
    vwapSeries.applyOptions({ color: vwapColor });
  });
}

function toggleVwapLabel() {
  vwapLabelVisible = !vwapLabelVisible;
  const btn = document.getElementById('btnVwapLabel');
  if (btn) {
    btn.checked = vwapLabelVisible;
    btn.title = vwapLabelVisible ? 'VWAP文字を非表示' : 'VWAP文字を表示';
  }
  charts.forEach(({ vwapSeries }) => {
    vwapSeries.applyOptions({ title: vwapLabelVisible ? 'VWAP' : '' });
  });
}

document.getElementById('btnFollow').addEventListener('click', toggleFollow);
updateFollowButton();

function toggleCrosshairSync() {
  crosshairSyncEnabled = !crosshairSyncEnabled;
  document.getElementById('btnCrosshairSync').classList.toggle('active', crosshairSyncEnabled);
  if (!crosshairSyncEnabled) {
    charts.forEach((c) => { try { c.chart.clearCrosshairPosition(); } catch (_) {} });
    if (window.__boardHighlightPrice) window.__boardHighlightPrice(null);
  }
}
document.getElementById('btnCrosshairSync').addEventListener('click', toggleCrosshairSync);
document.getElementById('btnCrosshairSync').classList.toggle('active', crosshairSyncEnabled);

// RR overlay: click cycles corner position (TL → BL → BR → TL)
(function setupRROverlayCorner() {
  const el = document.getElementById('rrOverlay');
  if (!el) return;
  const order = ['rr-tl', 'rr-bl', 'rr-br'];
  el.addEventListener('click', () => {
    if (document.body.classList.contains('rr-toolbar')) return;
    const cur = order.findIndex(c => el.classList.contains(c));
    const next = order[(cur + 1) % order.length];
    order.forEach(c => el.classList.remove(c));
    el.classList.add(next);
  });
})();

// ---------- Drawing lines ----------
// drawnLines entries:
//   hline: { price, type:'hline', color, lineStyle, items:[{series, priceline}] }
//   ray:   { price, type:'ray', startTime, items:[{chart, series}] }

const RAY_FAR_FUTURE = 4102444800; // 2100-01-01 UTC
let hlineDrag = null; // { lineIndex, chartIdx }

function getHLineColor() {
  return document.getElementById('hlineColor').value;
}
function getHLineStyle() {
  return parseInt(document.getElementById('hlineStyle').value, 10);
}

function setDrawMode(mode) {
  drawMode = mode;
  document.getElementById('btnHLine').classList.toggle('active', mode === 'hline');
  document.getElementById('btnRay').classList.toggle('active', mode === 'ray');
  document.getElementById('btnRR').classList.toggle('active', mode === 'rr');
  document.querySelectorAll('.panel').forEach(p => {
    p.style.cursor = mode ? 'crosshair' : '';
  });
  // Reset RR clicks if leaving rr mode
  if (mode !== 'rr') {
    rrClicks = [];
    updateRRStatus();
  } else {
    rrClicks = [];
    updateRRStatus();
  }
}

function addLine(price, type, clickDisplayTime, color, lineStyle) {
  if (type === 'hline') {
    const hColor = color || getHLineColor();
    const hStyle = (lineStyle != null) ? lineStyle : getHLineStyle();
    const entry = { price, type, color: hColor, lineStyle: hStyle, items: [] };
    charts.forEach(({ candleSeries }) => {
      const pl = candleSeries.createPriceLine({
        price,
        color: hColor,
        lineWidth: 1,
        lineStyle: hStyle,
        axisLabelVisible: true,
        title: '',
      });
      entry.items.push({ series: candleSeries, priceline: pl });
    });
    drawnLines.push(entry);
    if (window.__boardRefresh) window.__boardRefresh();

  } else if (type === 'ray') {
    // Ray = line series from startTime → far future, right-only
    const startTime = clickDisplayTime || (ticks.length > 0 ? toDisplay(ticks[cursor].time) : 0);
    const entry = { price, type, startTime, items: [] };

    charts.forEach(({ chart }) => {
      const raySeries = chart.addLineSeries({
        color: '#00bcd4',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      raySeries.setData([
        { time: startTime, value: price },
        { time: RAY_FAR_FUTURE, value: price },
      ]);
      entry.items.push({ chart, series: raySeries });
    });
    drawnLines.push(entry);
  }
}

// Recreate a single hline's price lines (after drag or style change)
function updateHLine(lineEntry) {
  lineEntry.items.forEach(({ series, priceline }) => {
    series.removePriceLine(priceline);
  });
  lineEntry.items = [];
  charts.forEach(({ candleSeries }) => {
    const pl = candleSeries.createPriceLine({
      price: lineEntry.price,
      color: lineEntry.color,
      lineWidth: 1,
      lineStyle: lineEntry.lineStyle,
      axisLabelVisible: true,
      title: '',
    });
    lineEntry.items.push({ series: candleSeries, priceline: pl });
  });
}

function removeLastLine() {
  if (drawnLines.length === 0) return;
  const last = drawnLines.pop();

  if (last.type === 'hline') {
    last.items.forEach(({ series, priceline }) => {
      series.removePriceLine(priceline);
    });
  } else if (last.type === 'ray') {
    last.items.forEach(({ chart, series }) => {
      chart.removeSeries(series);
    });
  }
  if (window.__boardRefresh) window.__boardRefresh();
}

function reapplyLines() {
  // Re-create all lines on fresh chart instances
  const oldLines = [...drawnLines];
  drawnLines.length = 0;
  oldLines.forEach(l => {
    addLine(l.price, l.type, l.startTime || null, l.color, l.lineStyle);
  });
}

// ---------- HLine Drag ----------
const HLINE_DRAG_THRESHOLD_PX = 12;

function findNearestHLine(chartIndex, yPx) {
  const { candleSeries } = charts[chartIndex];
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < drawnLines.length; i++) {
    const line = drawnLines[i];
    if (line.type !== 'hline') continue;
    const lineY = candleSeries.priceToCoordinate(line.price);
    if (lineY == null) continue;
    const dist = Math.abs(yPx - lineY);
    if (dist < bestDist) { bestDist = dist; best = { index: i, line }; }
  }
  return (best && bestDist <= HLINE_DRAG_THRESHOLD_PX) ? best : null;
}

function setupHLineDrag() {
  const panels = document.querySelectorAll('.panel');
  panels.forEach((panel) => {
    panel.addEventListener('mousedown', (e) => {
      if (drawMode) return;
      if (rrDrag) return;

      const chartIdx = charts.findIndex(c => c.tf.el === panel.id);
      if (chartIdx < 0) return;
      const rect = panel.getBoundingClientRect();
      const yPx = e.clientY - rect.top;

      // RR drag has priority
      if (rrCurrent && rrVisible) {
        const rrHit = findNearestRRLine(chartIdx, yPx);
        if (rrHit) return;
      }

      const hit = findNearestHLine(chartIdx, yPx);
      if (!hit) return;

      e.preventDefault();
      e.stopPropagation();
      hlineDrag = { lineIndex: hit.index, chartIdx };
      document.body.classList.add('hline-dragging');
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!hlineDrag) return;
    e.preventDefault();
    const chartEntry = charts[hlineDrag.chartIdx];
    const panel = document.getElementById(chartEntry.tf.el);
    const rect = panel.getBoundingClientRect();
    const yPx = e.clientY - rect.top;
    const price = chartEntry.candleSeries.coordinateToPrice(yPx);
    if (price == null || isNaN(price)) return;
    const rounded = Math.round(price * 10) / 10;
    const line = drawnLines[hlineDrag.lineIndex];
    if (line && line.type === 'hline') {
      line.price = rounded;
      updateHLine(line);
      if (window.__boardRefresh) window.__boardRefresh();
    }
  });

  document.addEventListener('mouseup', () => {
    if (hlineDrag) {
      document.body.classList.remove('hline-dragging');
      hlineDrag = null;
    }
  });
}

// ---------- Live update hline color/style from toolbar ----------
document.getElementById('hlineColor').addEventListener('input', (e) => {
  const newColor = e.target.value;
  drawnLines.forEach(line => {
    if (line.type === 'hline') {
      line.color = newColor;
      updateHLine(line);
    }
  });
  if (window.__boardRefresh) window.__boardRefresh();
});
document.getElementById('hlineStyle').addEventListener('change', (e) => {
  const newStyle = parseInt(e.target.value, 10);
  drawnLines.forEach(line => {
    if (line.type === 'hline') {
      line.lineStyle = newStyle;
      updateHLine(line);
    }
  });
});

// ---------- RR (Risk-Reward) Tool ----------
// Click order: 1) Entry  2) Stop Loss  3) Take Profit
const rrLabels = ['ENTRY', 'LC(損切)', 'TP(利確)'];
let rrVisible = true;
let rrDrag = null;  // { lineKey: 'entry'|'sl'|'tp', startY }

function updateRRStatus() {
  const info = document.getElementById('rrInfo');
  if (drawMode !== 'rr') {
    info.textContent = '';
    return;
  }
  const n = rrClicks.length;
  if (n < 3) {
    info.textContent = `RR: ${rrLabels[n]}をクリック (${n}/3)`;
    info.style.color = n === 0 ? '#2962ff' : n === 1 ? '#ef5350' : '#26a69a';
  }
}

function getCurrentDisplayTime() {
  return ticks.length > 0 ? toDisplay(ticks[cursor].time) : 0;
}

function handleRRClick(price, displayTime) {
  rrClicks.push({ price, time: displayTime ?? getCurrentDisplayTime() });
  updateRRStatus();

  if (rrClicks.length === 3) {
    applyRR(rrClicks[0], rrClicks[1], rrClicks[2]);
    setDrawMode(null);
  }
}

function rrLineOpts(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return {
    entry: { value: entry, color: '#2962ff', lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      title: 'ENTRY' },
    sl: { value: sl, color: '#ef5350', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      title: `LC -${risk.toFixed(1)}` },
    tp: { value: tp, color: '#26a69a', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      title: `TP +${reward.toFixed(1)}` },
  };
}

function makeRRSeries(chart, opt) {
  return null;
}

function setRRRayData(series, price, startTime) {
}

function createRRRaySet(chart) {
  return null;
}

function removeRRRaySet(item) {
}

function applyRR(entryClick, slClick, tpClick) {
  clearRR();

  rrCurrent = {
    entry: entryClick.price,
    sl: slClick.price,
    tp: tpClick.price,
    times: {
      entry: entryClick.time ?? getCurrentDisplayTime(),
      sl: slClick.time ?? getCurrentDisplayTime(),
      tp: tpClick.time ?? getCurrentDisplayTime(),
    },
    visible: true,
    items: [],
  };

  rrVisible = true;
  document.getElementById('btnRRToggle').classList.add('active');
  charts.forEach(entry => drawRRRays(entry));
  refreshRROverlay();
}

// Update all RR price lines in-place (after drag)
function updateRRLines() {
  if (!rrCurrent) return;
  charts.forEach(entry => drawRRRays(entry));
  refreshRROverlay();
}

function clearRR() {
  if (!rrCurrent) return;
  rrCurrent = null;
  charts.forEach(entry => drawRRRays(entry));
  document.getElementById('rrOverlay').style.display = 'none';
  document.getElementById('rrInfo').textContent = '';
  document.getElementById('btnRRToggle').classList.remove('active');
}

function toggleRRVisible() {
  if (!rrCurrent) return;
  rrVisible = !rrVisible;
  document.getElementById('btnRRToggle').classList.toggle('active', rrVisible);

  if (rrVisible) {
    charts.forEach(entry => drawRRRays(entry));
    document.getElementById('rrOverlay').style.display = document.body.classList.contains('rr-toolbar') ? 'flex' : 'block';
  } else {
    charts.forEach(entry => drawRRRays(entry));
    document.getElementById('rrOverlay').style.display = 'none';
  }
}

function formatJSTTime(utcSec) {
  if (utcSec == null || !isFinite(utcSec)) return '—';
  const jst = new Date((utcSec + JST_OFFSET) * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return '未達';
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function crossesPrice(prevPrice, price, target) {
  if (prevPrice == null) return price === target;
  const low = Math.min(prevPrice, price);
  const high = Math.max(prevPrice, price);
  return target >= low && target <= high;
}

function findFirstTouch(targetPrice, startUTC, startIndex = 0) {
  let prevPrice = startIndex > 0 ? ticks[startIndex - 1]?.price : null;
  for (let i = startIndex; i < ticks.length; i++) {
    const t = ticks[i];
    if (!t || t.time < startUTC) {
      prevPrice = t?.price ?? prevPrice;
      continue;
    }
    if (crossesPrice(prevPrice, t.price, targetPrice)) {
      return { tick: t, index: i };
    }
    prevPrice = t.price;
  }
  return null;
}

function measureRRTime() {
  if (!rrCurrent || !ticks.length) return null;
  const startUTC = Math.max(0, (rrCurrent.times.entry ?? getCurrentDisplayTime()) - JST_OFFSET);
  const entryTouch = findFirstTouch(rrCurrent.entry, startUTC, 0);
  if (!entryTouch) {
    return {
      entryTime: null,
      tpTime: null,
      seconds: null,
      label: 'ENTRY未達',
    };
  }
  const tpTouch = findFirstTouch(rrCurrent.tp, entryTouch.tick.time, entryTouch.index);
  if (!tpTouch) {
    return {
      entryTime: entryTouch.tick.time,
      tpTime: null,
      seconds: null,
      label: 'TP未達',
    };
  }
  const seconds = tpTouch.tick.time - entryTouch.tick.time;
  return {
    entryTime: entryTouch.tick.time,
    tpTime: tpTouch.tick.time,
    seconds,
    label: formatDuration(seconds),
  };
}

function refreshRROverlay() {
  if (!rrCurrent) return;
  const { entry, sl, tp } = rrCurrent;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const ratio = risk > 0 ? (reward / risk) : Infinity;
  const isLong = entry > sl;
  const timing = measureRRTime();
  showRROverlay(entry, sl, tp, risk, reward, ratio, isLong, timing);
}

function showRROverlay(entry, sl, tp, risk, reward, ratio, isLong, timing) {
  const el = document.getElementById('rrOverlay');
  const dir = isLong ? 'LONG' : 'SHORT';
  const totalTicks = risk + reward;
  const riskPct = totalTicks > 0 ? (risk / totalTicks * 100) : 50;
  const rewardPct = totalTicks > 0 ? (reward / totalTicks * 100) : 50;

  el.innerHTML = `
    <div class="rr-title">Risk / Reward (${dir})</div>
    <div class="rr-row">
      <span class="rr-entry">ENTRY</span>
      <span class="rr-val rr-entry">${entry.toFixed(1)}</span>
    </div>
    <div class="rr-row">
      <span class="rr-sl">LC</span>
      <span class="rr-val rr-sl">${sl.toFixed(1)} (${risk.toFixed(1)} ticks)</span>
    </div>
    <div class="rr-row">
      <span class="rr-tp">利確 (TP)</span>
      <span class="rr-val rr-tp">${tp.toFixed(1)} (${reward.toFixed(1)} ticks)</span>
    </div>
    <hr style="border-color:#363a45;margin:6px 0;">
    <div class="rr-row">
      <span>RR比</span>
      <span class="rr-ratio">1 : ${ratio === Infinity ? '∞' : ratio.toFixed(2)}</span>
    </div>
    <div class="rr-row">
      <span>ENTRY→TP</span>
      <span class="rr-val">${timing ? timing.label : '—'}</span>
    </div>
    <div class="rr-row rr-time-row" style="font-size:10px;color:#8f96a8;">
      <span>${timing?.entryTime ? formatJSTTime(timing.entryTime) : 'ENTRY —'}</span>
      <span>${timing?.tpTime ? formatJSTTime(timing.tpTime) : 'TP —'}</span>
    </div>
    <div class="rr-bar">
      <div class="rr-bar-risk" style="width:${riskPct}%"></div>
      <div class="rr-bar-reward" style="width:${rewardPct}%"></div>
    </div>
    <div class="rr-foot" style="display:flex;justify-content:space-between;font-size:10px;color:#787b86;margin-top:2px;">
      <span>Risk ${risk.toFixed(1)}</span>
      <span>Reward ${reward.toFixed(1)}</span>
    </div>
    <div class="rr-foot" style="text-align:center;margin-top:6px;font-size:10px;color:#787b86;">ドラッグで移動可</div>
  `;
  el.style.display = document.body.classList.contains('rr-toolbar') ? 'flex' : 'block';
}

// ---------- RR Drag ----------
const DRAG_THRESHOLD_PX = 12; // pixels proximity to grab a line

function findNearestRRLine(chartIndex, yPx) {
  if (!rrCurrent || !rrVisible) return null;
  const { candleSeries } = charts[chartIndex];
  const { entry, sl, tp } = rrCurrent;

  const lines = [
    { key: 'entry', price: entry },
    { key: 'sl',    price: sl },
    { key: 'tp',    price: tp },
  ];

  let best = null;
  let bestDist = Infinity;
  for (const l of lines) {
    const lineY = candleSeries.priceToCoordinate(l.price);
    if (lineY == null) continue;
    const dist = Math.abs(yPx - lineY);
    if (dist < bestDist) {
      bestDist = dist;
      best = l;
    }
  }

  return (best && bestDist <= DRAG_THRESHOLD_PX) ? best : null;
}

// Attach drag handlers to each panel
function setupRRDrag() {
  const panels = document.querySelectorAll('.panel');
  panels.forEach((panel, idx) => {
    panel.addEventListener('mousedown', (e) => {
      if (drawMode) return; // don't interfere with draw tools
      if (!rrCurrent || !rrVisible) return;

      const chartIdx = charts.findIndex(c => c.tf.el === panel.id);
      if (chartIdx < 0) return;

      const rect = panel.getBoundingClientRect();
      const yPx = e.clientY - rect.top;
      const hit = findNearestRRLine(chartIdx, yPx);
      if (!hit) return;

      e.preventDefault();
      e.stopPropagation();
      rrDrag = { lineKey: hit.key, chartIdx };
      document.body.classList.add('rr-dragging');
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!rrDrag || !rrCurrent) return;
    e.preventDefault();

    const chartEntry = charts[rrDrag.chartIdx];
    const panel = document.getElementById(chartEntry.tf.el);
    const rect = panel.getBoundingClientRect();
    const yPx = e.clientY - rect.top;
    const xPx = e.clientX - rect.left;

    const price = chartEntry.candleSeries.coordinateToPrice(yPx);
    if (price == null || isNaN(price)) return;
    const rounded = Math.round(price * 10) / 10;

    // Update rrCurrent values
    rrCurrent[rrDrag.lineKey] = rounded;
    rrCurrent.times[rrDrag.lineKey] = getDisplayTimeFromX(chartEntry, xPx);
    updateRRLines();
  });

  document.addEventListener('mouseup', () => {
    if (rrDrag) {
      document.body.classList.remove('rr-dragging');
      rrDrag = null;
    }
  });
}
setupRRDrag();
setupHLineDrag();

// ---------- Toolbar buttons ----------
document.getElementById('btnHLine').addEventListener('click', () => {
  setDrawMode(drawMode === 'hline' ? null : 'hline');
});
document.getElementById('btnRay').addEventListener('click', () => {
  setDrawMode(drawMode === 'ray' ? null : 'ray');
});
document.getElementById('btnRR').addEventListener('click', () => {
  if (drawMode === 'rr') {
    setDrawMode(null);
  } else {
    clearRR();
    setDrawMode('rr');
  }
});
document.getElementById('btnRRToggle').addEventListener('click', toggleRRVisible);
document.getElementById('btnDelLine').addEventListener('click', () => {
  if (rrCurrent) {
    clearRR();
  } else {
    removeLastLine();
  }
});

// ---------- Keyboard ----------
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const key = e.key.toLowerCase();
  if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    toggleSingleChartMode();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    openTimeframeDialog();
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (key === 'z') {
      e.preventDefault();
      if (rrCurrent) clearRR();
      else removeLastLine();
    }
    return;
  }
  if (e.altKey) {
    switch (key) {
      case 'h':
        e.preventDefault();
        setDrawMode(drawMode === 'hline' ? null : 'hline');
        return;
      case 't':
        e.preventDefault();
        setDrawMode(drawMode === 'ray' ? null : 'ray');
        return;
      case 'c':
        e.preventDefault();
        toggleCrosshairSync();
        return;
      case 'v':
        e.preventDefault();
        toggleVwap();
        return;
      case 'w':
        e.preventDefault();
        openSymbolSearch();
        return;
    }
  }
  if (e.key === '/') {
    if (openSymbolSearch()) e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (multiSymbolDataset && multiSymbolDataset.symbols.length > 1) {
      selectSymbolByOffset(e.shiftKey ? -1 : 1);
      return;
    }
    toggleAutoPlay();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (rrCurrent) clearRR();
    else removeLastLine();
    return;
  }

  switch (key) {
    case 'z': step(-1); break;
    case 'x': step(1); break;
    case 'a': goStart(); break;
    case 'e': goEnd(); break;
    case 's': toggleAutoPlay(); break;
    case 'f': toggleFollow(); break;
    case 'v': toggleVwap(); break;
    case 'h': setDrawMode(drawMode === 'hline' ? null : 'hline'); break;
    case 'r': setDrawMode(drawMode === 'ray' ? null : 'ray'); break;
    case 't': if (drawMode === 'rr') { setDrawMode(null); } else { clearRR(); setDrawMode('rr'); } break;
    case 'g': toggleRRVisible(); break;
    case 'c': toggleCrosshairSync(); break;
    case 'd': if (rrCurrent) { clearRR(); } else { removeLastLine(); } break;
    case '1': setStepSize(1); break;
    case '2': setStepSize(10); break;
    case '3': setStepSize(50); break;
    case '4': setStepSize(100); break;
    case '5': setStepSize(500); break;
    case '6': setStepSize(1000); break;
    case '7': setStepSize(2000); break;
    case '8': jumpMorningEnd(); break;
    case '9': jumpAfternoonEnd(); break;
  }
});

// ---------- Instrument display ----------
function setLoadStatus(message) {
  const el = document.getElementById('loadStatus');
  if (el) el.textContent = message || '';
}

function setInstrumentInfo({ code, name, source } = {}) {
  const el = document.getElementById('instrumentInfo');
  if (!el) return;
  if (!code && !name) {
    el.textContent = '銘柄: —';
    el.title = 'CSVファイル名から銘柄コードを取得し、銘柄名を表示します';
    return;
  }
  const label = name ? `${code || ''} ${name}`.trim() : `${code}`;
  el.textContent = `銘柄: ${label}`;
  el.title = source ? `${label} (${source})` : label;
}

function normalizeStockCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase().replace(/\.T$/i, '');
  if (/^\d{3}[A-Z]0$/.test(c)) return c.slice(0, 4);
  if (/^\d{4}0$/.test(c)) return c.slice(0, 4);
  return c;
}

function extractStockCodeFromName(name) {
  if (!name) return null;
  const base = name.replace(/\.[^.]+$/, '').toUpperCase();
  const tokenCandidates = base.split(/[^0-9A-Z]+/).filter(Boolean);
  for (const token of tokenCandidates) {
    if (/^\d{8}$/.test(token)) continue;
    if (/^\d{4}$/.test(token) || /^\d{3}[A-Z]$/.test(token) || /^\d{3}[A-Z]0$/.test(token)) {
      return normalizeStockCode(token);
    }
  }
  const suffixMatch = base.match(/(\d{4}|\d{3}[A-Z])\.T/i);
  if (suffixMatch) return normalizeStockCode(suffixMatch[1]);
  const loose = base.match(/(?:^|[^0-9A-Z])(\d{4}|\d{3}[A-Z])(?:[^0-9A-Z]|$)/i);
  if (loose) return normalizeStockCode(loose[1]);
  return null;
}

function getInstrumentFromFiles(files) {
  const codes = [...new Set(files.map(f => extractStockCodeFromName(f.name)).filter(Boolean))];
  return codes.length === 1 ? { code: codes[0] } : { code: codes[0] || null };
}

function getJstDateFromEpochMicros(epochMicros) {
  const n = Number(epochMicros);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(Math.floor(n / 1000) + JST_OFFSET * 1000);
  return d.toISOString().slice(0, 10);
}

function getJstDateFromFile(file) {
  const n = Number(file && file.lastModified);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n + JST_OFFSET * 1000).toISOString().slice(0, 10);
}

function getJstMidnightUtcSec(dateLabel) {
  if (!dateLabel) return null;
  const [y, m, d] = dateLabel.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d) / 1000 - JST_OFFSET;
}

function detectJsonTradeDate(masters, files) {
  for (const master of Object.values(masters || {})) {
    const dateLabel = getJstDateFromEpochMicros(master && master.timestamp);
    if (dateLabel) return dateLabel;
  }
  for (const file of files || []) {
    const m = file.name && file.name.match(/(\d{4})(\d{2})(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  for (const file of files || []) {
    const dateLabel = getJstDateFromFile(file);
    if (dateLabel) return dateLabel;
  }
  return new Date(Date.now() + JST_OFFSET * 1000).toISOString().slice(0, 10);
}

function parseMappedJsonRecord(row, map, name) {
  if (!row) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  for (const [shortKey, longName] of Object.entries(map || {})) {
    if (longName === name && Object.prototype.hasOwnProperty.call(row, shortKey)) {
      return row[shortKey];
    }
  }
  return undefined;
}

function timestampToUnixSec(value, dayStartUtcSec) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (n > 1e15) return n / 1e6;
  if (n > 1e12) return n / 1000;
  if (dayStartUtcSec != null) {
    if (n > 1e9) return dayStartUtcSec + n / 1e6;
    if (n > 1e6) return dayStartUtcSec + n / 1000;
    return dayStartUtcSec + n;
  }
  return n;
}

function parseMultiSymbolRoot(root, files) {
  const ticksByCode = root.ticks || root.Tick || root.Ticks;
  if (!ticksByCode || typeof ticksByCode !== 'object' || Array.isArray(ticksByCode)) {
    throw new Error('ticks オブジェクトが見つかりません');
  }

  const masters = root.masters || root.master || root.Masters || {};
  const dateLabel = detectJsonTradeDate(masters, files);
  const dayStartUtcSec = getJstMidnightUtcSec(dateLabel);
  const tickMap = root.map || {};
  const symbols = [];

  for (const [rawCode, rows] of Object.entries(ticksByCode)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const code = normalizeStockCode(rawCode);
    const master = masters[rawCode] || masters[code] || {};
    const parsedTicks = rows.map((row, index) => {
      const price = Number(parseMappedJsonRecord(row, tickMap, 'price'));
      const volume = Number(parseMappedJsonRecord(row, tickMap, 'quantity'));
      const rawTime = parseMappedJsonRecord(row, tickMap, 'timestamp');
      const time = timestampToUnixSec(rawTime, dayStartUtcSec);
      const frame = Number(parseMappedJsonRecord(row, tickMap, 'frame'));
      const kind = Number(parseMappedJsonRecord(row, tickMap, 'kind'));
      return { time, price, volume, frame, kind, code, sourceIndex: index };
    }).filter(t => Number.isFinite(t.time) && Number.isFinite(t.price) && Number.isFinite(t.volume));

    parsedTicks.sort((a, b) => (a.time - b.time) || ((a.frame || 0) - (b.frame || 0)) || (a.sourceIndex - b.sourceIndex));
    if (parsedTicks.length) {
      symbols.push({
        code,
        name: master.issueName || (typeof SYMBOL_NAME_FALLBACKS[code] === 'string'
          ? SYMBOL_NAME_FALLBACKS[code]
          : SYMBOL_NAME_FALLBACKS[code]?.name || SYMBOL_NAME_FALLBACKS[code]?.fullName || ''),
        master,
        ticks: parsedTicks,
      });
    }
  }

  symbols.sort((a, b) => b.ticks.length - a.ticks.length || a.code.localeCompare(b.code));
  if (!symbols.length) throw new Error('有効な歩み値が見つかりません');
  return { symbols, sourceName: files.map(f => f.name).join(', '), dateLabel };
}

function parseMultiSymbolTickJson(text, files) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSONの解析に失敗しました: ${err.message}`);
  }
  return parseMultiSymbolRoot(root, files);
}

function mergeJsonParts(parts, files) {
  const root = { ticks: {}, masters: {}, map: null };
  for (const { text, name } of parts) {
    const data = JSON.parse(text);
    if (data.ticks) {
      root.ticks = data.ticks;
      root.map = data.map || root.map;
    } else if (data.ita) {
      root.ita = data.ita;
      root.itaMap = data.map;
    } else {
      const looksLikeMasters = Object.values(data).some(v => v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'issueName'));
      if (looksLikeMasters) root.masters = data;
      else if (name.toLowerCase().includes('master')) root.masters = data;
    }
  }
  if (!root.map) root.map = {};
  return parseMultiSymbolRoot(root, files);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function updateSymbolSelect() {
  const select = document.getElementById('symbolSelect');
  if (!select) return;
  if (!multiSymbolDataset || multiSymbolDataset.symbols.length <= 1) {
    select.style.display = 'none';
    select.innerHTML = '';
    closeSymbolSearch();
    return;
  }
  select.innerHTML = multiSymbolDataset.symbols.map(symbol => {
    const code = escapeHTML(symbol.code);
    const name = symbol.name ? ` ${escapeHTML(symbol.name)}` : '';
    return `<option value="${code}">${code}${name} (${symbol.ticks.length.toLocaleString()}件)</option>`;
  }).join('');
  select.value = currentSymbolCode || multiSymbolDataset.symbols[0].code;
  select.style.display = '';
}

function getCurrentSymbolIndex() {
  if (!multiSymbolDataset || !currentSymbolCode) return -1;
  return multiSymbolDataset.symbols.findIndex(symbol => symbol.code === currentSymbolCode);
}

function selectSymbolByOffset(offset) {
  if (!multiSymbolDataset || multiSymbolDataset.symbols.length <= 1) return false;
  const currentIndex = getCurrentSymbolIndex();
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (baseIndex + offset + multiSymbolDataset.symbols.length) % multiSymbolDataset.symbols.length;
  stopAutoPlay();
  applySymbolDataset(multiSymbolDataset.symbols[nextIndex].code, { replay: false });
  return true;
}

function getSymbolSearchMatches(query = '') {
  if (!multiSymbolDataset) return [];
  const q = query.trim().toLowerCase();
  const symbols = multiSymbolDataset.symbols || [];
  if (!q) return symbols.slice(0, 80);
  return symbols
    .map((symbol, index) => {
      const code = String(symbol.code || '').toLowerCase();
      const name = String(symbol.name || '').toLowerCase();
      let score = 99;
      if (code === q) score = 0;
      else if (code.startsWith(q)) score = 1;
      else if (name.startsWith(q)) score = 2;
      else if (code.includes(q)) score = 3;
      else if (name.includes(q)) score = 4;
      return { symbol, index, score };
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, 80)
    .map(item => item.symbol);
}

function renderSymbolSearchResults() {
  const input = document.getElementById('symbolSearchInput');
  const results = document.getElementById('symbolSearchResults');
  if (!input || !results) return;
  const matches = getSymbolSearchMatches(input.value);
  symbolSearchIndex = Math.max(0, Math.min(symbolSearchIndex, matches.length - 1));
  results.innerHTML = matches.map((symbol, index) => {
    const active = index === symbolSearchIndex ? ' active' : '';
    const code = escapeHTML(symbol.code);
    const name = escapeHTML(symbol.name || '');
    return `<div class="symbol-search-row${active}" data-code="${code}">
      <span class="symbol-search-code">${code}</span>
      <span class="symbol-search-name">${name}</span>
      <span class="symbol-search-count">${symbol.ticks.length.toLocaleString()}件</span>
    </div>`;
  }).join('');
}

function openSymbolSearch(initialText = '') {
  if (!multiSymbolDataset || multiSymbolDataset.symbols.length <= 1) return false;
  const box = document.getElementById('symbolSearch');
  const input = document.getElementById('symbolSearchInput');
  if (!box || !input) return false;
  symbolSearchIndex = 0;
  input.value = initialText;
  box.classList.add('open');
  box.setAttribute('aria-hidden', 'false');
  renderSymbolSearchResults();
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return true;
}

function closeSymbolSearch() {
  const box = document.getElementById('symbolSearch');
  if (!box) return;
  box.classList.remove('open');
  box.setAttribute('aria-hidden', 'true');
}

function applySymbolSearchSelection() {
  const input = document.getElementById('symbolSearchInput');
  const matches = getSymbolSearchMatches(input ? input.value : '');
  const selected = matches[symbolSearchIndex] || matches[0];
  if (!selected) return false;
  closeSymbolSearch();
  stopAutoPlay();
  applySymbolDataset(selected.code, { replay: false });
  return true;
}

function applySymbolDataset(code, { replay = autoReplayOnLoad } = {}) {
  if (!multiSymbolDataset) return;
  const selected = multiSymbolDataset.symbols.find(s => s.code === code) || multiSymbolDataset.symbols[0];
  currentSymbolCode = selected.code;
  ticks = selected.ticks;
  const firstTime = ticks[0]?.time || 0;
  const lastTime = ticks[ticks.length - 1]?.time || firstTime;
  const loadedDays = Math.max(1, Math.round((lastTime - firstTime) / 86400) + 1);
  const effectiveReplay = replay && loadedDays <= 2;
  cursor = effectiveReplay ? 0 : ticks.length - 1;
  updateFollowButton();
  drawnLines.length = 0;
  initCharts();
  render();
  applyInitialChartView();
  setInstrumentInfo({ code: selected.code, name: selected.name, source: 'JSONマスタ' });
  const info = document.getElementById('fileInfo');
  if (info) {
    info.textContent = `${multiSymbolDataset.dateLabel || ''} ${multiSymbolDataset.symbols.length}銘柄`;
    info.title = multiSymbolDataset.sourceName;
  }
  setLoadStatus(effectiveReplay ? '自動再生中' : '読込完了');
  updateSymbolSelect();
  if (effectiveReplay) startAutoPlay();
}

async function lookupInstrumentName(code) {
  code = normalizeStockCode(code);
  if (!code) return null;
  const local = SYMBOL_NAME_FALLBACKS[code];
  if (local) {
    if (typeof local === 'string') return { code, name: local, source: '内蔵銘柄辞書' };
    return {
      code,
      name: local.name || local.fullName,
      source: local.source || '内蔵銘柄辞書',
    };
  }

  const cacheKey = `instrument-name-${code}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  const endpoints = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T`,
    `https://query1.finance.yahoo.com/v1/finance/search?q=${code}.T&quotesCount=1&newsCount=0`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      const quote = data?.quotes?.[0];
      const name = meta?.longName || meta?.shortName || quote?.longname || quote?.shortname;
      if (name) {
        const found = { code, name, source: 'Yahoo Finance' };
        try { localStorage.setItem(cacheKey, JSON.stringify(found)); } catch (_) {}
        return found;
      }
    } catch (_) {}
  }

  return { code, name: null, source: 'コードのみ' };
}

async function updateInstrumentDisplay(files) {
  const instrument = getInstrumentFromFiles(files);
  if (!instrument.code) {
    setInstrumentInfo();
    return;
  }
  setInstrumentInfo({ code: instrument.code, name: '取得中...', source: 'CSVファイル名' });
  const found = await lookupInstrumentName(instrument.code);
  setInstrumentInfo(found || instrument);
}

// ---------- File load (multiple files) ----------
function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ text: reader.result, name: file.name });
    reader.readAsText(file, 'UTF-8');
  });
}

async function loadSelectedCSV({ replay = autoReplayOnLoad } = {}) {
  const fileInput = document.getElementById('csvFile');
  if (!fileInput.files.length) return;

  stopAutoPlay();
  setLoadStatus('JSON対応読込中...');

  const files = [...fileInput.files];
  const jsonFiles = files.filter(f => /\.json$/i.test(f.name) || f.type === 'application/json');
  const csvFiles = files.filter(f => !jsonFiles.includes(f));

  // Sort files by date in filename (oldest first)
  files.sort((a, b) => {
    const da = (a.name.match(/(\d{8})/) || ['', '0'])[1];
    const db = (b.name.match(/(\d{8})/) || ['', '0'])[1];
    return da.localeCompare(db);
  });

  // Read all files in parallel
  const results = await Promise.all(files.map(f => readFileAsText(f)));

  if (jsonFiles.length > 0) {
    try {
      multiSymbolDataset = jsonFiles.length === 1
        ? parseMultiSymbolTickJson(results.find(r => r.name === jsonFiles[0].name).text, jsonFiles)
        : mergeJsonParts(results.filter(r => jsonFiles.some(f => f.name === r.name)), jsonFiles);
      currentSymbolCode = multiSymbolDataset.symbols[0].code;
      applySymbolDataset(currentSymbolCode, { replay });
    } catch (err) {
      console.error(err);
      multiSymbolDataset = null;
      currentSymbolCode = null;
      updateSymbolSelect();
      setLoadStatus('JSON読込エラー');
      alert(err.message || 'JSONを読み込めませんでした');
    }
    return;
  }

  multiSymbolDataset = null;
  currentSymbolCode = null;
  updateSymbolSelect();
  updateInstrumentDisplay(csvFiles);

  // Parse and merge all ticks
  let allTicks = [];
  for (const { text, name } of results) {
    const parsed = parseCSV(text, name);
    allTicks = allTicks.concat(parsed);
  }

  // Sort by time (across all days)
  allTicks.sort((a, b) => a.time - b.time);

  if (allTicks.length === 0) {
    setLoadStatus('有効なデータなし');
    alert('有効なデータがありません');
    return;
  }

  ticks = allTicks;
  const firstTime = ticks[0]?.time || 0;
  const lastTime = ticks[ticks.length - 1]?.time || firstTime;
  const loadedDays = Math.max(1, Math.round((lastTime - firstTime) / 86400) + 1);
  const effectiveReplay = replay && files.length <= 2 && loadedDays <= 2;
  cursor = effectiveReplay ? 0 : ticks.length - 1;
  updateFollowButton();
  // Important: empty in-place (do NOT reassign), otherwise window.__drawnLines
  // keeps pointing at the old array and board.js can't see newly drawn lines.
  drawnLines.length = 0;
  initCharts();
  render();
  applyInitialChartView();

  // Show file info
  const info = document.getElementById('fileInfo');
  if (files.length === 1) {
    info.textContent = files[0].name;
  } else {
    const dates = files.map(f => {
      const m = f.name.match(/(\d{8})/);
      return m ? m[1].slice(4, 6) + '/' + m[1].slice(6, 8) : f.name;
    });
    info.textContent = `${files.length}日分 (${dates.join(', ')})`;
  }
  info.title = files.map(f => f.name).join('\n');
  setLoadStatus(effectiveReplay ? '自動再生中' : '読込完了');
  if (effectiveReplay) startAutoPlay();
}

// ---------- Cloudflare R2 multi-day CSV load ----------
const R2_DATA_CONFIG = window.R2_DATA_CONFIG || {};
let r2ManifestPromise = null;

function compactR2Date(value) {
  return String(value || '').replace(/-/g, '');
}

function displayR2Date(value) {
  const date = compactR2Date(value);
  return /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
}

function escapeR2Html(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

let r2SymbolTreeEntries = [];

function r2SymbolDetails(code) {
  const item = SYMBOL_NAME_FALLBACKS[code];
  if (typeof item === 'string') return { name: item, market: 'その他' };
  return {
    name: item?.name || item?.fullName || '',
    market: item?.market || 'その他',
  };
}

function r2MarketGroup(market) {
  const value = String(market || '');
  if (value.includes('プライム')) return 'プライム';
  if (value.includes('スタンダード')) return 'スタンダード';
  if (value.includes('グロース')) return 'グロース';
  if (value.includes('ETF') || value.includes('ETN')) return 'ETF・ETN';
  if (value.includes('PRO Market')) return 'PRO Market';
  return 'その他';
}

function updateR2TreeTrigger(code) {
  code = normalizeStockCode(code || document.getElementById('r2Symbol')?.value);
  const entry = r2SymbolTreeEntries.find(item => item.code === code);
  const button = document.getElementById('btnR2Tree');
  if (!button) return;
  const name = entry?.name || r2SymbolDetails(code).name;
  button.textContent = code ? `${code}${name ? ` ${name}` : ''} ▾` : 'R2銘柄 ▾';
  button.title = entry
    ? `${entry.code} ${entry.name}\n${entry.minDate}〜${entry.maxDate} / ${entry.count}日分`
    : 'R2にある銘柄をツリーから選択';
}

function renderR2SymbolTree(query = '') {
  const groups = document.getElementById('r2TreeGroups');
  if (!groups) return;
  const keyword = String(query || '').trim().toLowerCase();
  const current = normalizeStockCode(document.getElementById('r2Symbol')?.value);
  const filtered = r2SymbolTreeEntries.filter(item =>
    !keyword || `${item.code} ${item.name} ${item.market}`.toLowerCase().includes(keyword)
  );
  if (!filtered.length) {
    groups.innerHTML = '<div class="r2-tree-empty">該当するR2銘柄はありません</div>';
    return;
  }

  const order = ['プライム', 'スタンダード', 'グロース', 'ETF・ETN', 'PRO Market', 'その他'];
  const grouped = new Map(order.map(label => [label, []]));
  filtered.forEach(item => grouped.get(item.group)?.push(item));
  groups.innerHTML = order.map(label => {
    const entries = grouped.get(label) || [];
    if (!entries.length) return '';
    const rows = entries.map(item => `
      <button type="button" class="r2-tree-row${item.code === current ? ' active' : ''}"
        role="treeitem" data-r2-code="${escapeR2Html(item.code)}"
        title="${escapeR2Html(`${item.minDate}〜${item.maxDate} / ${item.count}日分を結合`)}">
        <span class="r2-tree-code">${escapeR2Html(item.code)}</span>
        <span class="r2-tree-name">${escapeR2Html(item.name || '銘柄名未登録')}</span>
        <span class="r2-tree-days">${item.count}日分</span>
      </button>`).join('');
    return `<details class="r2-tree-group" open>
      <summary>${escapeR2Html(label)}（${entries.length}銘柄）</summary>${rows}
    </details>`;
  }).join('');
}

function placeR2SymbolTree() {
  const button = document.getElementById('btnR2Tree');
  const tree = document.getElementById('r2SymbolTree');
  if (!button || !tree) return;
  const rect = button.getBoundingClientRect();
  const width = Math.min(470, window.innerWidth - 16);
  tree.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  tree.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 80)}px`;
}

function setR2SymbolTreeOpen(open) {
  const button = document.getElementById('btnR2Tree');
  const tree = document.getElementById('r2SymbolTree');
  const search = document.getElementById('r2TreeSearch');
  if (!button || !tree) return;
  tree.classList.toggle('open', open);
  tree.setAttribute('aria-hidden', open ? 'false' : 'true');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    placeR2SymbolTree();
    renderR2SymbolTree(search?.value || '');
    setTimeout(() => search?.focus(), 0);
  }
}

async function selectR2SymbolFromTree(code) {
  const manifest = await getR2Manifest().catch(() => null);
  const input = document.getElementById('r2Symbol');
  if (!manifest || !input) return;
  input.value = code;
  setR2DateBounds(manifest, code, { reset: true });
  updateR2TreeTrigger(code);
  setR2SymbolTreeOpen(false);
  await loadR2Symbol();
}

async function getR2Manifest() {
  if (!R2_DATA_CONFIG.manifestUrl) throw new Error('R2マニフェストURLが設定されていません');
  if (!r2ManifestPromise) {
    const manifestUrl = new URL(R2_DATA_CONFIG.manifestUrl, location.href);
    manifestUrl.searchParams.set('_updated', String(Date.now()));
    r2ManifestPromise = fetch(manifestUrl, { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(`R2一覧 HTTP ${response.status}`);
      return response.json();
    }).catch(error => {
      r2ManifestPromise = null;
      throw error;
    });
  }
  return r2ManifestPromise;
}

function r2FilesForCode(manifest, code) {
  return (manifest.files || [])
    .filter(file => normalizeStockCode(file.code) === code)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function setR2DateBounds(manifest, code, { reset = false } = {}) {
  const files = r2FilesForCode(manifest, code);
  updateR2TreeTrigger(code);
  if (!files.length) return files;
  const from = document.getElementById('r2DateFrom');
  const to = document.getElementById('r2DateTo');
  const min = displayR2Date(files[0].date);
  const max = displayR2Date(files[files.length - 1].date);
  if (from) {
    from.min = min;
    from.max = max;
    if (reset || !from.value || from.value < min || from.value > max) from.value = min;
  }
  if (to) {
    to.min = min;
    to.max = max;
    if (reset || !to.value || to.value < min || to.value > max) to.value = max;
  }
  return files;
}

async function initializeR2Controls() {
  try {
    const manifest = await getR2Manifest();
    const symbols = new Map();
    (manifest.files || []).forEach(file => {
      const code = normalizeStockCode(file.code);
      if (!code) return;
      const row = symbols.get(code) || { code, count: 0, minDate: file.date, maxDate: file.date };
      row.count += 1;
      if (file.date < row.minDate) row.minDate = file.date;
      if (file.date > row.maxDate) row.maxDate = file.date;
      symbols.set(code, row);
    });
    r2SymbolTreeEntries = [...symbols.values()].map(row => {
      const details = r2SymbolDetails(row.code);
      return { ...row, ...details, group: r2MarketGroup(details.market) };
    }).sort((a, b) => a.code.localeCompare(b.code));
    renderR2SymbolTree();
    const code = normalizeStockCode(document.getElementById('r2Symbol')?.value);
    if (code) setR2DateBounds(manifest, code);
    else updateR2TreeTrigger('');
    return manifest;
  } catch (error) {
    console.error(error);
    setLoadStatus('R2一覧取得エラー');
    return null;
  }
}

function publicR2ObjectUrl(baseUrl, key) {
  const encodedKey = String(key || '').split('/').map(encodeURIComponent).join('/');
  return `${String(baseUrl || '').replace(/\/$/, '')}/${encodedKey}`;
}

async function loadR2Symbol() {
  const input = document.getElementById('r2Symbol');
  const button = document.getElementById('btnLoadR2');
  const fromInput = document.getElementById('r2DateFrom');
  const toInput = document.getElementById('r2DateTo');
  const code = normalizeStockCode(input?.value);
  if (!code || !/^\d{3}[A-Z0-9]$/.test(code)) {
    alert('銘柄コードを入力してください（例: 9984 / 285A）');
    input?.focus();
    return;
  }
  if (!R2_DATA_CONFIG.manifestUrl) {
    alert('R2マニフェストURLが設定されていません');
    return;
  }

  stopAutoPlay();
  if (button) button.disabled = true;
  setLoadStatus('R2一覧を確認中...');

  try {
    const manifest = await getR2Manifest();
    const allCandidates = setR2DateBounds(manifest, code);
    const fromDate = compactR2Date(fromInput?.value);
    const toDate = compactR2Date(toInput?.value);
    if (fromDate && toDate && fromDate > toDate) throw new Error('開始日は終了日以前にしてください');
    const requestedCandidates = allCandidates.filter(file =>
      (!fromDate || file.date >= fromDate) && (!toDate || file.date <= toDate)
    );
    // `fast=1` keeps intraday replay responsive. Daily history is loaded from
    // the local precomputed cache by the recovery add-on.
    const fastMode = new URLSearchParams(location.search).get('fast') === '1';
    const candidates = fastMode && requestedCandidates.length > 7 ? requestedCandidates.slice(-7) : requestedCandidates;

    if (!candidates.length) {
      throw new Error(`${code} のCSVはR2一覧にありません`);
    }

    const baseUrl = manifest.publicBaseUrl || R2_DATA_CONFIG.publicBaseUrl;
    if (!baseUrl) throw new Error('R2公開URLが設定されていません');

    const groups = new Array(candidates.length);
    let nextIndex = 0;
    let completed = 0;
    const workerCount = Math.min(3, candidates.length);

    async function worker() {
      while (nextIndex < candidates.length) {
        const index = nextIndex++;
        const file = candidates[index];
        const response = await fetch(publicR2ObjectUrl(baseUrl, file.key), { cache: 'force-cache' });
        if (!response.ok) throw new Error(`${file.key} HTTP ${response.status}`);
        const text = await response.text();
        groups[index] = parseCSV(text, file.key);
        completed++;
        setLoadStatus(`R2読込 ${completed}/${candidates.length}日`);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const allTicks = groups.flat().sort((a, b) => a.time - b.time);
    if (!allTicks.length) throw new Error('有効な歩み値データがありません');

    multiSymbolDataset = null;
    currentSymbolCode = null;
    updateSymbolSelect();
    ticks = allTicks;
    cursor = ticks.length - 1;
    updateFollowButton();
    drawnLines.length = 0;
    initCharts();
    render();
    applyInitialChartView();

    const remoteFiles = candidates.map(file => ({ name: file.key.split('/').pop() }));
    updateInstrumentDisplay(remoteFiles);
    const firstDate = candidates[0].date;
    const lastDate = candidates[candidates.length - 1].date;
    const info = document.getElementById('fileInfo');
    if (info) {
      info.textContent = `R2 ${candidates.length}日分`;
      info.title = `${firstDate}〜${lastDate}\n${candidates.map(file => file.key).join('\n')}`;
    }
    if (/^https?:$/.test(location.protocol)) {
      const url = new URL(location.href);
      url.searchParams.set('symbol', code);
      if (fromDate) url.searchParams.set('from', fromDate); else url.searchParams.delete('from');
      if (toDate) url.searchParams.set('to', toDate); else url.searchParams.delete('to');
      history.replaceState(null, '', url);
    }
    const fastNote = fastMode && requestedCandidates.length > candidates.length ? `（高速: ${requestedCandidates.length}日中${candidates.length}日）` : '';
    setLoadStatus(`R2結合完了 ${candidates.length}日 / ${ticks.length.toLocaleString()}件${fastNote}`);
    window.dispatchEvent(new CustomEvent('codelaggy:r2loaded', { detail: { code } }));
  } catch (error) {
    console.error(error);
    setLoadStatus('R2読込エラー');
    alert(error.message || 'R2データを読み込めませんでした');
  } finally {
    if (button) button.disabled = false;
  }
}

async function applyR2DatePreset(mode) {
  const code = normalizeStockCode(document.getElementById('r2Symbol')?.value);
  if (!code) return;
  const manifest = await getR2Manifest().catch(() => null);
  if (!manifest) return;
  const files = setR2DateBounds(manifest, code, { reset: true });
  if (!files.length) return;
  const from = document.getElementById('r2DateFrom');
  const to = document.getElementById('r2DateTo');
  if (mode === 'latest' && from && to) from.value = to.value;
  await loadR2Symbol();
}

document.getElementById('csvFile').addEventListener('change', () => {
  loadSelectedCSV({ replay: true });
});

document.getElementById('btnLoadR2')?.addEventListener('click', loadR2Symbol);
document.getElementById('btnR2Latest')?.addEventListener('click', () => applyR2DatePreset('latest'));
document.getElementById('btnR2All')?.addEventListener('click', () => applyR2DatePreset('all'));
document.getElementById('btnR2Tree')?.addEventListener('click', () => {
  const tree = document.getElementById('r2SymbolTree');
  setR2SymbolTreeOpen(!tree?.classList.contains('open'));
});
document.getElementById('r2TreeSearch')?.addEventListener('input', event => {
  renderR2SymbolTree(event.target.value);
});
document.getElementById('r2TreeSearch')?.addEventListener('keydown', event => {
  if (event.key === 'Escape') setR2SymbolTreeOpen(false);
});
document.getElementById('r2TreeGroups')?.addEventListener('click', event => {
  const row = event.target.closest('[data-r2-code]');
  if (row) selectR2SymbolFromTree(row.dataset.r2Code);
});
document.addEventListener('mousedown', event => {
  const tree = document.getElementById('r2SymbolTree');
  const button = document.getElementById('btnR2Tree');
  if (tree?.classList.contains('open') && !tree.contains(event.target) && !button?.contains(event.target)) {
    setR2SymbolTreeOpen(false);
  }
});
window.addEventListener('resize', () => {
  if (document.getElementById('r2SymbolTree')?.classList.contains('open')) placeR2SymbolTree();
});
document.getElementById('r2Symbol')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadR2Symbol();
});
document.getElementById('r2Symbol')?.addEventListener('change', async (event) => {
  const manifest = await getR2Manifest().catch(() => null);
  const code = normalizeStockCode(event.target.value);
  if (manifest && code) setR2DateBounds(manifest, code, { reset: true });
});

document.getElementById('symbolSelect').addEventListener('change', (e) => {
  stopAutoPlay();
  applySymbolDataset(e.target.value, { replay: false });
});

const symbolSearchInput = document.getElementById('symbolSearchInput');
if (symbolSearchInput) {
  symbolSearchInput.addEventListener('input', () => {
    symbolSearchIndex = 0;
    renderSymbolSearchResults();
  });
  symbolSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSymbolSearch();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const matches = getSymbolSearchMatches(symbolSearchInput.value);
      symbolSearchIndex = Math.min(symbolSearchIndex + 1, Math.max(0, matches.length - 1));
      renderSymbolSearchResults();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      symbolSearchIndex = Math.max(0, symbolSearchIndex - 1);
      renderSymbolSearchResults();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      applySymbolSearchSelection();
    }
  });
}

const symbolSearchResults = document.getElementById('symbolSearchResults');
if (symbolSearchResults) {
  symbolSearchResults.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.symbol-search-row');
    if (!row) return;
    e.preventDefault();
    closeSymbolSearch();
    stopAutoPlay();
    applySymbolDataset(row.dataset.code, { replay: false });
  });
}

(function setupToolbarControls() {
  const volumeCandleBtn = document.getElementById('btnVolumeCandle');
  if (volumeCandleBtn) {
    volumeCandleBtn.classList.toggle('active', volumeCandleEnabled);
    volumeCandleBtn.textContent = `VolCandle: ${volumeCandleEnabled ? 'ON' : 'OFF'}`;
    volumeCandleBtn.addEventListener('click', () => {
      volumeCandleEnabled = !volumeCandleEnabled;
      volumeCandleBtn.classList.toggle('active', volumeCandleEnabled);
      volumeCandleBtn.textContent = `VolCandle: ${volumeCandleEnabled ? 'ON' : 'OFF'}`;
      volumeCandleBtn.title = volumeCandleEnabled
        ? '標準ローソク足に戻す'
        : '出来高が多い足を太く表示';
      applyVolumeCandleMode();
    });
  }

  const boardProfileBtn = document.getElementById('btnBoardProfile');
  if (boardProfileBtn) {
    boardProfileBtn.addEventListener('click', toggleBoardProfile);
  }

  const executedProfileBtn = document.getElementById('btnExecutedProfile');
  if (executedProfileBtn) {
    executedProfileBtn.addEventListener('click', toggleExecutedProfile);
  }
  const jumpMorningEndBtn = document.getElementById('btnJumpMorningEnd');
  if (jumpMorningEndBtn) jumpMorningEndBtn.addEventListener('click', jumpMorningEnd);
  const jumpAfternoonEndBtn = document.getElementById('btnJumpAfternoonEnd');
  if (jumpAfternoonEndBtn) jumpAfternoonEndBtn.addEventListener('click', jumpAfternoonEnd);
  const boardProfileSettingsBtn = document.getElementById('btnBoardProfileSettings');
  if (boardProfileSettingsBtn) boardProfileSettingsBtn.addEventListener('click', toggleBoardProfile);
  const executedProfileSettingsBtn = document.getElementById('btnExecutedProfileSettings');
  if (executedProfileSettingsBtn) executedProfileSettingsBtn.addEventListener('click', toggleExecutedProfile);
  updateProfileButtons();

  const rowsBtn = document.getElementById('btnToolbarRows');
  if (rowsBtn) {
    rowsBtn.addEventListener('click', () => {
      document.body.classList.toggle('toolbar-two-lines');
      const twoLines = document.body.classList.contains('toolbar-two-lines');
      rowsBtn.classList.toggle('active', twoLines);
      rowsBtn.textContent = `ツールバー: ${twoLines ? '1列' : '2列'}`;
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }

  const moveBtn = document.getElementById('btnPosMove');
  const hideBtn = document.getElementById('btnPosHide');
  const settingsBtn = document.getElementById('btnSettings');
  const settingsMenu = document.getElementById('settingsMenu');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsClose = document.getElementById('btnSettingsClose');
  const positions = ['', 'pos-float-left', 'pos-float-right'];
  let posIndex = 0;
  function setSettingsOpen(open) {
    if (!settingsMenu || !settingsBackdrop) return;
    settingsMenu.classList.toggle('open', open);
    settingsBackdrop.classList.toggle('open', open);
  }
  if (settingsBtn && settingsMenu && settingsBackdrop) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSettingsOpen(!settingsMenu.classList.contains('open'));
    });
    settingsBackdrop.addEventListener('click', () => setSettingsOpen(false));
    if (settingsClose) settingsClose.addEventListener('click', () => setSettingsOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    });
  }
  const executedLabelsCheck = document.getElementById('chkExecutedLabels');
  if (executedLabelsCheck) {
    executedLabelsCheck.checked = executedProfileLabelsVisible;
    executedLabelsCheck.addEventListener('change', () => {
      executedProfileLabelsVisible = executedLabelsCheck.checked;
      charts.forEach(entry => drawExecutedProfile(entry));
    });
  }
  const dayVolLeftCheck = document.getElementById('chkDayVolLeft');
  if (dayVolLeftCheck) {
    dayVolLeftCheck.addEventListener('change', () => {
      document.body.classList.toggle('dayvol-left', dayVolLeftCheck.checked);
    });
  }
  const rrToolbarCheck = document.getElementById('chkRrToolbar');
  if (rrToolbarCheck) {
    rrToolbarCheck.addEventListener('change', () => setRrToolbarMode(rrToolbarCheck.checked));
  }
  const vwapLabelCheck = document.getElementById('btnVwapLabel');
  if (vwapLabelCheck) {
    vwapLabelCheck.checked = vwapLabelVisible;
    vwapLabelCheck.addEventListener('change', toggleVwapLabel);
  }
  const vwapColorInput = document.getElementById('vwapColor');
  if (vwapColorInput) {
    vwapColorInput.addEventListener('input', (e) => changeVwapColor(e.target.value));
  }
  const topInfoCheck = document.getElementById('chkTopInfoHidden');
  if (topInfoCheck) {
    topInfoCheck.addEventListener('change', () => {
      document.body.classList.toggle('top-info-hidden', topInfoCheck.checked);
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }
  const toolbarToolsCheck = document.getElementById('chkToolbarToolsHidden');
  if (toolbarToolsCheck) {
    toolbarToolsCheck.addEventListener('change', () => {
      document.body.classList.toggle('toolbar-tools-hidden', toolbarToolsCheck.checked);
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  }
  setupProfileTfControls();
  if (moveBtn) {
    moveBtn.addEventListener('click', () => {
      positions.forEach(c => { if (c) document.body.classList.remove(c); });
      posIndex = (posIndex + 1) % positions.length;
      if (positions[posIndex]) document.body.classList.add(positions[posIndex]);
      const label = posIndex === 0 ? '列内' : posIndex === 1 ? '左上' : '右上';
      moveBtn.textContent = label;
    });
  }
  if (hideBtn) {
    hideBtn.addEventListener('click', () => {
      document.body.classList.toggle('pos-hidden');
      const hidden = document.body.classList.contains('pos-hidden');
      hideBtn.classList.toggle('active', hidden);
      hideBtn.textContent = hidden ? '表示' : '隠す';
    });
  }
})();

// ---------- Demo data ----------
function generateDemo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  // 09:00 JST in real UTC
  const openUTC = Date.parse(`${y}-${m}-${d}T09:00:00+09:00`) / 1000;

  const demo = [];
  let price = 1800;
  for (let i = 0; i < 3000; i++) {
    price += (Math.random() - 0.498) * 2;
    price = Math.round(price * 10) / 10;
    demo.push({
      time: openUTC + i * 3,
      price,
      volume: Math.floor(Math.random() * 500 + 100) * 100,
    });
  }
  return demo;
}

(function boot() {
  ticks = generateDemo();
  cursor = ticks.length - 1;
  setupActiveChartTracking();
  setActiveChartPanel(activeChartPanelId);
  initCharts();
  render();
  setTimeout(async () => {
    render();
    applyInitialChartView();
    const params = new URLSearchParams(location.search);
    const requestedSymbol = normalizeStockCode(params.get('symbol'));
    const requestedFrom = displayR2Date(params.get('from'));
    const requestedTo = displayR2Date(params.get('to'));
    await initializeR2Controls();
    if (requestedSymbol) {
      const input = document.getElementById('r2Symbol');
      if (input) input.value = requestedSymbol;
      const manifest = await getR2Manifest().catch(() => null);
      if (manifest) {
        setR2DateBounds(manifest, requestedSymbol, {
          reset: !requestedFrom && !requestedTo,
        });
        if (requestedFrom) document.getElementById('r2DateFrom').value = requestedFrom;
        if (requestedTo) document.getElementById('r2DateTo').value = requestedTo;
        if (!requestedFrom && !requestedTo) {
          const from = document.getElementById('r2DateFrom');
          const to = document.getElementById('r2DateTo');
          if (from && to) from.value = to.value;
        }
      }
      loadR2Symbol();
    }
  }, 0);
})();
