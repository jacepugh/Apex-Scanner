/* ── journal.js — tabbed journal: History, Calendar, Chart ── */



let journalTrades = [];
let journalTab = 'history';

// ── LOAD / SAVE ──────────────────────────────────────────
async function journalLoad() {
  try {
    const res = await apiFetch('/api/journal');
    if (res.ok) journalTrades = await res.json();
  } catch (e) {
    if (e.message !== 'Unauthenticated') console.warn('[Journal]', e.message);
    journalTrades = [];
  }
  renderJournal();
}

async function journalSave() {
  try {
    await apiFetch('/api/journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(journalTrades),
    });
  } catch (e) {
    if (e.message !== 'Unauthenticated') console.warn('[Journal save]', e.message);
  }
}

// ── SUB-TABS ─────────────────────────────────────────────
function switchJournalTab(name) {
  journalTab = name;
  document.querySelectorAll('.journal-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.journal-tab-panel').forEach(p => p.classList.toggle('active', p.id === 'jtab-' + name));
  if (name === 'chart')    renderPnlChart();
  if (name === 'calendar') renderCalendar();
}

// ── MAIN RENDER ──────────────────────────────────────────
function renderJournal() {
  updateJournalStats(journalTrades);
  renderDailyBar();
  renderStreakBanner();
  renderTradeList();
  if (journalTab === 'chart')    renderPnlChart();
  if (journalTab === 'calendar') renderCalendar();
}

function renderDailyBar() {
  const today = new Date().toISOString().split('T')[0];
  const todayTrades = journalTrades.filter(t => t.date === today);
  const todayPnl    = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const dailyLimit  = getDailyLossLimit();
  const lossToday   = Math.abs(Math.min(todayPnl, 0));
  const pct = Math.min((lossToday / dailyLimit) * 100, 100);

  const fill = document.getElementById('dlb-fill');
  if (fill) { fill.style.width = pct + '%'; fill.className = 'dlb-fill' + (pct >= 100 ? ' danger' : pct >= 60 ? ' warn' : ''); }
  const maxEl = document.getElementById('dlb-max');
  if (maxEl) maxEl.textContent = '$' + dailyLimit.toFixed(0);
  const usedEl = document.getElementById('dlb-used');
  if (usedEl) usedEl.textContent = '$' + lossToday.toFixed(2);
  const tradesEl = document.getElementById('dlb-trades');
  if (tradesEl) tradesEl.textContent = todayTrades.length + ' trade' + (todayTrades.length !== 1 ? 's' : '') + ' today';
  const pnlEl = document.getElementById('dlb-today-pnl');
  if (pnlEl) { pnlEl.textContent = (todayPnl >= 0 ? '+' : '') + '$' + todayPnl.toFixed(2); pnlEl.style.color = todayPnl >= 0 ? 'var(--green)' : 'var(--red)'; }
}

function renderStreakBanner() {
  let streak = 0;
  for (const t of journalTrades) { if (t.pnl < 0) streak++; else break; }
  document.getElementById('streak-banner')?.classList.toggle('show', streak >= 2);
}

function updateJournalStats(trades) {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins     = trades.filter(t => t.pnl >  0.5);
  const losses   = trades.filter(t => t.pnl < -0.5);
  const winRate  = trades.length ? (wins.length / trades.length * 100) : 0;
  const grossW   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf       = grossL > 0 ? grossW / grossL : grossW > 0 ? 999 : 0;
  const avgW     = wins.length   ? grossW / wins.length   : 0;
  const avgL     = losses.length ? grossL / losses.length : 0;

  const set = (id, text, cls) => { const el = document.getElementById(id); if (el) { el.textContent = text; if (cls) el.className = 'jstat-val ' + cls; } };
  set('j-total-pnl', (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2), totalPnl >= 0 ? 'green' : 'red');
  set('j-winrate',   trades.length ? winRate.toFixed(1) + '%' : '—', winRate >= 50 ? 'green' : winRate > 0 ? 'gold' : '');
  set('j-pf',        pf > 0 ? pf.toFixed(2) : '—', pf >= 1.5 ? 'green' : pf >= 1 ? 'gold' : pf > 0 ? 'red' : '');
  set('j-avgwl',     avgW > 0 ? '+$' + avgW.toFixed(2) + ' / -$' + avgL.toFixed(2) : '—');
}

