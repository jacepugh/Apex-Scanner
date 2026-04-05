/* ── pulse.js — market context tiles ── */



// UVXY replaces VIX (Polygon Starter doesn't carry $VIX index)
const PULSE_TICKERS = [
  { ticker: 'SPY',  name: 'S&P 500 ETF' },
  { ticker: 'QQQ',  name: 'NASDAQ ETF' },
  { ticker: 'IWM',  name: 'Small Cap ETF' },
  { ticker: 'UVXY', name: 'Volatility Proxy' },
  { ticker: 'XBI',  name: 'Biotech ETF' },
  { ticker: 'BTC',  name: 'Bitcoin — Risk Sentiment' },
];

let _pulseFetching = false;

async function fetchPulse() {
  if (_pulseFetching) return;
  _pulseFetching = true;
  try {
    const tickers = PULSE_TICKERS.filter(t => t.ticker !== 'BTC').map(t => t.ticker).join(',');
    const res  = await apiFetch(`/api/pulse?tickers=${tickers}`);
    const data = await res.json();
    PULSE_TICKERS.forEach(pt => {
      if (pt.ticker === 'BTC') return; // handled separately
      const d = data[pt.ticker];
      if (!d) return;
      updatePulseTile(pt.ticker, d.price, d.changePercent);
    });
    // BTC via separate endpoint
    try {
      const btcRes  = await apiFetch('/api/pulse/btc');
      const btcData = await btcRes.json();
      if (btcData?.price) updatePulseTile('BTC', btcData.price, btcData.changePercent);
    } catch (_) {}
  } catch (e) {
    if (e.message !== 'Unauthenticated') console.warn('[Pulse]', e.message);
  } finally {
    _pulseFetching = false;
    const el = document.getElementById('pulse-updated');
    if (el) {
      const t = new Date().toLocaleString('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
      el.textContent = 'Updated ' + t + ' ET — tap to refresh';
    }
  }
}

function updatePulseTile(ticker, price, changePct) {
  const tile   = document.getElementById('pt-' + ticker);
  if (!tile) return;
  const priceEl = tile.querySelector('.pt-price');
  const chgEl   = tile.querySelector('.pt-chg');
  if (!priceEl || !chgEl) return;

  const isBtc = ticker === 'BTC';
  priceEl.textContent = isBtc ? '$' + Math.round(price).toLocaleString() : '$' + price.toFixed(2);
  priceEl.classList.remove('pt-loading');

  if (changePct != null) {
    const pos = changePct >= 0;
    chgEl.textContent = (pos ? '▲ +' : '▼ ') + changePct.toFixed(2) + '%';
    chgEl.className = 'pt-chg ' + (pos ? 'pos' : 'neg');
    tile.classList.toggle('up',   pos && Math.abs(changePct) > 0.05);
    tile.classList.toggle('down', !pos && Math.abs(changePct) > 0.05);
  }

  // VIX-like warning: if UVXY spikes hard, warn
  if (ticker === 'UVXY' && changePct > 10) {
    document.getElementById('vix-warn')?.classList.add('show');
  }
}
