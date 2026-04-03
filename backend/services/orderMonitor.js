'use strict';

/**
 * orderMonitor.js
 * Polls Alpaca every 5s for active position order status.
 * Drives the exit leg state machine and broadcasts order_update via WS.
 *
 * State machine:
 *   IDLE        → no active position
 *   ENTERING    → entry market order pending fill
 *   OPEN        → position filled, managing stops + partial exits
 *   LEG1_DONE   → 25% sold at 1R, stop moved to breakeven on 75%
 *   LEG2_DONE   → 25% sold at 2R, stop moved to 1R on 50% runner
 *   FLATTENING  → flatten in progress (10:30am or manual)
 *   CLOSED      → position fully closed, cycle complete
 */

const exec = require('./alpacaExecution');

// ─── SHARED POSITION STATE ───────────────────────────────────────────────────
// Single source of truth. Mutated by monitor, read by execution route.

const POSITION = {
  state:         'IDLE',   // state machine
  ticker:        null,
  totalShares:   0,
  plannedStop:   0,
  entryOrderId:  null,
  stopOrderId:   null,
  leg1OrderId:   null,
  leg2OrderId:   null,
  rLevels:       null,     // computed after fill: { fillPrice, r1Price, r2Price, ... }
  fillPrice:     null,
  remainingQty:  0,
  sessionLog:    [],       // in-memory only, cleared on IDLE reset
  openedAt:      null,
};

function getPosition() { return { ...POSITION }; }

function resetPosition() {
  const log = POSITION.sessionLog;
  Object.assign(POSITION, {
    state: 'IDLE', ticker: null, totalShares: 0, plannedStop: 0,
    entryOrderId: null, stopOrderId: null, leg1OrderId: null, leg2OrderId: null,
    rLevels: null, fillPrice: null, remainingQty: 0, openedAt: null,
    sessionLog: log, // keep log across resets within session
  });
}

function logEvent(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  const entry = `[${ts} ET] ${msg}`;
  POSITION.sessionLog.push(entry);
  console.log('[OrderMonitor]', entry);
}

// ─── 10:30 ET HARD EXIT CHECK ────────────────────────────────────────────────

function isPast1030ET() {
  const now  = new Date();
  const etH  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etM  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  return etH * 60 + etM >= 630; // 10:30am = 630 mins
}

// ─── MONITOR TICK ─────────────────────────────────────────────────────────────

let broadcastFn   = null;
let monitorTimer  = null;
let tickRunning   = false;

function broadcastUpdate(extra = {}) {
  if (!broadcastFn) return;
  broadcastFn('order_update', {
    state:        POSITION.state,
    ticker:       POSITION.ticker,
    rLevels:      POSITION.rLevels,
    fillPrice:    POSITION.fillPrice,
    remainingQty: POSITION.remainingQty,
    openedAt:     POSITION.openedAt,
    sessionLog:   POSITION.sessionLog,
    ...extra,
  });
}