// ── TRADE LIST ───────────────────────────────────────────
function renderTradeList() {
  const list = document.getElementById('trade-list');
  if (!list) return;
  if (!journalTrades.length) {
    list.innerHTML = '<div class="journal-empty">No trades yet.<br/>Import a CSV or add a trade manually.</div>';
    return;
  }
  list.innerHTML = journalTrades.slice(0, 50).map(t => {
    const cls    = t.pnl > 0.5 ? 'win' : t.pnl < -0.5 ? 'loss' : 'scratch';
    const pnlCls = t.pnl > 0.5 ? 'pos' : t.pnl < -0.5 ? 'neg' : 'zero';
    const notes  = t.notes ? `<div class="tr-notes">${t.notes}</div>` : '';
    return `<div class="trade-row ${cls}">
      <div class="tr-ticker">${t.symbol}</div>
      <div class="tr-meta">
        <div class="tr-prices">$${t.entry.toFixed(2)} → $${t.exit.toFixed(2)} · ${t.qty} shares</div>
        <div class="tr-date">${t.date}</div>
        ${notes}
      </div>
      <div class="tr-pnl ${pnlCls}">${t.pnl >= 0 ? '+' : ''}$${Math.abs(t.pnl).toFixed(2)}</div>
    </div>`;
  }).join('');
}

// ── P&L CHART ────────────────────────────────────────────
function renderPnlChart() {
  const canvas = document.getElementById('pnl-chart-canvas');
  const empty  = document.getElementById('pnl-chart-empty');
  if (!canvas) return;
  if (!journalTrades.length) { canvas.style.display = 'none'; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  canvas.style.display = 'block';

  // Build cumulative equity from sorted trades (oldest first)
  const sorted = [...journalTrades].sort((a, b) => new Date(a.date) - new Date(b.date));
  let cum = 0;
  const points = [0, ...sorted.map(t => { cum += t.pnl; return parseFloat(cum.toFixed(2)); })];

  const DPR  = window.devicePixelRatio || 1;
  const W_CSS = canvas.parentElement.clientWidth || 340;
  const H_CSS = 140;
  canvas.width  = Math.round(W_CSS * DPR);
  canvas.height = Math.round(H_CSS * DPR);
  canvas.style.height = H_CSS + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  const PAD = { t: 12, r: 8, b: 24, l: 50 };
  const W = W_CSS, H = H_CSS;
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;

  const minV = Math.min(0, ...points);
  const maxV = Math.max(0, ...points);
  const range = (maxV - minV) || 1;
  const pad   = range * 0.1;
  const lo = minV - pad, hi = maxV + pad, fullRange = hi - lo;

  const xAt = i => PAD.l + (i / (points.length - 1)) * cW;
  const yAt = v => PAD.t + cH - ((v - lo) / fullRange) * cH;

  ctx.fillStyle = '#0d1219';
  ctx.fillRect(0, 0, W, H);

  // Zero line
  const zeroY = yAt(0);
  ctx.strokeStyle = 'rgba(30,45,66,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W - PAD.r, zeroY); ctx.stroke();
  ctx.setLineDash([]);

  // Fill gradient under curve
  const grad = ctx.createLinearGradient(0, PAD.t, 0, H - PAD.b);
  const isPos = points[points.length - 1] >= 0;
  grad.addColorStop(0, isPos ? 'rgba(0,230,118,0.2)' : 'rgba(255,64,96,0.2)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(xAt(0), zeroY);
  points.forEach((v, i) => ctx.lineTo(xAt(i), yAt(v)));
  ctx.lineTo(xAt(points.length - 1), zeroY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  points.forEach((v, i) => i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v)));
  ctx.strokeStyle = isPos ? 'var(--green)' : 'var(--red)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([]);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = 'rgba(106,144,176,0.8)'; ctx.font = "400 8px 'DM Mono',monospace"; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [lo, (lo + hi) / 2, hi].forEach(v => ctx.fillText((v >= 0 ? '+' : '') + '$' + v.toFixed(0), PAD.l - 4, yAt(v)));

  // X labels — first and last date
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  if (sorted.length) {
    ctx.fillText(sorted[0].date.slice(5), PAD.l, H - PAD.b + 4);
    ctx.textAlign = 'right';
    ctx.fillText(sorted[sorted.length - 1].date.slice(5), W - PAD.r, H - PAD.b + 4);
  }
}

// ── CALENDAR ─────────────────────────────────────────────
let calYear, calMonth;

function renderCalendar() {
  const now = new Date();
  if (calYear === undefined)  calYear  = now.getFullYear();
  if (calMonth === undefined) calMonth = now.getMonth();

  // Build daily P&L map
  const dayMap = {};
  journalTrades.forEach(t => {
    dayMap[t.date] = (dayMap[t.date] || 0) + t.pnl;
  });

  const title = new Date(calYear, calMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('cal-title').textContent = title;

  const grid    = document.getElementById('cal-grid');
  const firstDow = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayStr = now.toISOString().split('T')[0];

  let html = '';
  // Day headers
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d => { html += `<div class="cal-day-label">${d}</div>`; });
  // Empty cells before first day
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-day"></div>';
  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const pnl = dayMap[dateStr];
    const hasTrades = pnl !== undefined;
    const dayCls = hasTrades ? (pnl >= 0 ? 'green-day' : 'red-day') : '';
    const todayCls = dateStr === todayStr ? 'today' : '';
    const pnlLabel = hasTrades ? `<div class="cal-day-pnl">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}</div>` : '';
    html += `<div class="cal-day ${dayCls} ${todayCls} ${hasTrades ? 'has-trades' : ''}">
      <div class="cal-day-num">${d}</div>
      ${pnlLabel}
    </div>`;
  }
  grid.innerHTML = html;
}

