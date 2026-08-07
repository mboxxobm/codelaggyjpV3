/* ===== Board & Ayumi sidebar — CSV-derived order book =====
 *
 * Philosophy: The board is NOT synthetic. Every share shown on the board
 * corresponds to a REAL future trade from the loaded CSV 歩み値.
 *
 *   total[price]     = Σ volume over all trades at that price
 *   executed[price]  = Σ volume over trades at index ≤ cursor
 *   remaining[price] = total - executed   (orders not yet consumed)
 *
 * Side classification (heuristic, since CSV has no taker-side info):
 *   price > current_price  →  sell limit (ask)
 *   price < current_price  →  buy limit (bid)
 *   price == current_price →  skip (about to trade here)
 *
 * This reproduces the property the user requested: a trade that will
 * execute at 15:25 at ¥5800 is visible on the board from 09:00, and
 * disappears the moment the cursor passes that execution.
 */

(function () {
  const DAY_RANGE_BUFFER = 30;     // show ±30 ticks beyond day's high/low
  const BOARD_RENDER_RADIUS = 160; // virtualize ladder around current price (max 321 rows)
  const AYUMI_WINDOW = 120;
  let dayMin = null, dayMax = null; // day's traded range (from entire CSV)
  let tickSize = 1;                 // detected price increment (呼び値)
  let dayTotalVolume = 0;           // sum of all volumes across entire CSV

  // CSV-derived aggregates (rebuilt on new dataset)
  let totalPerPrice = new Map();   // price -> total volume across entire file
  let executedPerPrice = new Map();// price -> volume up to and including cursor
  let prevCursor = -1;
  let prevTicksLen = 0;
  let prevFirstTickTime = null;

  // User-toggled price markers (Set of normalized price numbers)
  const markedPrices = new Set();
  // Last seen state for re-render on demand
  let lastTicks = null;
  let lastCursor = -1;
  let crosshairPrice = null;  // for crosshair-highlighted row

  function fmt(n) { return Math.round(n).toLocaleString(); }

  function rebuildTotals(ticks) {
    totalPerPrice.clear();
    executedPerPrice.clear();
    dayMin = null; dayMax = null;
    dayTotalVolume = 0;
    for (const t of ticks) {
      totalPerPrice.set(t.price, (totalPerPrice.get(t.price) || 0) + (t.volume || 0));
      dayTotalVolume += (t.volume || 0);
      if (dayMin == null || t.price < dayMin) dayMin = t.price;
      if (dayMax == null || t.price > dayMax) dayMax = t.price;
    }
    prevCursor = -1;
    tickSize = detectTickSize();
    updateTickInfo();
    updateDayVolume();
    // Propagate tick size to charts for axis formatting
    if (window.__applyTickSize) window.__applyTickSize(tickSize);
  }

  function updateDayVolume() {
    const el = document.getElementById('dayVolValue');
    if (el) el.textContent = fmt(dayTotalVolume);
  }

  function detectTickSize() {
    const prices = [...totalPerPrice.keys()].sort((a, b) => a - b);
    if (prices.length < 2) return 1;
    // Determine max fractional decimals to scale to integer space
    let maxDecimals = 0;
    for (const p of prices) {
      const s = p.toString();
      const dot = s.indexOf('.');
      if (dot >= 0) maxDecimals = Math.max(maxDecimals, s.length - dot - 1);
    }
    const scale = Math.pow(10, maxDecimals);
    const gcdI = (a, b) => b === 0 ? a : gcdI(b, a % b);
    let g = 0;
    for (let i = 1; i < prices.length; i++) {
      const d = Math.round((prices[i] - prices[i - 1]) * scale);
      if (d > 0) g = gcdI(g, d);
      if (g === 1) break;
    }
    return (g || 1) / scale;
  }

  function priceDecimals() {
    if (tickSize >= 1) return 0;
    const s = tickSize.toString();
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : (s.length - dot - 1);
  }

  function normalizePrice(p) {
    const d = priceDecimals();
    return +p.toFixed(d);
  }

  function formatPrice(p) {
    return normalizePrice(p).toFixed(priceDecimals());
  }

  function updateTickInfo() {
    const el = document.getElementById('tickInfo');
    if (!el) return;
    if (dayMin == null) { el.textContent = ''; return; }
    el.textContent = `(${tickSize}円刻み / 範囲 ${formatPrice(dayMin)}〜${formatPrice(dayMax)})`;
  }

  function setExecutedUpTo(ticks, cursor) {
    if (cursor === prevCursor) return;
    if (cursor > prevCursor) {
      for (let i = prevCursor + 1; i <= cursor; i++) {
        const t = ticks[i];
        if (!t) continue;
        executedPerPrice.set(t.price, (executedPerPrice.get(t.price) || 0) + (t.volume || 0));
      }
    } else {
      // Rewind
      for (let i = prevCursor; i > cursor; i--) {
        const t = ticks[i];
        if (!t) continue;
        const v = (executedPerPrice.get(t.price) || 0) - (t.volume || 0);
        if (v <= 0) executedPerPrice.delete(t.price);
        else executedPerPrice.set(t.price, v);
      }
    }
    prevCursor = cursor;
  }

  function getRemaining(price) {
    return (totalPerPrice.get(price) || 0) - (executedPerPrice.get(price) || 0);
  }

  function renderBoard(currentPrice) {
    const body = document.getElementById('boardBody');
    if (!body || dayMin == null || dayMax == null) return;

    // Full day range + buffer, stepping by detected tick size.
    const fullTop = normalizePrice(dayMax + DAY_RANGE_BUFFER * tickSize);
    const fullBot = normalizePrice(dayMin - DAY_RANGE_BUFFER * tickSize);
    // Align current price to nearest tick
    const curAligned = normalizePrice(
      Math.round((currentPrice - dayMax) / tickSize) * tickSize + dayMax
    );
    // Rendering thousands of empty historical price rows on every Z/X press is
    // expensive. Keep aggregate totals for the full dataset, but virtualize the
    // visible ladder to the range traders actually inspect around current price.
    const top = normalizePrice(Math.min(fullTop, curAligned + BOARD_RENDER_RADIUS * tickSize));
    const bot = normalizePrice(Math.max(fullBot, curAligned - BOARD_RENDER_RADIUS * tickSize));
    const totalSteps = Math.round((top - bot) / tickSize);

    // Compute max qty among all remaining for bar scaling.
    // Also compute session-total (X, Y) = total volume ever at prices above/below current.
    let maxQty = 1;
    let totalAsk = 0, totalBid = 0;         // A, B (remaining)
    let sessionAsk = 0, sessionBid = 0;     // X, Y (full-session total)
    for (const [p, totalQ] of totalPerPrice) {
      if (p > currentPrice) sessionAsk += totalQ;
      else if (p < currentPrice) sessionBid += totalQ;
      const rem = getRemaining(p);
      if (rem <= 0) continue;
      if (p > currentPrice) totalAsk += rem;
      else if (p < currentPrice) totalBid += rem;
      if (rem > maxQty) maxQty = rem;
    }

    // Build a map: tick-snapped price -> hline color (from drawn horizontal lines)
    // We snap to tickSize (not just normalizePrice) so that e.g. a line at
    // ¥32811.7 on a 10-yen-tick stock is still matched to the ¥32810 board row.
    const lineColorAt = new Map();
    const lines = window.__drawnLines || [];
    for (const L of lines) {
      if (L.type !== 'hline') continue;
      const snapped = normalizePrice(Math.round(L.price / tickSize) * tickSize);
      lineColorAt.set(snapped, L.color);
    }

    // Crosshair-highlighted price (aligned to tick)
    const crossAligned = crosshairPrice != null
      ? normalizePrice(Math.round((crosshairPrice - dayMax) / tickSize) * tickSize + dayMax)
      : null;

    // Helper: compose price-cell classes + inline style
    function priceCell(p, label, isCurrent) {
      const classes = ['price'];
      let style = '';
      const hlColor = lineColorAt.get(p);
      if (hlColor) {
        classes.push('hl-colored');
        style = `background:${hlColor};color:#111;`;
      }
      if (markedPrices.has(p)) classes.push('marked');
      if (!isCurrent && crossAligned != null && p === crossAligned) {
        style += 'outline:1px solid #4fc3f7;outline-offset:-1px;';
      }
      return `<td class="${classes.join(' ')}" style="${style}">${label}</td>`;
    }

    // Render top→bottom (high price to low), stepping by tick size via integer index
    let html = '';
    for (let i = 0; i <= totalSteps; i++) {
      const p = normalizePrice(top - i * tickSize);
      const rem = getRemaining(p);
      const isCurrent = p === curAligned;
      const rowClass = isCurrent ? 'last' : '';
      const priceLabel = formatPrice(p);
      const rowAttr = `data-price="${p}"`;
      const pc = priceCell(p, priceLabel, isCurrent);
      if (isCurrent) {
        html += `<tr class="${rowClass}" ${rowAttr}>
          <td></td>${pc}<td></td></tr>`;
      } else if (p > currentPrice) {
        if (rem > 0) {
          const pct = (rem / maxQty * 100).toFixed(1);
          html += `<tr ${rowAttr}>
            <td class="ask"><div class="bar bar-ask" style="width:${pct}%;"></div><span class="content">${fmt(rem)}</span></td>
            ${pc}
            <td></td></tr>`;
        } else {
          html += `<tr ${rowAttr}>
            <td class="ask"></td>${pc}<td></td></tr>`;
        }
      } else {
        if (rem > 0) {
          const pct = (rem / maxQty * 100).toFixed(1);
          html += `<tr ${rowAttr}>
            <td></td>
            ${pc}
            <td class="bid"><div class="bar bar-bid" style="width:${pct}%;"></div><span class="content">${fmt(rem)}</span></td></tr>`;
        } else {
          html += `<tr ${rowAttr}>
            <td></td>${pc}<td class="bid"></td></tr>`;
        }
      }
    }
    body.innerHTML = html;

    // Center current price row in the scroll viewport
    const wrap = document.getElementById('boardWrap');
    const currentRow = body.querySelector(`tr[data-price="${curAligned}"]`);
    if (wrap && currentRow) {
      const wrapRect = wrap.getBoundingClientRect();
      const rowRect = currentRow.getBoundingClientRect();
      const rowOffsetInWrap = (rowRect.top - wrapRect.top) + wrap.scrollTop;
      wrap.scrollTop = rowOffsetInWrap - wrap.clientHeight / 2 + rowRect.height / 2;
    }

    // Stats: A / X (current remaining / session total that will be consumed)
    document.getElementById('sbAsk').innerHTML =
      `${fmt(totalAsk)}<span style="color:#6a7182;font-weight:normal;"> / ${fmt(sessionAsk)}</span>`;
    document.getElementById('sbBid').innerHTML =
      `${fmt(totalBid)}<span style="color:#6a7182;font-weight:normal;"> / ${fmt(sessionBid)}</span>`;
    const ratio = totalAsk > 0 ? totalBid / totalAsk : 0;
    const badge = document.getElementById('boardBadge');
    if (ratio > 1.5) { badge.className = 'badge buy'; badge.textContent = '買い優勢'; }
    else if (ratio < 0.67) { badge.className = 'badge sell'; badge.textContent = '売り優勢'; }
    else { badge.className = 'badge'; badge.textContent = '中立'; }
  }

  function getBoardVolumeProfile(currentPrice) {
    if (dayMin == null || dayMax == null || currentPrice == null) {
      return { rows: [], maxQty: 0, tickSize };
    }
    const rows = [];
    let maxQty = 0;
    for (const [price] of totalPerPrice) {
      const remaining = getRemaining(price);
      if (remaining <= 0) continue;
      const normalized = normalizePrice(price);
      const side = normalized > currentPrice ? 'ask' : normalized < currentPrice ? 'bid' : 'last';
      rows.push({ price: normalized, remaining, side });
      if (remaining > maxQty) maxQty = remaining;
    }
    rows.sort((a, b) => a.price - b.price);
    return { rows, maxQty, tickSize };
  }

  function renderAyumi(ticks, cursor) {
    const wrap = document.getElementById('ayumiWrap');
    if (!wrap) return;
    const end = cursor + 1;
    const start = Math.max(0, end - AYUMI_WINDOW);
    let html = '';
    let prev = start > 0 ? ticks[start - 1].price : null;
    for (let i = start; i < end; i++) {
      const t = ticks[i];
      const tick = prev == null ? 'flat' : t.price > prev ? 'up' : t.price < prev ? 'down' : 'flat';
      const arrow = tick === 'up' ? '▲' : tick === 'down' ? '▼' : '─';
      const jst = new Date((t.time + 9 * 3600) * 1000);
      const hh = String(jst.getUTCHours()).padStart(2, '0');
      const mm = String(jst.getUTCMinutes()).padStart(2, '0');
      const ss = String(jst.getUTCSeconds()).padStart(2, '0');
      const time = `${hh}:${mm}:${ss}`;
      html = `<div class="ayumi-row">
        <span class="t">${time}</span>
        <span class="p ${tick}">${arrow} ${t.price}</span>
        <span class="v">${fmt(t.volume || 0)}</span>
      </div>` + html;
      prev = t.price;
    }
    wrap.innerHTML = html;
    document.getElementById('ayumiCount').textContent = `${end.toLocaleString()} 件`;
  }

  function update(ticks, cursor) {
    if (!ticks || ticks.length === 0) return;
    const cur = ticks[cursor];
    if (!cur) return;
    lastTicks = ticks;
    lastCursor = cursor;

    // Detect new dataset: compare length AND first timestamp
    const firstT = ticks[0] ? ticks[0].time : null;
    if (ticks.length !== prevTicksLen || firstT !== prevFirstTickTime) {
      rebuildTotals(ticks);
      prevTicksLen = ticks.length;
      prevFirstTickTime = firstT;
    }

    setExecutedUpTo(ticks, cursor);

    // Stats readouts
    document.getElementById('sbLast').textContent = cur.price;
    const jst = new Date((cur.time + 9 * 3600) * 1000);
    const hh = String(jst.getUTCHours()).padStart(2, '0');
    const mm = String(jst.getUTCMinutes()).padStart(2, '0');
    const ss = String(jst.getUTCSeconds()).padStart(2, '0');
    document.getElementById('sbTime').textContent = `${hh}:${mm}:${ss}`;

    renderBoard(cur.price);
    renderAyumi(ticks, cursor);
  }

  window.__boardSync = update;

  // Refresh the board without advancing cursor (for hline add/remove/recolor)
  window.__boardRefresh = function () {
    if (!(lastTicks && lastCursor >= 0)) return;
    const wrap = document.getElementById('boardWrap');
    const savedScroll = wrap ? wrap.scrollTop : 0;
    update(lastTicks, lastCursor);
    if (wrap) wrap.scrollTop = savedScroll;
  };

  window.__getBoardVolumeProfile = function () {
    if (!(lastTicks && lastCursor >= 0)) return { rows: [], maxQty: 0, tickSize };
    const cur = lastTicks[lastCursor];
    return cur ? getBoardVolumeProfile(cur.price) : { rows: [], maxQty: 0, tickSize };
  };

  // Highlight a price (called on crosshair move from app.js)
  window.__boardHighlightPrice = function (price) {
    const prev = crosshairPrice;
    crosshairPrice = price;
    if (prev === price) return;
    if (lastTicks && lastCursor >= 0) {
      const cur = lastTicks[lastCursor];
      if (!cur) return;
      const wrap = document.getElementById('boardWrap');
      const savedScroll = wrap ? wrap.scrollTop : 0;
      renderBoard(cur.price);
      if (wrap) wrap.scrollTop = savedScroll;
    }
  };

  // Click handler on board: toggle marker on price cell
  document.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td.price');
    if (!td) return;
    const tr = td.parentElement;
    if (!tr || !tr.dataset.price) return;
    const p = parseFloat(tr.dataset.price);
    if (isNaN(p)) return;
    const np = normalizePrice(p);
    if (markedPrices.has(np)) markedPrices.delete(np);
    else markedPrices.add(np);
    if (window.__boardRefresh) window.__boardRefresh();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnBoardToggle');
    const main = document.getElementById('main');
    if (btn && main) {
      btn.addEventListener('click', () => {
        main.classList.toggle('board-hidden');
        btn.classList.toggle('active');
        window.dispatchEvent(new Event('resize'));
      });
    }

    // Day volume toggle
    const volBtn = document.getElementById('btnVolToggle');
    const volWrap = document.getElementById('dayVolWrap');
    if (volBtn && volWrap) {
      volBtn.addEventListener('click', () => {
        const spans = volWrap.querySelectorAll('span');
        const hidden = volWrap.dataset.hidden === '1';
        volWrap.dataset.hidden = hidden ? '0' : '1';
        spans.forEach(s => {
          if (s.id !== 'btnVolToggle' && s.tagName === 'SPAN') {
            s.style.display = hidden ? '' : 'none';
          }
        });
        volBtn.textContent = hidden ? '👁' : '🚫';
        volBtn.title = hidden ? '出来高を非表示' : '出来高を表示';
      });
    }
  });

  if (window.__requestRender) {
    setTimeout(() => window.__requestRender(), 0);
  }
})();