async function tick() {
  if (tickRunning || POSITION.state === 'IDLE' || POSITION.state === 'CLOSED') return;
  tickRunning = true;

  try {
    // ── 10:30am hard exit ───────────────────────────────────────────────────
    if (isPast1030ET() && POSITION.state !== 'FLATTENING' && POSITION.state !== 'CLOSED') {
      logEvent(`10:30am ET hard exit — flattening ${POSITION.ticker}`);
      POSITION.state = 'FLATTENING';
      broadcastUpdate();
      const result = await exec.flattenPosition(POSITION.ticker);
      logEvent(`Flattened ${result.qty} shares — order ${result.orderId}`);
      POSITION.state = 'CLOSED';
      broadcastUpdate();
      return;
    }

    // ── ENTERING: wait for fill ─────────────────────────────────────────────
    if (POSITION.state === 'ENTERING') {
      const order = await exec.getOrder(POSITION.entryOrderId);
      if (order.status === 'filled') {
        const fillPrice = parseFloat(order.filled_avg_price);
        POSITION.fillPrice = fillPrice;
        POSITION.rLevels   = exec.computeRLevels({
          fillPrice,
          stopPrice:   POSITION.plannedStop,
          totalShares: POSITION.totalShares,
        });
        POSITION.remainingQty = POSITION.totalShares;
        POSITION.state        = 'OPEN';
        logEvent(`Entry filled @ $${fillPrice.toFixed(2)} — 1R $${POSITION.rLevels.r1Price.toFixed(2)}, 2R $${POSITION.rLevels.r2Price.toFixed(2)}`);

        // Place leg 1 limit sell at 1R
        const leg1 = await exec.placeLimitSell({
          ticker:     POSITION.ticker,
          shares:     POSITION.rLevels.leg1Shares,
          limitPrice: POSITION.rLevels.r1Price,
        });
        POSITION.leg1OrderId = leg1.id;
        logEvent(`Leg 1 placed: sell ${POSITION.rLevels.leg1Shares} @ $${POSITION.rLevels.r1Price.toFixed(2)}`);

        // Place leg 2 limit sell at 2R
        const leg2 = await exec.placeLimitSell({
          ticker:     POSITION.ticker,
          shares:     POSITION.rLevels.leg2Shares,
          limitPrice: POSITION.rLevels.r2Price,
        });
        POSITION.leg2OrderId = leg2.id;
        logEvent(`Leg 2 placed: sell ${POSITION.rLevels.leg2Shares} @ $${POSITION.rLevels.r2Price.toFixed(2)}`);

        broadcastUpdate();
      } else if (order.status === 'canceled' || order.status === 'rejected') {
        logEvent(`Entry order ${order.status} — resetting`);
        resetPosition();
        broadcastUpdate();
      }
      return;
    }

    // ── OPEN: check leg fills ───────────────────────────────────────────────
    if (POSITION.state === 'OPEN' || POSITION.state === 'LEG1_DONE') {

      // Check leg 1
      if (POSITION.state === 'OPEN' && POSITION.leg1OrderId) {
        const leg1 = await exec.getOrder(POSITION.leg1OrderId);
        if (leg1.status === 'filled') {
          logEvent(`Leg 1 filled @ $${parseFloat(leg1.filled_avg_price).toFixed(2)} — cancelling original stop, placing breakeven stop`);

          // Cancel original full stop
          if (POSITION.stopOrderId) {
            await exec.cancelOrder(POSITION.stopOrderId);
            POSITION.stopOrderId = null;
          }

          // Breakeven stop on remaining 75%
          const beShares = POSITION.rLevels.leg2Shares + POSITION.rLevels.runnerShares;
          const beStop = await exec.placeStopSell({
            ticker:    POSITION.ticker,
            shares:    beShares,
            stopPrice: POSITION.rLevels.breakevenStop,
          });
          POSITION.stopOrderId  = beStop.id;
          POSITION.remainingQty = beShares;
          POSITION.state        = 'LEG1_DONE';
          logEvent(`Breakeven stop placed on ${beShares} shares @ $${POSITION.rLevels.breakevenStop.toFixed(2)}`);
          broadcastUpdate();
        }
      }

      // Check leg 2
      if (POSITION.state === 'LEG1_DONE' && POSITION.leg2OrderId) {
        const leg2 = await exec.getOrder(POSITION.leg2OrderId);
        if (leg2.status === 'filled') {
          logEvent(`Leg 2 filled @ $${parseFloat(leg2.filled_avg_price).toFixed(2)} — moving stop to 1R`);

          // Cancel breakeven stop
          if (POSITION.stopOrderId) {
            await exec.cancelOrder(POSITION.stopOrderId);
            POSITION.stopOrderId = null;
          }

          // 1R stop on runner (50%)
          const r1Stop = await exec.placeStopSell({
            ticker:    POSITION.ticker,
            shares:    POSITION.rLevels.runnerShares,
            stopPrice: POSITION.rLevels.r1Stop,
          });
          POSITION.stopOrderId  = r1Stop.id;
          POSITION.remainingQty = POSITION.rLevels.runnerShares;
          POSITION.state        = 'LEG2_DONE';
          logEvent(`1R stop placed on ${POSITION.rLevels.runnerShares} runner shares @ $${POSITION.rLevels.r1Stop.toFixed(2)}`);
          broadcastUpdate();
        }
      }

      // Check if stopped out (stop order filled)
      if (POSITION.stopOrderId) {
        const stop = await exec.getOrder(POSITION.stopOrderId);
        if (stop.status === 'filled') {
          logEvent(`Stop filled @ $${parseFloat(stop.filled_avg_price).toFixed(2)} — position closed`);
          POSITION.state        = 'CLOSED';
          POSITION.remainingQty = 0;
          broadcastUpdate();
        }
      }
    }

    // ── LEG2_DONE: only runner remains, monitor stop ────────────────────────
    if (POSITION.state === 'LEG2_DONE' && POSITION.stopOrderId) {
      const stop = await exec.getOrder(POSITION.stopOrderId);
      if (stop.status === 'filled') {
        logEvent(`Runner stop filled @ $${parseFloat(stop.filled_avg_price).toFixed(2)} — position closed`);
        POSITION.state        = 'CLOSED';
        POSITION.remainingQty = 0;
        broadcastUpdate();
      }
    }

  } catch (err) {
    console.error('[OrderMonitor] tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Called from execution route to kick off a new trade.
 * Sets POSITION state from IDLE → ENTERING.
 */
function openTrade({ ticker, totalShares, plannedStop, entryOrderId, stopOrderId }) {
  if (POSITION.state !== 'IDLE') throw new Error('Position already open');
  Object.assign(POSITION, {
    state:        'ENTERING',
    ticker,
    totalShares,
    plannedStop,
    entryOrderId,
    stopOrderId,
    openedAt:     Date.now(),
    sessionLog:   POSITION.sessionLog, // preserve log
  });
  logEvent(`Trade opened — ${ticker} ${totalShares} shares, stop $${plannedStop}`);
  broadcastUpdate();
}

/**
 * Called from execution route for manual flatten (Flatten button).
 */
async function requestFlatten() {
  if (POSITION.state === 'IDLE' || POSITION.state === 'CLOSED') return { alreadyClosed: true };
  POSITION.state = 'FLATTENING';
  broadcastUpdate();
  const result = await exec.flattenPosition(POSITION.ticker);
  logEvent(`Manual flatten — ${result.qty} shares`);
  POSITION.state        = 'CLOSED';
  POSITION.remainingQty = 0;
  broadcastUpdate();
  return result;
}

/**
 * Start the 5s polling loop. Called once from server.js at startup.
 */
function startMonitor(broadcast, _wsClients) {
  broadcastFn = broadcast;
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(tick, 5000);
  console.log('[OrderMonitor] Started — polling every 5s');
}

function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
}

module.exports = { startMonitor, stopMonitor, openTrade, requestFlatten, getPosition, resetPosition, POSITION };