function calPrev() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
function calNext() { calMonth++; if (calMonth > 11) { calMonth = 0;  calYear++; } renderCalendar(); }

// ── CSV IMPORT / EXPORT ──────────────────────────────────
function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const lines   = e.target.result.split('\n').filter(Boolean);
    const headers = lines[0].split(',').map(h => h.trim());
    const idx = h => headers.indexOf(h);
    const existing = new Set(journalTrades.map(t => t.id));
    let added = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 8) continue;
      const id = cols[idx('Position ID')]?.trim();
      if (!id || existing.has(id)) continue;
      journalTrades.push({
        id,
        date:   cols[idx('Date')]?.trim(),
        symbol: cols[idx('Symbol')]?.trim(),
        side:   cols[idx('Side')]?.trim(),
        qty:    parseInt(cols[idx('Quantity')]) || 0,
        entry:  parseFloat(cols[idx('Entry Price')]) || 0,
        exit:   parseFloat(cols[idx('Exit Price')])  || 0,
        pnl:    parseFloat(cols[idx('P&L')]) || 0,
        notes:  cols[idx('Notes')]?.trim() || '',
      });
      added++;
    }
    journalTrades.sort((a, b) => new Date(b.date) - new Date(a.date));
    journalSave();
    renderJournal();
    event.target.value = '';
    alert(added + ' new trades imported');
  };
  reader.readAsText(file);
}

function exportCSV() {
  if (!journalTrades.length) { alert('No trades to export'); return; }
  const rows = journalTrades.map(t => [t.id, t.date, t.symbol, t.side || 'Long', t.qty, t.entry, t.exit, t.pnl, '0.00', t.notes || ''].join(','));
  const blob = new Blob([['Position ID,Date,Symbol,Side,Quantity,Entry Price,Exit Price,P&L,Commission,Notes', ...rows].join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'scanny_trades_' + new Date().toISOString().split('T')[0] + '.csv';
  a.click(); URL.revokeObjectURL(url);
}

// ── ADD TRADE MODAL ──────────────────────────────────────
function openAddTrade() {
  document.getElementById('at-date').value = new Date().toISOString().split('T')[0];
  ['at-ticker','at-entry','at-exit','at-shares','at-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const p = document.getElementById('at-pnl-preview');
  p.textContent = '—'; p.style.color = 'var(--dim)';
  document.getElementById('add-trade-overlay').classList.add('open');
  setTimeout(() => document.getElementById('at-ticker').focus(), 100);
}

function closeAddTradeModal() { document.getElementById('add-trade-overlay').classList.remove('open'); }
function closeAddTrade(e) { if (e.target === document.getElementById('add-trade-overlay')) closeAddTradeModal(); }

function previewPnl() {
  const entry  = parseFloat(document.getElementById('at-entry').value) || 0;
  const exit   = parseFloat(document.getElementById('at-exit').value)  || 0;
  const shares = parseInt(document.getElementById('at-shares').value)  || 0;
  const el = document.getElementById('at-pnl-preview');
  if (!entry || !exit || !shares) { el.textContent = '—'; el.style.color = 'var(--dim)'; return; }
  const pnl = parseFloat(((exit - entry) * shares).toFixed(2));
  el.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
  el.style.color = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--dim)';
}

function submitAddTrade() {
  const ticker = document.getElementById('at-ticker').value.trim().toUpperCase();
  const entry  = parseFloat(document.getElementById('at-entry').value);
  const exit   = parseFloat(document.getElementById('at-exit').value);
  const shares = parseInt(document.getElementById('at-shares').value);
  const date   = document.getElementById('at-date').value;
  const notes  = document.getElementById('at-notes')?.value.trim() || '';
  if (!ticker || !entry || !exit || !shares || !date) { alert('Fill in all required fields'); return; }
  const pnl = parseFloat(((exit - entry) * shares).toFixed(2));
  journalTrades.unshift({ id: 'M' + Date.now(), date, symbol: ticker, side: 'Long', qty: shares, entry, exit, pnl, notes });
  journalSave();
  renderJournal();
  closeAddTradeModal();
}
