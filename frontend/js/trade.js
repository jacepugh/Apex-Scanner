/* ── trade.js — combined sizer + exec tab ── */



let sizerAccount = parseFloat(localStorage.getItem('sb_account') || '700');
let sizerRiskPct = parseFloat(localStorage.getItem('sb_risk')    || '0.015');

function getDailyLossLimit() { return Math.max(25, sizerAccount * 0.01); }

function initSizer() {
  document.getElementById('sz-account').value = sizerAccount;
  document.getElementById('sz-account-display').textContent = '$' + sizerAccount.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const savedLabel = (sizerRiskPct * 100).toString().replace(/\.0$/, '') + '%';
  document.querySelectorAll('.risk-btn').forEach(b => b.classList.toggle('active', b.textContent === savedLabel));
}

function sizerUpdateAccount() {
  const val = parseFloat(document.getElementById('sz-account').value);
  if (!isNaN(val) && val > 0) {
    sizerAccount = val;
    localStorage.setItem('sb_account', val);
    document.getElementById('sz-account-display').textContent = '$' + val.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  sizerCalc();
}

function scaleAccount(delta) {
  sizerAccount = Math.max(100, sizerAccount + delta);
  localStorage.setItem('sb_account', sizerAccount);
  document.getElementById('sz-account').value = sizerAccount;
  document.getElementById('sz-account-display').textContent = '$' + sizerAccount.toLocaleString('en-US', { maximumFractionDigits: 0 });
  sizerCalc();
}

function sizerSetRisk(pct, btn) {
  sizerRiskPct = pct / 100;
  localStorage.setItem('sb_risk', sizerRiskPct);
  document.querySelectorAll('.risk-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sizerCalc();
}

function sizerCalc() {
  const entry  = parseFloat(document.getElementById('sz-entry').value);
  const stop   = parseFloat(document.getElementById('sz-stop').value);
  const warnEl = document.getElementById('sz-warning');
  const resEl  = document.getElementById('sz-results');
  warnEl.style.display = 'none';
  warnEl.textContent   = '';
  if (!entry || !stop || isNaN(entry) || isNaN(stop)) { resEl.style.display = 'none'; return; }
  if (stop >= entry) { warnEl.innerHTML = '⚠️ Stop must be below entry.'; warnEl.style.display = 'block'; resEl.style.display = 'none'; return; }

  const riskAmt = sizerAccount * sizerRiskPct;
  const rDist   = entry - stop;
  const shares  = Math.floor(riskAmt / rDist);
  if (shares < 1) { warnEl.innerHTML = `⚠️ Stop too wide for ${(sizerRiskPct*100).toFixed(1)}% risk (${fmtD(riskAmt)}).`; warnEl.style.display = 'block'; resEl.style.display = 'none'; return; }

  const posSize   = shares * entry;
  const actualRisk = shares * rDist;
  const target    = entry + rDist * 2;
  const reward    = actualRisk * 2;
  const rPct      = (actualRisk / sizerAccount) * 100;
  const warns     = [];
  if (posSize > sizerAccount * 0.5) warns.push(`⚠️ Position (${fmtD(posSize)}) > 50% of account.`);
  if (rPct > 3) warns.push(`⚠️ Risk is ${rPct.toFixed(1)}% — above 3%.`);
  if (warns.length) { warnEl.innerHTML = warns.join('<br><br>'); warnEl.style.display = 'block'; }

  document.getElementById('sz-rvalue').textContent  = fmtD(actualRisk);
  document.getElementById('sz-rvalue').className    = 'result-r-value ' + (actualRisk < 50 ? 'r-green' : actualRisk <= 100 ? 'r-yellow' : 'r-red');
  document.getElementById('sz-shares').textContent  = shares;
  document.getElementById('sz-possize').textContent = fmtD(posSize);
  document.getElementById('sz-maxrisk').textContent = fmtD(actualRisk);
  document.getElementById('sz-target').textContent  = fmtD(target);
  document.getElementById('sz-rdist').textContent   = fmtD(rDist);
  document.getElementById('tp-entry').textContent   = fmtD(entry);
  document.getElementById('tp-stop').textContent    = fmtD(stop);
  document.getElementById('tp-target').textContent  = fmtD(target);
  document.getElementById('tp-shares').textContent  = shares + ' shares';
  document.getElementById('tp-riskamt').textContent = '−' + fmtD(actualRisk);
  document.getElementById('tp-reward').textContent  = '+' + fmtD(reward);
  document.getElementById('tp-riskpct').textContent = rPct.toFixed(2) + '%';
  resEl.style.display = 'flex';
}

function openSizerWithPrice(price) {
  document.getElementById('sz-entry').value = price.toFixed(2);
  document.getElementById('sz-prefill-badge').style.display = 'inline-block';
  document.getElementById('sz-stop').value = '';
  showPage('trade');
  setTimeout(() => document.getElementById('sz-stop').focus(), 300);
}

// ── EXEC SECTION ─────────────────────────────────────────
function renderTradeTab() {
  renderExecSection();
}

function renderExecSection() {
  const container = document.getElementById('exec-content');
  if (!container) return;
  const pos = EXEC_STATE.position;
  if (!pos || pos.state === 'IDLE') {
    container.innerHTML = '<div class="exec-idle-msg">⚡ No active position.<br/><br/>Size a trade above,<br/>tap a <strong style="color:var(--green)">BUY</strong> card in the scanner,<br/>then confirm here.</div>';
    return;
  }

  const r = pos.rLevels;
  const isOpen = pos.state !== 'CLOSED';
  const px = EXEC_STATE.currentPx[pos.ticker];
  let pnlHtml = '<div class="exec-pnl-live zero">—</div>';
  if (px && pos.fillPrice && pos.remainingQty) {
    const raw = (px - pos.fillPrice) * pos.remainingQty;
    pnlHtml = `<div class="exec-pnl-live ${raw > 0 ? 'pos' : raw < 0 ? 'neg' : 'zero'}">${raw >= 0 ? '+' : ''}$${Math.abs(raw).toFixed(2)}</div>`;
  }

  const leg1Done = ['LEG1_DONE','LEG2_DONE','CLOSED'].includes(pos.state);
  const leg2Done = ['LEG2_DONE','CLOSED'].includes(pos.state);

  const rGrid = r ? `
    <div class="exec-r-grid">
      <div class="exec-r-item"><div class="exec-r-label">Fill</div><div class="exec-r-val accent">$${r.fillPrice.toFixed(2)}</div></div>
      <div class="exec-r-item"><div class="exec-r-label">1R Target</div><div class="exec-r-val green">$${r.r1Price.toFixed(2)}</div></div>
      <div class="exec-r-item"><div class="exec-r-label">2R Target</div><div class="exec-r-val green">$${r.r2Price.toFixed(2)}</div></div>
      <div class="exec-r-item"><div class="exec-r-label">Stop</div><div class="exec-r-val red">$${r.stopPrice.toFixed(2)}</div></div>
      <div class="exec-r-item"><div class="exec-r-label">Remaining</div><div class="exec-r-val gold">${pos.remainingQty} shs</div></div>
      <div class="exec-r-item"><div class="exec-r-label">State</div><div class="exec-r-val purple">${pos.state.replace('_',' ')}</div></div>
    </div>` : '';

  const logItems = [...(pos.sessionLog || [])].reverse().slice(0, 20);
  const logHtml = logItems.length ? `
    <div class="exec-log-title">Session Log</div>
    ${logItems.map(l => `<div class="exec-log-item">${l}</div>`).join('')}` : '';

  container.innerHTML = `
    <div class="exec-status-card ${isOpen ? 'state-open' : 'state-closed'}">
      <div class="exec-state-row">
        <div>
          <div class="exec-ticker-row">${pos.ticker || '—'}</div>
          ${pnlHtml}
        </div>
        <div class="exec-state-badge ${pos.state}">${pos.state.replace('_',' ')}</div>
      </div>
      <div class="exec-legs">
        <div class="exec-leg ${leg1Done ? 'done' : pos.state === 'OPEN' ? 'active' : ''}">
          <div class="exec-leg-pct">25%</div><div>1R EXIT</div>${leg1Done ? '✓' : ''}
        </div>
        <div class="exec-leg ${leg2Done ? 'done' : pos.state === 'LEG1_DONE' ? 'active' : ''}">
          <div class="exec-leg-pct">25%</div><div>2R EXIT</div>${leg2Done ? '✓' : ''}
        </div>
        <div class="exec-leg ${pos.state === 'CLOSED' ? 'done' : pos.state === 'LEG2_DONE' ? 'active' : ''}">
          <div class="exec-leg-pct">50%</div><div>RUNNER</div>
        </div>
      </div>
      ${rGrid}
      ${buildCountdownHtml()}
      ${isOpen
        ? `<button class="exec-flatten-btn" id="exec-flatten-btn" onclick="flattenNow()">⬛ FLATTEN POSITION</button>`
        : `<div style="text-align:center;font-family:var(--mono);font-size:11px;color:var(--mid);padding:10px">Position closed</div>`}
    </div>
    ${logHtml}`;
}

function buildCountdownHtml() {
  const now  = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const [h,m,s] = etStr.split(':').map(Number);
  const nowMins = h * 60 + m + s / 60;
  const diff = 630 - nowMins;
  if (diff <= 0) return '<div class="exec-countdown warn">🔴 10:30am ET HARD EXIT TRIGGERED</div>';
  const mm = Math.floor(diff), ss = Math.floor((diff - mm) * 60);
  return `<div class="exec-countdown ${diff <= 5 ? 'warn' : ''}">⏱ 10:30am hard exit in ${mm}m ${ss.toString().padStart(2,'0')}s</div>`;
}

function updateLivePnl() {
  const pos = EXEC_STATE.position;
  if (!pos || pos.state === 'IDLE' || pos.state === 'CLOSED') return;
  const pnlEl = document.querySelector('.exec-pnl-live');
  if (!pnlEl) return;
  const px = EXEC_STATE.currentPx[pos.ticker];
  if (!px || !pos.fillPrice || !pos.remainingQty) return;
  const raw = (px - pos.fillPrice) * pos.remainingQty;
  pnlEl.textContent = (raw >= 0 ? '+' : '') + '$' + Math.abs(raw).toFixed(2);
  pnlEl.className   = 'exec-pnl-live ' + (raw > 0 ? 'pos' : raw < 0 ? 'neg' : 'zero');
}

async function flattenNow() {
  const btn = document.getElementById('exec-flatten-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Flattening...'; }
  try {
    const res  = await apiFetch('/api/execution/flatten', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert('Flatten failed: ' + (data.detail || data.error));
  } catch (e) {
    if (e.message !== 'Unauthenticated') alert('Flatten error: ' + e.message);
  }
}

// ── CONFIRM SHEET ────────────────────────────────────────
let _confirmTicker = '', _confirmShares = 0, _confirmStop = 0;

async function openConfirmSheet(ticker) {
  const s = STOCK_MAP[ticker];
  if (!s) return;
  const ez = calcEntryZone(s);
  if (!ez) { alert('Cannot calculate entry zone for ' + ticker + ' — check PM High/Low data.'); return; }
  const shares = parseInt(document.getElementById('sz-shares')?.textContent || '0');
  if (!shares || shares < 1) { alert('Size the trade first — open the Trade tab, enter entry/stop, then tap Calculate.'); return; }

  const entry = ez.entryHigh, stop = ez.stop, rDist = entry - stop;
  const r1    = parseFloat((entry + rDist).toFixed(2));
  const r2    = parseFloat((entry + rDist * 2).toFixed(2));
  const risk  = parseFloat((shares * rDist).toFixed(2));

  _confirmTicker = ticker; _confirmShares = shares; _confirmStop = stop;
  document.getElementById('cs-ticker').textContent  = ticker;
  document.getElementById('cs-shares').textContent  = shares + ' shares';
  document.getElementById('cs-entry').textContent   = '~$' + entry.toFixed(2);
  document.getElementById('cs-stop').textContent    = '$' + stop.toFixed(2);
  document.getElementById('cs-1r').textContent      = '$' + r1.toFixed(2);
  document.getElementById('cs-2r').textContent      = '$' + r2.toFixed(2);
  document.getElementById('cs-risk').textContent    = '$' + risk.toFixed(2);

  const buyBtn   = document.getElementById('cs-buy-btn');
  const modeBadge = document.getElementById('cs-mode-badge');
  const bpWarn   = document.getElementById('cs-bp-warning');
  buyBtn.disabled = false; buyBtn.textContent = 'BUY'; buyBtn.classList.remove('live-mode');
  modeBadge.textContent = 'PAPER'; modeBadge.className = 'cs-mode-badge';
  bpWarn.style.display = 'none';
  document.getElementById('confirm-overlay').classList.add('open');

  try {
    const res  = await apiFetch('/api/execution/buying-power');
    const data = await res.json();
    const live = data.mode === 'live';
    modeBadge.textContent = live ? '⚠ LIVE' : 'PAPER';
    modeBadge.className   = 'cs-mode-badge' + (live ? ' live' : '');
    if (live) { buyBtn.classList.add('live-mode'); buyBtn.textContent = '🔴 EXECUTE LIVE'; }
    const roughCost = shares * entry;
    if (roughCost > data.buyingPower) {
      bpWarn.textContent = `⚠ Buying power $${data.buyingPower.toFixed(2)} may be low for ~$${roughCost.toFixed(2)} position.`;
      bpWarn.style.display = 'block';
    }
  } catch (e) {
    if (e.message !== 'Unauthenticated') { bpWarn.textContent = '⚠ Could not verify buying power.'; bpWarn.style.display = 'block'; }
  }
}

function closeConfirmSheet() { document.getElementById('confirm-overlay').classList.remove('open'); }

async function submitBuy() {
  const btn = document.getElementById('cs-buy-btn');
  btn.disabled = true; btn.textContent = 'Placing order...';
  try {
    const res  = await apiFetch('/api/execution/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: _confirmTicker, shares: _confirmShares, stopPrice: _confirmStop }),
    });
    const data = await res.json();
    if (!res.ok) { alert('Order failed: ' + (data.detail || data.error)); btn.disabled = false; btn.textContent = 'BUY'; return; }
    closeConfirmSheet();
    showPage('trade');
  } catch (e) {
    if (e.message !== 'Unauthenticated') alert('Network error: ' + e.message);
    btn.disabled = false; btn.textContent = 'BUY';
  }
}
