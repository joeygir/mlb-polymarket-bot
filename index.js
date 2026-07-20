require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendEmailReport, testEmailReport } = require('./email');

// Railway's container filesystem is rebuilt from the repo image on every
// deploy, wiping anything written at runtime (logged picks, scheduler state,
// bot status). Setting DATA_DIR to a mounted persistent volume (e.g. /data
// on Railway: service → Attach Volume, mount path /data, then env var
// DATA_DIR=/data) makes all runtime state survive restarts and deploys.
// Unset, everything behaves exactly as before (files beside the code).
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PICKS_LOG = path.join(DATA_DIR, 'picks_log.csv');
// Model_Total/Model_Prob/Entry_Cost: the probability model's projection and
// what we "paid" (ask + context) at pick time. Kalshi_Ticker enables the CLV
// pass in updateResults: Close_Cost is the market's last traded price for our
// side at close, and CLV = Close_Cost - Entry_Cost in probability points —
// positive means the market moved toward our position, the fastest-converging
// evidence of whether picks beat the market.
const CSV_HEADERS = ['Date','Game','Lean','Confidence','Edge_Label','Total_Line','Side','Side_Juice','Stake','Result','Hit_Miss','PnL','Signal_Fact','Market_Fact','Risk_Fact','Signals','Model_Total','Model_Prob','Entry_Cost','Kalshi_Ticker','Close_Cost','CLV'];

// Compact machine-readable encoding of the weighted signals that fired for a
// pick, e.g. "pitcher_solid:UNDER:1|park_pitcher:UNDER:1" — this is what
// makes the 200-pick recalibration possible: hit rate can be regressed per
// signal ID, which the human-readable Signal_Fact prose can't support.
function encodeSignals(weighted) {
  return (weighted || [])
    .filter(w => w.id)
    .map(w => `${w.id}:${w.direction}:${w.tier}`)
    .join('|');
}

// One-time seed: on first run with a fresh volume, copy the repo's committed
// picks_log.csv into DATA_DIR so history carries over.
if (DATA_DIR !== __dirname && !fs.existsSync(PICKS_LOG) && fs.existsSync(path.join(__dirname, 'picks_log.csv'))) {
  fs.copyFileSync(path.join(__dirname, 'picks_log.csv'), PICKS_LOG);
  console.log(`Seeded ${PICKS_LOG} from repo copy`);
}

// Self-check snapshot written at the end of every getTodayGames() run so
// the email can report whether the bot actually ran today and whether its
// data sources (Odds API, Kalshi) looked healthy — not committed to git,
// it's transient run-to-run state read fresh by email.js each send.
const BOT_STATUS_PATH = path.join(DATA_DIR, 'bot_status.json');

function writeBotStatus(status) {
  try {
    fs.writeFileSync(BOT_STATUS_PATH, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`Failed to write bot_status.json: ${err.message}`);
  }
}

// Persists which scheduled task-keys have already fired today, so a process
// restart (crash loop, redeploy) can't forget and re-trigger a task that
// already ran — see the catch-up scheduler in runDaemon() for why this
// needs to survive across restarts, not just live in memory.
const SCHEDULER_STATE_PATH = path.join(DATA_DIR, 'scheduler_state.json');

function loadSchedulerState(dateStr) {
  try {
    if (!fs.existsSync(SCHEDULER_STATE_PATH)) return new Set();
    const data = JSON.parse(fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8'));
    return data.date === dateStr ? new Set(data.firedKeys || []) : new Set();
  } catch {
    return new Set();
  }
}

function saveSchedulerState(dateStr, triggeredKeys) {
  try {
    fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify({ date: dateStr, firedKeys: [...triggeredKeys] }));
  } catch (err) {
    console.error(`Failed to write scheduler_state.json: ${err.message}`);
  }
}

const PAPER_TRADING_NOTICE = 'PAPER TRADING MODE — Accuracy tracking is the #1 priority. Every TARGET and PRIME TARGET pick is being logged to picks_log.csv for statistical regression analysis at 200 resolved picks. Do not optimize for pick volume. Only log picks where edge detection is confident. The goal is clean, validated data — not picks.';
const REGRESSION_MILESTONE_TARGET = 200;

function regressionMilestoneLine(resolvedCount) {
  return `Regression milestone: ${resolvedCount}/${REGRESSION_MILESTONE_TARGET} resolved picks logged. At ${REGRESSION_MILESTONE_TARGET} picks, signal weights will be recalibrated based on empirical hit rates.`;
}

function parseCSV(content) {
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length < 1) return { headers: CSV_HEADERS, rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (fields[i] || '').trim(); });
    return obj;
  }).filter(r => r.Date);
  return { headers, rows };
}

function rowToCSV(row, headers) {
  return headers.map(h => {
    const v = row[h] != null ? String(row[h]) : '';
    return v.includes(',') || v.includes('"') ? `"${v}"` : v;
  }).join(',');
}

const OVER_LEANS = ['STRONG OVER','OVER','LEAN OVER','DOME — LEAN OVER'];

function logPick(date, game, lean, confidence, edgeLabel, odds, reasoning = {}, model = {}) {
  // Side comes from the probability edge when present (it picks its own side
  // and strike); the lean-derived side remains as fallback for any legacy path.
  const side = model.side || (OVER_LEANS.includes(lean) ? 'OVER' : 'UNDER');
  const sideJuice = side === 'OVER' ? odds.overJuice : odds.underJuice;
  const newRow = {
    Date: date, Game: game, Lean: lean, Confidence: confidence, Edge_Label: edgeLabel,
    Total_Line: odds.total, Side: side, Side_Juice: sideJuice, Stake: '', Result: '', Hit_Miss: '', PnL: '',
    Signal_Fact: reasoning.signalFact || '', Market_Fact: reasoning.marketFact || '', Risk_Fact: reasoning.riskFact || '',
    Signals: reasoning.signals || '',
    Model_Total: model.modelTotal != null ? model.modelTotal.toFixed(2) : '',
    Model_Prob: model.modelProb != null ? model.modelProb.toFixed(3) : '',
    Entry_Cost: model.entryCost != null ? model.entryCost.toFixed(2) : '',
    Kalshi_Ticker: model.ticker || '',
    Close_Cost: '', CLV: '',
  };

  if (!fs.existsSync(PICKS_LOG)) {
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rowToCSV(newRow, CSV_HEADERS) + '\n');
    return;
  }

  const { headers, rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));

  if (rows.some(r => r.Date === date && r.Game === game)) return;

  // Backfill any column that didn't exist yet when older rows were written
  // (Side/Confidence historically, Signal_Fact/Market_Fact/Risk_Fact now).
  const missingCols = CSV_HEADERS.filter(h => !headers.includes(h));

  if (missingCols.length > 0) {
    const migrated = rows.map(r => ({
      ...r,
      Side: headers.includes('Side') ? r.Side : (OVER_LEANS.includes(r.Lean) ? 'OVER' : 'UNDER'),
      Confidence: headers.includes('Confidence') ? r.Confidence : '',
      Signal_Fact: headers.includes('Signal_Fact') ? r.Signal_Fact : '',
      Market_Fact: headers.includes('Market_Fact') ? r.Market_Fact : '',
      Risk_Fact: headers.includes('Risk_Fact') ? r.Risk_Fact : '',
      Signals: headers.includes('Signals') ? r.Signals : '',
      Model_Total: headers.includes('Model_Total') ? r.Model_Total : '',
      Model_Prob: headers.includes('Model_Prob') ? r.Model_Prob : '',
      Entry_Cost: headers.includes('Entry_Cost') ? r.Entry_Cost : '',
      Kalshi_Ticker: headers.includes('Kalshi_Ticker') ? r.Kalshi_Ticker : '',
      Close_Cost: headers.includes('Close_Cost') ? r.Close_Cost : '',
      CLV: headers.includes('CLV') ? r.CLV : '',
    }));
    migrated.push(newRow);
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + migrated.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
  } else {
    fs.appendFileSync(PICKS_LOG, rowToCSV(newRow, CSV_HEADERS) + '\n');
  }
}

function calcPnL(hitMiss, sideJuice, stake) {
  if (hitMiss === 'PUSH') return 0;
  let juice = parseInt(sideJuice);
  // Valid American odds are <= -100 or >= +100. Anything in between (or NaN)
  // is corrupt data — early rows carry impossible values like "-19" from the
  // odds-averaging bug — so fall back to the standard -110 vig rather than
  // paying out a wildly inflated (or NaN) return.
  if (isNaN(juice) || Math.abs(juice) < 100) juice = -110;
  const unit = parseFloat(stake) > 0 ? parseFloat(stake) : 10;
  if (hitMiss === 'HIT') return juice < 0 ? +(unit * 100 / Math.abs(juice)).toFixed(2) : +(unit * juice / 100).toFixed(2);
  return -unit;
}

function setStake(game, amount, date) {
  if (!fs.existsSync(PICKS_LOG)) { console.log('picks_log.csv not found.'); return; }

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const matches = rows.filter(r => r.Game.toLowerCase().includes(game.toLowerCase()) && (!date || r.Date === date));

  if (matches.length === 0) { console.log(`No pick found matching "${game}"${date ? ` on ${date}` : ''}.`); return; }
  if (matches.length > 1) {
    console.log(`Multiple picks match "${game}" — specify a date:`);
    matches.forEach(r => console.log(`  ${r.Date} — ${r.Game}`));
    return;
  }

  matches[0].Stake = amount.toString();
  fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rows.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
  console.log(`Set stake of $${amount} on ${matches[0].Date} — ${matches[0].Game}`);
}

async function fetchFinalScores(date) {
  try {
    const res = await axios.get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team`);
    const games = res.data.dates[0]?.games || [];

    // Doubleheaders share a matchup name, so keys must carry the game number
    // — otherwise the second final overwrites the first and a pick can get
    // graded against the wrong game's total. The plain (unsuffixed) key is
    // still written when the matchup appears only once that day, so rows
    // logged before doubleheader labeling existed keep grading correctly.
    const matchupCounts = {};
    for (const g of games) {
      const key = `${g.teams.away.team.name} @ ${g.teams.home.team.name}`;
      matchupCounts[key] = (matchupCounts[key] || 0) + 1;
    }

    const scoreMap = {};
    for (const g of games) {
      if (g.status.abstractGameState !== 'Final') continue;
      const base = `${g.teams.away.team.name} @ ${g.teams.home.team.name}`;
      const awayRuns = g.teams.away.score;
      const homeRuns = g.teams.home.score;
      if (awayRuns == null || homeRuns == null) continue;
      const total = awayRuns + homeRuns;
      if (matchupCounts[base] > 1 || g.doubleHeader !== 'N') {
        scoreMap[`${base} (Game ${g.gameNumber || 1})`] = total;
        if (matchupCounts[base] === 1) scoreMap[base] = total;
      } else {
        scoreMap[base] = total;
      }
    }
    return scoreMap;
  } catch {
    return {};
  }
}

// Closing-line-value pass: for any pick with a Kalshi ticker and no recorded
// close, fetch the settled market's last traded price and log where the
// market closed relative to our entry. Positive CLV = the market moved toward
// our side after we picked — the fastest-converging evidence of whether picks
// beat the market (it stabilizes in ~50-100 picks, versus 500+ for raw W/L).
async function captureCLV(rows) {
  let captured = 0;
  const needsClv = rows.filter(r => r.Kalshi_Ticker && r.Entry_Cost && !r.Close_Cost && r.Result);
  for (const row of needsClv) {
    try {
      const data = await kalshiGet(`${KALSHI_PATH_PREFIX}/markets/${row.Kalshi_Ticker}`);
      const lastYes = parseFloat(data?.market?.last_price_dollars);
      if (isNaN(lastYes)) continue;
      const closeForOurSide = row.Side === 'OVER' ? lastYes : 1 - lastYes;
      const clv = closeForOurSide - parseFloat(row.Entry_Cost);
      row.Close_Cost = closeForOurSide.toFixed(2);
      row.CLV = (clv * 100).toFixed(1);
      captured++;
      console.log(`  CLV: ${row.Game} (${row.Date}) — entered ${row.Side} at ${row.Entry_Cost}, closed ${row.Close_Cost} → ${clv >= 0 ? '+' : ''}${(clv * 100).toFixed(1)} pts`);
    } catch (err) {
      console.log(`  CLV fetch failed for ${row.Kalshi_Ticker}: ${err.message}`);
    }
  }
  return captured;
}

async function updateResults() {
  if (!fs.existsSync(PICKS_LOG)) { console.log('picks_log.csv not found.'); return; }

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const pending = rows.filter(r => !r.Result);

  const byDate = {};
  for (const r of pending) { (byDate[r.Date] = byDate[r.Date] || []).push(r); }

  let updated = 0;
  for (const [date, dateRows] of Object.entries(byDate)) {
    const scores = await fetchFinalScores(date);
    for (const row of dateRows) {
      const total = scores[row.Game];
      if (total == null) { console.log(`  No final score: ${row.Game} on ${date}`); continue; }
      const line = parseFloat(row.Total_Line);
      const result = total > line ? 'OVER' : total < line ? 'UNDER' : 'PUSH';
      const hitMiss = result === 'PUSH' ? 'PUSH' : result === row.Side ? 'HIT' : 'MISS';
      const pnl = calcPnL(hitMiss, row.Side_Juice, row.Stake);
      const target = rows.find(r => r.Date === date && r.Game === row.Game);
      target.Result = result;
      target.Hit_Miss = hitMiss;
      target.PnL = pnl.toString();
      updated++;
      console.log(`  ${row.Game} (${date}) — ${total} runs vs line ${line} → ${result} → ${hitMiss} (${pnl >= 0 ? '+' : ''}${pnl})`);
    }
  }

  const clvCaptured = await captureCLV(rows);

  if (updated > 0 || clvCaptured > 0) {
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rows.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
    console.log(`\nUpdated ${updated} result(s), captured ${clvCaptured} CLV close(s) in picks_log.csv`);
  } else if (pending.length === 0) {
    console.log('No pending results to update.');
  }
}

function printSummary() {
  if (!fs.existsSync(PICKS_LOG)) { console.log('picks_log.csv not found.'); return; }

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const resolved = rows.filter(r => r.Hit_Miss && r.Hit_Miss !== 'PUSH');
  const total = resolved.length;
  const hits = resolved.filter(r => r.Hit_Miss === 'HIT').length;
  const totalPnL = resolved.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);

  console.log('\n============================');
  console.log(' PERFORMANCE SUMMARY');
  console.log('============================\n');
  console.log(regressionMilestoneLine(total));
  console.log('');
  console.log(`Total picks logged : ${rows.length}`);
  console.log(`Resolved picks     : ${total}`);
  console.log(`Overall hit rate   : ${hits}/${total} (${total > 0 ? (hits/total*100).toFixed(1) : '0.0'}%)`);
  console.log(`Total P&L          : ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`);

  // Average closing line value across picks that have a recorded close —
  // sustained positive CLV is the strongest early evidence the model beats
  // the market, well before the W/L record is statistically meaningful.
  const clvRows = rows.filter(r => r.CLV !== '' && r.CLV != null && !isNaN(parseFloat(r.CLV)));
  if (clvRows.length > 0) {
    const avgClv = clvRows.reduce((s, r) => s + parseFloat(r.CLV), 0) / clvRows.length;
    const positive = clvRows.filter(r => parseFloat(r.CLV) > 0).length;
    console.log(`Closing line value : avg ${avgClv >= 0 ? '+' : ''}${avgClv.toFixed(1)} pts across ${clvRows.length} picks (${positive}/${clvRows.length} beat the close)`);
  }

  console.log('\nBy Edge Label:');
  for (const label of ['PRIME TARGET', 'TARGET']) {
    const g = resolved.filter(r => r.Edge_Label === label);
    const gHits = g.filter(r => r.Hit_Miss === 'HIT').length;
    const gPnL = g.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
    console.log(`  ${label.padEnd(13)}: ${gHits}/${g.length} (${g.length > 0 ? (gHits/g.length*100).toFixed(1) : '0.0'}%) | P&L: ${gPnL >= 0 ? '+' : ''}${gPnL.toFixed(2)}`);
  }

  console.log('\nBy Lean:');
  const leanOrder = ['STRONG OVER','OVER','LEAN OVER','STRONG UNDER','UNDER','LEAN UNDER'];
  for (const lean of leanOrder) {
    const g = resolved.filter(r => r.Lean === lean);
    if (g.length === 0) continue;
    const gHits = g.filter(r => r.Hit_Miss === 'HIT').length;
    const gPnL = g.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
    console.log(`  ${lean.padEnd(14)}: ${gHits}/${g.length} (${(gHits/g.length*100).toFixed(1)}%) | P&L: ${gPnL >= 0 ? '+' : ''}${gPnL.toFixed(2)}`);
  }

  console.log('\nBy Confidence:');
  for (const conf of ['HIGH', 'MEDIUM', 'LOW']) {
    const g = resolved.filter(r => r.Confidence === conf);
    if (g.length === 0) continue;
    const gHits = g.filter(r => r.Hit_Miss === 'HIT').length;
    const gPnL = g.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
    console.log(`  ${conf.padEnd(7)}: ${gHits}/${g.length} (${(gHits/g.length*100).toFixed(1)}%) | P&L: ${gPnL >= 0 ? '+' : ''}${gPnL.toFixed(2)}`);
  }

  const sorted = [...resolved].sort((a, b) => a.Date.localeCompare(b.Date));
  let streakType = null, streakCount = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const hm = sorted[i].Hit_Miss;
    if (!streakType) { streakType = hm; streakCount = 1; }
    else if (hm === streakType) { streakCount++; }
    else break;
  }
  console.log(`\nCurrent streak     : ${streakCount > 0 ? `${streakCount} ${streakType}${streakCount > 1 ? (streakType === 'MISS' ? 'ES' : 'S') : ''}` : 'None'}`);
  console.log('\n============================\n');
}

const STADIUMS = {
  'Wrigley Field':                    { lat: 41.9484, lon: -87.6553, outDirs: ['S','SW','SSW','SE','SSE'] },
  'Fenway Park':                      { lat: 42.3467, lon: -71.0972, outDirs: ['S','SE','SSE','SW','SSW'] },
  'Yankee Stadium':                   { lat: 40.8296, lon: -73.9262, outDirs: ['W','SW','WSW','NW','WNW'] },
  'UNIQLO Field at Dodger Stadium':   { lat: 34.0739, lon: -118.2400, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Dodger Stadium':                   { lat: 34.0739, lon: -118.2400, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Oracle Park':                      { lat: 37.7786, lon: -122.3893, outDirs: ['N','NW','NNW','NE','NNE'] },
  'Coors Field':                      { lat: 39.7559, lon: -104.9942, outDirs: ['E','SE','ESE','NE','ENE'] },
  'T-Mobile Park':                    { lat: 47.5914, lon: -122.3325, outDirs: ['N','NW','NNW','NE','NNE'] },
  'Comerica Park':                    { lat: 42.3390, lon: -83.0485, outDirs: ['S','SE','SSE','SW','SSW'] },
  'PNC Park':                         { lat: 40.4469, lon: -80.0057, outDirs: ['E','NE','ENE','SE','ESE'] },
  'Busch Stadium':                    { lat: 38.6226, lon: -90.1928, outDirs: ['N','NW','NNW','NE','NNE'] },
  'Truist Park':                      { lat: 33.8908, lon: -84.4678, outDirs: ['E','SE','ESE','NE','ENE'] },
  'Great American Ball Park':         { lat: 39.0979, lon: -84.5082, outDirs: ['N','NW','NNW','NE','NNE'] },
  'Guaranteed Rate Field':            { lat: 41.8300, lon: -87.6339, outDirs: ['S','SW','SSW','SE','SSE'] },
  'Camden Yards':                     { lat: 39.2838, lon: -76.6218, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Oriole Park at Camden Yards':      { lat: 39.2838, lon: -76.6218, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Nationals Park':                   { lat: 38.8730, lon: -77.0074, outDirs: ['E','SE','ESE','NE','ENE'] },
  'Citi Field':                       { lat: 40.7571, lon: -73.8458, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Kauffman Stadium':                 { lat: 39.0517, lon: -94.4803, outDirs: ['E','NE','ENE','SE','ESE'] },
  'Target Field':                     { lat: 44.9817, lon: -93.2781, outDirs: ['S','SE','SSE','SW','SSW'] },
  'Sutter Health Park':               { lat: 38.5802, lon: -121.5014, outDirs: ['S','SW','SSW','SE','SSE'] },
  'Petco Park':                       { lat: 32.7076, lon: -117.1570, outDirs: ['W','SW','WSW','NW','WNW'] },
  'Progressive Field':                { lat: 41.4962, lon: -81.6852, outDirs: ['S','SW','SSW','SE','SSE'] },
  'loanDepot park':                   { lat: 25.7781, lon: -80.2197, outDirs: ['E','NE','ENE','SE','ESE'] },
  'Daikin Park':                      { lat: 29.7573, lon: -95.3555, outDirs: ['S','SW','SSW','SE','SSE'] },
  'Citizens Bank Park':               { lat: 39.9061, lon: -75.1665, outDirs: ['N','NW','NNW','NE','NNE'] },
  'American Family Field':            { lat: 43.0280, lon: -87.9712, outDirs: null },
  'Chase Field':                      { lat: 33.4453, lon: -112.0667, outDirs: null },
  'Globe Life Field':                 { lat: 32.7473, lon: -97.0845, outDirs: null },
  'Minute Maid Park':                 { lat: 29.7573, lon: -95.3555, outDirs: null },
  'Tropicana Field':                  { lat: 27.7682, lon: -82.6534, outDirs: null },
  'Rogers Centre':                    { lat: 43.6414, lon: -79.3894, outDirs: null },
  'Angel Stadium':                    { lat: 33.8003, lon: -117.8827, outDirs: ['N','NW','NNW','NE','NNE'] },
  'Rate Field':                       { lat: 41.8300, lon: -87.6339, outDirs: ['S','SW','SSW','SE','SSE'] },
};

// weatherWeight tiers: HIGH reliability -> 1.0, MEDIUM -> 0.6, LOW -> 0.3
const STADIUM_NOTES = {
  'Wrigley Field':                  { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.05, notes: 'Wind swirls unpredictably around the bleachers and off Lake Michigan; forecast direction often disagrees with in-stadium wind.' },
  'Fenway Park':                    { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.08, notes: 'Green Monster and tight urban footprint can deflect wind away from official station readings.' },
  'Yankee Stadium':                 { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.10, notes: 'Open bowl design — wind tracks forecast closely.' },
  'UNIQLO Field at Dodger Stadium': { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.96, notes: 'Bowl shape and surrounding hills make surface wind unreliable versus forecast.' },
  'Dodger Stadium':                 { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.96, notes: 'Bowl shape and surrounding hills make surface wind unreliable versus forecast.' },
  'Oracle Park':                    { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.94, notes: 'Bay-driven wind off McCovey Cove can shift quickly within a game.' },
  // Humidor-era run factor — the pre-humidor ~1.30 figure overstates modern
  // Coors and pushed the projection ~1 run too high on its own.
  'Coors Field':                    { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 2, roofRetractable: false, parkFactor: 1.20, notes: 'Altitude (5,200ft) is the dominant scoring factor — wind is secondary.' },
  'T-Mobile Park':                  { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: true,  parkFactor: 0.95, notes: 'Retractable roof affects in-stadium wind even when open — verify roof status before betting.' },
  'Comerica Park':                  { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.97, notes: 'Open outfield design — wind tracks forecast closely.' },
  'PNC Park':                       { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.04, notes: 'River-side open design — wind tracks forecast closely.' },
  'Busch Stadium':                  { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.00, notes: 'Open bowl — wind generally matches forecast.' },
  'Truist Park':                    { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.02, notes: 'Open concourse design — wind tracks forecast closely.' },
  'Great American Ball Park':       { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.12, notes: 'River-side open park — wind tracks forecast closely.' },
  'Guaranteed Rate Field':          { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.99, notes: 'Open design — wind generally matches forecast.' },
  'Camden Yards':                   { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.07, notes: 'Warehouse beyond right field can create swirl that forecast wind direction misses.' },
  'Oriole Park at Camden Yards':    { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.07, notes: 'Warehouse beyond right field can create swirl that forecast wind direction misses.' },
  'Nationals Park':                 { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.00, notes: 'Open riverside design — wind tracks forecast closely.' },
  'Citi Field':                     { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.98, notes: 'Open design — wind generally reliable versus forecast.' },
  'Kauffman Stadium':               { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.01, notes: 'Open bowl — wind tracks forecast closely.' },
  'Target Field':                   { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.97, notes: 'Gusty conditions off the Minneapolis skyline can diverge from forecast readings.' },
  'Sutter Health Park':             { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.96, notes: 'Minor-league park in the Sacramento delta — prone to erratic gusts not captured by forecast.' },
  'Petco Park':                     { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.93, notes: 'Marine layer and bay proximity can shift wind quickly within a game.' },
  'Progressive Field':              { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.98, notes: 'Open design — wind generally matches forecast.' },
  'loanDepot park':                 { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 0.97, notes: 'Low-slung enclosed bowl plus retractable roof — surface wind rarely matches forecast even when open. Verify roof status before betting.' },
  'Daikin Park':                    { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 0.98, notes: 'Retractable roof — wind irrelevant when closed, unreliable versus forecast when open. Verify roof status before betting.' },
  'Citizens Bank Park':             { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.06, notes: 'Wind direction/speed commonly shifts between the morning forecast and first pitch — recheck closer to game time.' },
  'American Family Field':          { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 1.02, notes: 'Retractable roof — wind irrelevant when closed. Verify roof status before betting.' },
  'Chase Field':                    { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 1.04, notes: 'Retractable roof — wind irrelevant when closed. Verify roof status before betting.' },
  'Globe Life Field':               { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 1.01, notes: 'Retractable roof — wind irrelevant when closed. Verify roof status before betting.' },
  'Minute Maid Park':               { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 1.03, notes: 'Retractable roof — wind irrelevant when closed. Verify roof status before betting.' },
  'Tropicana Field':                { windReliability: 'LOW',    weatherWeight: 0.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.96, notes: 'Fixed dome, roof does not open — weather and wind are always irrelevant.' },
  'Rogers Centre':                  { windReliability: 'LOW',    weatherWeight: 0.3, altitudeBoost: 0, roofRetractable: true,  parkFactor: 1.01, notes: 'Retractable roof — wind irrelevant when closed. Verify roof status before betting.' },
  'Angel Stadium':                  { windReliability: 'MEDIUM', weatherWeight: 0.7, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.96, notes: 'Open design with nearby hills — wind generally tracks forecast but can shift moderately.' },
  'Rate Field':                     { windReliability: 'HIGH',   weatherWeight: 0.8, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.99, notes: 'Open design — wind generally matches forecast.' },
};

const CROSSWIND_DIRS = {
  'Wrigley Field':          ['E','W','ESE','WNW','ENE','WSW'],
  'Fenway Park':            ['E','W','ESE','WNW','ENE','WSW'],
  'Yankee Stadium':         ['N','S','NNE','SSW','NNW','SSE'],
  'Coors Field':            ['N','S','NNE','SSW','NNW','SSE'],
  'Comerica Park':          ['E','W','ESE','WNW','ENE','WSW'],
  'Truist Park':            ['N','S','NNE','SSW','NNW','SSE'],
  'Camden Yards':           ['N','S','NNE','SSW','NNW','SSE'],
  'Oriole Park at Camden Yards': ['N','S','NNE','SSW','NNW','SSE'],
  'Citi Field':             ['N','S','NNE','SSW','NNW','SSE'],
};

const LEAN_RANK = {
  'STRONG OVER': 6,
  'OVER': 5,
  'LEAN OVER': 4,
  'STRONG UNDER': 6,
  'UNDER': 5,
  'LEAN UNDER': 4,
  'AVOID': 2,
  'NEUTRAL': 0,
  'DOME — NEUTRAL': 0,
  'DOME — LEAN OVER': 3,
  'DOME — LEAN UNDER': 3,
};

// Signal priority hierarchy for over/under prediction, most to least predictive.
// Tier 1: starting pitcher xERA, park factor, HIGH-reliability-park wind at 10mph+.
// Tier 2: bullpen ERA quality, team OPS (last-15 + season agreement), temperature extremes, ERA-xERA regression gap.
const TIER_WEIGHTS = { 1: 3, 2: 2, 3: 1 };
const SCORE_NORMALIZATION = TIER_WEIGHTS[1]; // one Tier-1 signal ≈ 1.0 normalized point

// Precipitation probability (NWS forecast, %) above which a rain/storm
// mention triggers an AVOID skip. Below this, it's treated as routine
// summer shower chance, not a real postponement risk.
const SEVERE_RAIN_PROB_THRESHOLD = 70;

// --- Probability model ------------------------------------------------------
// Projects a game's expected total runs from the same inputs the signal
// scorecard already fetches, converts it to P(over) for each Kalshi strike,
// and calls an edge only when our probability beats the ask price plus
// Kalshi's trading fee by a real margin. This replaces "the market disagrees
// with my lean" — which treats market disagreement as free money — with
// "my estimated probability exceeds what the market is charging."
//
// League-baseline constants. These are deliberately explicit (not buried in
// formulas) so the 200-pick recalibration can revisit them against logged
// outcomes.
const LEAGUE_AVG_STARTER_ERA = 4.20;
const LEAGUE_AVG_BULLPEN_ERA = 4.10;
const LEAGUE_AVG_OPS = 0.720;
const RUNS_PER_EARNED_RUN = 1.08;    // unearned runs add ~8% on top of ERA
const STARTER_INNINGS = 5.5;         // league-typical starter workload
const BULLPEN_INNINGS = 3.5;
const OPS_RUN_ELASTICITY = 2.0;      // +10% OPS vs league ≈ +20% runs scored
const TOTAL_RUNS_SD_COEFF = 1.45;    // SD of game totals ≈ 1.45 * sqrt(mean) (≈4.3 at 8.7)

// Kalshi's taker fee: ceil'd 7% of price*(1-price) per contract. Charged on
// entry, so the true cost of a position is ask + fee.
const KALSHI_FEE_RATE = 0.07;
function kalshiFee(price) { return KALSHI_FEE_RATE * price * (1 - price); }

// Minimum probability edge (our P minus fee-adjusted cost) per label.
const EDGE_PRIME_TARGET = 0.08;
const EDGE_TARGET = 0.05;
const EDGE_CONSIDER = 0.02;

// Standard normal CDF (Abramowitz–Stegun erf approximation, |err| < 1.5e-7).
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Expected runs a team's pitching staff allows per game, from the starter's
// quality stat (xERA preferred) and IP-weighted bullpen ERA. Missing pieces
// fall back to league average and are counted against data quality.
function pitchingRunsAllowed(starterStats, bullpen, quality) {
  let starterEra = LEAGUE_AVG_STARTER_ERA;
  if (starterStats && (starterStats.xera != null || !isNaN(starterStats.era))) {
    starterEra = starterStats.xera != null ? starterStats.xera : starterStats.era;
  } else {
    quality.missing.push('starter');
  }
  let bullpenEra = LEAGUE_AVG_BULLPEN_ERA;
  if (bullpen && bullpen.era != null) bullpenEra = bullpen.era;
  else quality.missing.push('bullpen');

  return ((starterEra * STARTER_INNINGS) + (bullpenEra * BULLPEN_INNINGS)) / 9 * RUNS_PER_EARNED_RUN;
}

// Multiplier on runs scored from lineup quality vs league-average OPS.
// Blends season (60%) and last-15 (40%) OPS when both exist. opsDivisor
// park-neutralizes OPS that was accumulated half at an extreme home park.
function lineupRunFactor(hitters, quality, opsDivisor = 1) {
  if (!hitters || (hitters.seasonOps == null && hitters.recentOps == null)) {
    quality.missing.push('lineup');
    return 1;
  }
  const ops = (hitters.seasonOps != null && hitters.recentOps != null
    ? 0.6 * hitters.seasonOps + 0.4 * hitters.recentOps
    : (hitters.seasonOps ?? hitters.recentOps)) / opsDivisor;
  return 1 + OPS_RUN_ELASTICITY * (ops - LEAGUE_AVG_OPS) / LEAGUE_AVG_OPS;
}

// Weather multiplier only (park handled separately in projectGameTotal):
// temperature for outdoor games; wind only at HIGH-reliability wind parks
// (same trust rule as the scorecard).
function weatherFactor(stadiumNotes, weather, coords, venue, isDome) {
  let factor = 1;
  if (!isDome && weather) {
    const tempAdj = Math.max(-0.06, Math.min(0.09, (weather.avgTemp - 70) * 0.003));
    factor *= 1 + tempAdj;
    if (stadiumNotes?.windReliability === 'HIGH' && weather.maxWind >= 10 && coords?.outDirs) {
      const isOut = coords.outDirs.includes(weather.windDir);
      const isCross = CROSSWIND_DIRS[venue]?.includes(weather.windDir);
      if (isOut) factor *= weather.maxWind >= 15 ? 1.06 : 1.03;
      else if (!isCross) factor *= weather.maxWind >= 15 ? 0.94 : 0.97;
    }
  }
  return factor;
}

// Full game projection. Returns null when both starters are unknown — a
// projection built entirely on league-average pitching has nothing to say.
function projectGameTotal({ awayStats, homeStats, awayBullpen, homeBullpen, awayHitters, homeHitters, stadiumNotes, weather, coords, venue, isDome }) {
  const quality = { missing: [] };

  if (!awayStats && !homeStats) return null;

  // The HOME club's raw stats already embed roughly half of this park's
  // effect (they play half their games here): a Rockies pitcher's 5.5 ERA is
  // partly Coors, and a Rockies hitter's OPS is partly Coors. Applying the
  // full park factor on top of those raw numbers double-counts the park —
  // the first version of this model projected 17 runs at Coors that way.
  // pfHalf removes the embedded half from home-side inputs (OPS scales with
  // roughly the square root of the run factor), then the full park factor is
  // applied once to the neutralized total. Away-club stats accumulate across
  // a mix of parks and are treated as neutral.
  const pf = stadiumNotes?.parkFactor ?? 1;
  const pfHalf = (1 + pf) / 2;

  const awayRunsAllowed = pitchingRunsAllowed(awayStats, awayBullpen, quality);
  const homeRunsAllowed = pitchingRunsAllowed(homeStats, homeBullpen, quality) / pfHalf;
  const awayOffense = lineupRunFactor(awayHitters, quality);
  const homeOffense = lineupRunFactor(homeHitters, quality, Math.sqrt(pfHalf));
  const wx = weatherFactor(stadiumNotes, weather, coords, venue, isDome);

  // Away team scores against home pitching (scaled by away offense), and
  // vice versa; park and weather scale both.
  const projectedTotal = (homeRunsAllowed * awayOffense + awayRunsAllowed * homeOffense) * pf * wx;
  const sd = TOTAL_RUNS_SD_COEFF * Math.sqrt(projectedTotal);

  return { projectedTotal, sd, missing: quality.missing };
}

// P(total > strike) under the normal model. Strikes are X.5 so no push case.
function probOver(projection, strike) {
  return 1 - normalCdf((strike - projection.projectedTotal) / projection.sd);
}

// How far from the projected total a strike may sit and still be considered.
// The normal model's tails are its least trustworthy region (real run
// distributions are right-skewed), and Kalshi's far-tail books are thin with
// wide spreads — un-constrained search reliably "finds" its biggest edges
// exactly there (e.g. UNDER 2.5 at a 9% model probability), which are model
// artifacts, not value. Same reason for the cost bounds: sub-10-cent and
// 90-cent-plus contracts are longshot/lock territory where the model has no
// standing to disagree with the market.
const STRIKE_SEARCH_WINDOW = 2.0;
const MIN_CONTRACT_COST = 0.10;
const MAX_CONTRACT_COST = 0.90;

// When the model's projected total sits further than this from the market's
// own implied center, the humble read is that the model is missing something
// the market knows (roof status, humidor, late scratches), not that a
// 20-point edge appeared out of nowhere — cap those at CONSIDER instead of
// logging them as bets.
const MODEL_DISAGREEMENT_CAP = 2.5;

// Evaluates Kalshi strikes near the projection on both sides and returns the
// single best fee-adjusted edge, labeled by size. Searches beyond just the
// strike nearest the book total — mispricing is at least as likely one
// strike away from the consensus number — but stays inside the window where
// the normal approximation and market liquidity are both credible.
function detectProbEdge(projection, kalshiStrikes) {
  if (!projection) return { label: 'NO MODEL', reason: 'Insufficient pitcher data to project this game.' };
  if (!kalshiStrikes || !kalshiStrikes.length) return { label: 'No Kalshi market', reason: 'No Kalshi market found — skipping edge scoring.' };

  let best = null;
  for (const s of kalshiStrikes) {
    if (Math.abs(s.strike - projection.projectedTotal) > STRIKE_SEARCH_WINDOW) continue;
    const pOver = probOver(projection, s.strike);
    const candidates = [
      { side: 'OVER', prob: pOver, cost: s.overCost },
      { side: 'UNDER', prob: 1 - pOver, cost: s.underCost },
    ];
    for (const c of candidates) {
      if (c.cost == null || c.cost < MIN_CONTRACT_COST || c.cost > MAX_CONTRACT_COST) continue;
      const effectiveCost = c.cost + kalshiFee(c.cost);
      const edge = c.prob - effectiveCost;
      if (!best || edge > best.edge) {
        best = { side: c.side, strike: s.strike, ticker: s.ticker, cost: c.cost, effectiveCost, ourProb: c.prob, edge };
      }
    }
  }

  if (!best) return { label: 'No Kalshi market', reason: 'No usable Kalshi pricing.' };

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const detail = `model ${pct(best.ourProb)} vs cost ${pct(best.effectiveCost)} (incl. fee) on ${best.side} ${best.strike} — edge ${pct(best.edge)}`;

  // Market's implied center: the strike priced closest to a coin flip. If the
  // projection disagrees with that center by more than the cap, refuse to
  // treat the gap as a bettable edge regardless of its size.
  let marketCenter = null;
  let centerDist = Infinity;
  for (const s of kalshiStrikes) {
    if (s.overCost == null) continue;
    const d = Math.abs(s.overCost - 0.5);
    if (d < centerDist) { centerDist = d; marketCenter = s.strike; }
  }
  if (marketCenter != null && Math.abs(projection.projectedTotal - marketCenter) > MODEL_DISAGREEMENT_CAP) {
    return { ...best, label: 'CONSIDER', reason: `Model projects ${projection.projectedTotal.toFixed(1)} but the market centers near ${marketCenter} — disagreement too large to trust as an edge (${detail})` };
  }

  if (best.edge >= EDGE_PRIME_TARGET) return { ...best, label: 'PRIME TARGET', reason: `Large probability edge: ${detail}` };
  if (best.edge >= EDGE_TARGET) return { ...best, label: 'TARGET', reason: `Probability edge: ${detail}` };
  if (best.edge >= EDGE_CONSIDER) return { ...best, label: 'CONSIDER', reason: `Marginal probability edge: ${detail}` };
  return { ...best, label: 'PASS', reason: `No probability edge after fees: ${detail}` };
}

function computeConfidence(weightedSignals) {
  const count = (tier, direction) => weightedSignals.filter(w => w.tier === tier && w.direction === direction).length;
  // NET counts, not max: confidence reflects how decisively the signals point
  // one way. The old max-based version graded 2 Tier-1 OVERs + 3 Tier-1
  // UNDERs as "HIGH" — heavily contested reads were labeled as the most
  // trustworthy. Opposing signals now cancel before grading.
  const tier1Net = Math.abs(count(1, 'OVER') - count(1, 'UNDER'));
  const tier2Net = Math.abs(count(2, 'OVER') - count(2, 'UNDER'));

  if (tier1Net >= 2) return 'HIGH';
  if (tier1Net >= 1 || tier2Net >= 3) return 'MEDIUM';
  return 'LOW';
}

async function getPitcherStats(pitcherName, pitcherId) {
  try {
    // Prefer the pitcher ID from the schedule's probablePitcher — a name
    // search takes the first hit, which can be a different player entirely
    // for common names. Name search remains only as a fallback.
    let playerId = pitcherId;
    if (!playerId) {
      const search = await axios.get(
        `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(pitcherName)}`
      );
      playerId = search.data.people?.[0]?.id;
      if (!playerId) return null;
    }

    const stats = await axios.get(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${new Date().getFullYear()}&group=pitching`
    );

    const splits = stats.data.stats?.[0]?.splits?.[0]?.stat;
    if (!splits) return null;

    let xera = await getXERA(playerId);
    // Sanity check: xERA > 8.0 suggests unreliable small sample — skip from scoring.
    if (xera != null && xera > 8.0) xera = null;

    return {
      name: pitcherName,
      era: parseFloat(splits.era),
      groundOutsToAirouts: parseFloat(splits.groundOutsToAirouts),
      strikeoutsPer9Inn: parseFloat(splits.strikeoutsPer9Inn),
      walksPer9Inn: parseFloat(splits.walksPer9Inn),
      whip: parseFloat(splits.whip),
      xera,
    };
  } catch {
    return null;
  }
}

// Baseball Savant's custom leaderboard CSV does not expose FIP/xFIP (those are
// FanGraphs metrics, not Statcast-derived) — confirmed empty on live pulls for
// both 2025 (completed season) and 2026. xERA is the closest real Statcast
// equivalent (expected ERA from quality of contact), so it's used in its place.
let savantXeraTable = null;

function parseSavantCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function parseSavantCSV(content) {
  const lines = content.replace(/^﻿/, '').trim().split('\n').filter(Boolean);
  const headers = parseSavantCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const fields = parseSavantCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (fields[i] || '').trim(); });
    return obj;
  });
}

async function getXERA(playerId) {
  try {
    const year = new Date().getFullYear();
    // Cache per calendar day, not per year — the leaderboard updates daily,
    // and a long-lived daemon holding a year-keyed cache would serve xERA
    // values frozen at whenever the process started.
    const day = new Date().toISOString().split('T')[0];
    if (!savantXeraTable || savantXeraTable.day !== day) {
      const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=1&selections=p_game,p_formatted_ip,p_era,xera&chart=false&x=p_era&y=xera&r=no&toggledStat=&csv=true`;
      const res = await axios.get(url);
      savantXeraTable = { day, rows: parseSavantCSV(res.data) };
    }
    const row = savantXeraTable.rows.find(r => r.player_id === String(playerId));
    return row?.xera ? parseFloat(row.xera) : null;
  } catch {
    return null;
  }
}

async function getTeamHitters(teamId, lineupPlayerIds) {
  try {
    // Prefer the actual posted lineup (from schedule hydrate=lineups) when
    // MLB has published it — the roster fallback takes the first 9 position
    // players in arbitrary roster order, which can include bench bats and
    // miss the stars actually playing today.
    let batters;
    if (lineupPlayerIds && lineupPlayerIds.length >= 9) {
      batters = lineupPlayerIds.map(id => ({ person: { id } }));
    } else {
      const roster = await axios.get(
        `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`
      );
      batters = roster.data.roster.filter(p => p.position.code !== '1');
    }

    const statsPromises = batters.slice(0, 9).map(async (player) => {
      try {
        const season = new Date().getFullYear();
        const [recentRes, seasonRes] = await Promise.all([
          axios.get(`https://statsapi.mlb.com/api/v1/people/${player.person.id}/stats?stats=lastXGames&season=${season}&group=hitting&limit=15`),
          axios.get(`https://statsapi.mlb.com/api/v1/people/${player.person.id}/stats?stats=season&season=${season}&group=hitting`),
        ]);
        const recentStat = recentRes.data.stats?.[0]?.splits?.[0]?.stat;
        const seasonStat = seasonRes.data.stats?.[0]?.splits?.[0]?.stat;
        return {
          // Same minimum-AB filter used for both windows — ported as-is from the
          // lastXGames qualifier rather than redesigned for season sample size.
          recentOps: (recentStat && recentStat.atBats >= 10) ? parseFloat(recentStat.ops || 0) : null,
          seasonOps: (seasonStat && seasonStat.atBats >= 10) ? parseFloat(seasonStat.ops || 0) : null,
        };
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(statsPromises)).filter(Boolean);
    const recentValues = results.map(r => r.recentOps).filter(v => v != null);
    const seasonValues = results.map(r => r.seasonOps).filter(v => v != null);

    return {
      recentOps: recentValues.length ? recentValues.reduce((a, b) => a + b, 0) / recentValues.length : null,
      seasonOps: seasonValues.length ? seasonValues.reduce((a, b) => a + b, 0) / seasonValues.length : null,
    };
  } catch {
    return { recentOps: null, seasonOps: null };
  }
}

// Keyed by teamId + date: within one day's run the same team's bullpen is
// fetched once, but a long-lived daemon gets fresh stats each day instead of
// serving numbers frozen at whenever the process happened to start.
const bullpenCache = new Map();

async function getBullpenStats(teamId, starterPlayerId) {
  const cacheKey = `${teamId}-${new Date().toISOString().split('T')[0]}`;
  if (bullpenCache.has(cacheKey)) return bullpenCache.get(cacheKey);

  let result = { era: null, whip: null };
  try {
    const rosterRes = await axios.get(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`);
    const relievers = rosterRes.data.roster.filter(p => p.position.code === '1' && p.person.id !== starterPlayerId);

    const statLines = await Promise.all(relievers.map(p =>
      axios.get(`https://statsapi.mlb.com/api/v1/people/${p.person.id}/stats?stats=season&season=${new Date().getFullYear()}&group=pitching`)
        .then(res => res.data.stats?.[0]?.splits?.[0]?.stat)
        .catch(() => null)
    ));

    // Weight by innings pitched — an unweighted mean counts a 6-IP mop-up
    // arm the same as a 40-IP setup man, letting fringe relievers swing the
    // team number well away from how the bullpen actually pitches most nights.
    const qualified = statLines.filter(s => s && parseFloat(s.inningsPitched) >= 5);
    const totalIP = qualified.reduce((sum, s) => sum + parseFloat(s.inningsPitched), 0);
    const era = totalIP > 0 ? qualified.reduce((sum, s) => sum + parseFloat(s.era) * parseFloat(s.inningsPitched), 0) / totalIP : null;
    const whip = totalIP > 0 ? qualified.reduce((sum, s) => sum + parseFloat(s.whip) * parseFloat(s.inningsPitched), 0) / totalIP : null;

    result = { era, whip };
  } catch {
    // keep defaults
  }

  bullpenCache.set(cacheKey, result);
  return result;
}

function scoreBullpen(awayBullpen, homeBullpen) {
  const signals = [];
  const weighted = [];
  let overScore = 0;
  let underScore = 0;

  const add = (text, direction, tier, id) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight, id });
    if (direction === 'OVER') overScore += weight; else underScore += weight;
  };

  // Bullpen ERA quality only — no fatigue/workload component, at most one signal per team.
  for (const [side, bullpen] of [['Away', awayBullpen], ['Home', homeBullpen]]) {
    if (!bullpen || bullpen.era == null) continue;

    if (bullpen.era >= 4.50) {
      add(`${side} poor bullpen quality — late innings vulnerable`, 'OVER', 2, 'bullpen_poor');
    } else if (bullpen.era < 3.20) {
      add(`${side} elite bullpen quality`, 'UNDER', 2, 'bullpen_elite');
    }
  }

  return { overScore, underScore, signals, weighted };
}

async function getWeather(lat, lon, gameStartIso) {
  try {
    const pointRes = await axios.get(`https://api.weather.gov/points/${lat},${lon}`);
    const forecastUrl = pointRes.data.properties.forecastHourly;
    const forecastRes = await axios.get(forecastUrl);
    const periods = forecastRes.data.properties.periods;

    // Window the forecast around first pitch, not around "now" — the noon-ET
    // analysis run was previously scoring 7pm games on midday weather. Start
    // one period before first pitch and cover roughly the game's duration;
    // fall back to the next 6 hours when no start time is given or the game
    // has already begun.
    let startIdx = 0;
    if (gameStartIso) {
      const gameStart = new Date(gameStartIso);
      const idx = periods.findIndex(p => new Date(p.endTime) > gameStart);
      if (idx > 0) startIdx = idx;
    }
    const window = periods.slice(startIdx, startIdx + 5);
    if (!window.length) return null;

    const temps = window.map(p => p.temperature);
    const winds = window.map(p => parseInt(p.windSpeed));
    const precipProbs = window.map(p => p.probabilityOfPrecipitation?.value ?? 0);

    return {
      avgTemp: Math.round(temps.reduce((a, b) => a + b) / temps.length),
      maxWind: Math.max(...winds),
      windDir: window[0].windDirection,
      condition: window[0].shortForecast,
      maxPrecipProb: Math.max(...precipProbs),
    };
  } catch {
    return null;
  }
}

function scorePitchers(awayStats, homeStats) {
  const signals = [];
  const weighted = [];
  let overScore = 0;
  let underScore = 0;

  const add = (text, direction, tier, id) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight, id });
    if (direction === 'OVER') overScore += weight; else underScore += weight;
  };

  for (const [side, stats] of [['Away', awayStats], ['Home', homeStats]]) {
    if (!stats) continue;

    const usingXera = stats.xera != null;
    const qualityStat = usingXera ? stats.xera : stats.era;
    const qualityLabel = usingXera ? `xERA ${qualityStat.toFixed(2)} (ERA ${stats.era.toFixed(2)})` : `ERA ${stats.era.toFixed(2)}`;
    const isElite = qualityStat < 2.75;
    const isSolid = qualityStat < 3.50;
    const isHittable = qualityStat > 4.75;

    // Tier 1 — starting pitcher xERA is the primary quality signal.
    if (isElite) {
      add(`${side} pitcher ${qualityLabel} — elite, suppresses scoring`, 'UNDER', 1, 'pitcher_elite');
    } else if (isSolid) {
      add(`${side} pitcher ${qualityLabel} — solid, mild under lean`, 'UNDER', 1, 'pitcher_solid');
    } else if (isHittable) {
      add(`${side} pitcher ${qualityLabel} — hittable, over lean`, 'OVER', 1, 'pitcher_hittable');
    }

    // Tier 2 — ERA-xERA gap is a luck/regression indicator.
    if (usingXera) {
      const gap = stats.era - stats.xera;
      if (gap < -1.0) {
        add(`${side} ERA-xERA gap — pitcher has been lucky, regression risk`, 'OVER', 2, 'era_gap_lucky');
      } else if (gap > 1.0) {
        add(`${side} ERA-xERA gap — pitcher has been unlucky, expect improvement`, 'UNDER', 2, 'era_gap_unlucky');
      }
    }
  }

  return { overScore, underScore, signals, weighted };
}

function scoreLineup(teamHitters, label) {
  const signals = [];
  const weighted = [];
  let overScore = 0;
  let underScore = 0;

  if (!teamHitters) return { overScore, underScore, signals, weighted };

  const add = (text, direction, tier, id) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight, id });
    if (direction === 'OVER') overScore += weight; else underScore += weight;
  };

  const { recentOps, seasonOps } = teamHitters;
  const dirOf = (ops) => ops == null ? null : ops > 0.780 ? 'OVER' : ops < 0.660 ? 'UNDER' : null;
  const recentDir = dirOf(recentOps);
  const seasonDir = dirOf(seasonOps);

  // Tier 2 — only score when last-15-games OPS and season OPS agree on direction;
  // disagreement (or missing data on either side) is treated as neutral.
  if (recentDir != null && recentDir === seasonDir) {
    const verb = recentDir === 'OVER' ? 'hot' : 'cold';
    add(`${label} lineup ${verb} — recent OPS ${recentOps.toFixed(3)} and season OPS ${seasonOps.toFixed(3)} agree`, recentDir, 2, recentDir === 'OVER' ? 'lineup_hot' : 'lineup_cold');
  } else {
    if (recentOps != null) signals.push(`${label} lineup OPS last 15 games: ${recentOps.toFixed(3)}`);
    if (seasonOps != null) signals.push(`${label} lineup season OPS: ${seasonOps.toFixed(3)}`);
  }

  return { overScore, underScore, signals, weighted };
}

function analyzeGame(weather, venue, awayStats, homeStats, awayHitters, homeHitters, awayBullpen, homeBullpen) {
  const stadium = STADIUMS[venue];
  if (!stadium) return { lean: 'UNKNOWN VENUE', signals: [], score: 0, confidence: 'N/A' };

  const isDome = !stadium.outDirs;
  if (!isDome && !weather) return { lean: 'NO DATA', signals: ['Could not fetch weather'], score: 0, confidence: 'N/A' };

  const signals = [];
  const weighted = [];
  let overScore = 0;
  let underScore = 0;
  const stadiumNotes = STADIUM_NOTES[venue];

  const add = (text, direction, tier, id) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight, id });
    if (direction === 'OVER') overScore += weight; else underScore += weight;
  };
  const merge = (result) => {
    signals.push(...result.signals);
    weighted.push(...result.weighted);
    overScore += result.overScore;
    underScore += result.underScore;
  };

  // Tier 1 — park factor is a structural scoring environment signal, independent of weather/dome.
  if (stadiumNotes?.parkFactor != null) {
    const pf = stadiumNotes.parkFactor;
    if (pf > 1.08) {
      add(`Hitter-friendly park (factor ${pf.toFixed(2)})`, 'OVER', 1, 'park_hitter');
    } else if (pf < 0.95) {
      add(`Pitcher-friendly park (factor ${pf.toFixed(2)})`, 'UNDER', 1, 'park_pitcher');
    } else {
      signals.push(`Park factor: ${pf.toFixed(2)}`);
    }
  }

  if (isDome) {
    signals.push('Weather irrelevant — dome');
  } else {
    const { avgTemp, maxWind, windDir, condition, maxPrecipProb } = weather;

    const isOut = stadium.outDirs.includes(windDir);
    const isCross = CROSSWIND_DIRS[venue]?.includes(windDir);
    const isIn = !isOut && !isCross;

    // Wind direction only scores at HIGH-reliability parks (Tier 1) — MEDIUM and LOW
    // parks get the same display text but contribute zero scoring signal, no exceptions.
    const isHighWindPark = stadiumNotes?.windReliability === 'HIGH';

    if (maxWind >= 15 && isOut) {
      const text = `Wind OUT at ${maxWind}mph ${windDir} — ball carries, HR risk up`;
      if (isHighWindPark) add(text, 'OVER', 1, 'wind_out_strong'); else signals.push(text);
    } else if (maxWind >= 10 && isOut) {
      const text = `Wind OUT at ${maxWind}mph ${windDir} — mild carry boost`;
      if (isHighWindPark) add(text, 'OVER', 1, 'wind_out_mild'); else signals.push(text);
    } else if (maxWind >= 15 && isIn) {
      const text = `Wind IN at ${maxWind}mph ${windDir} — fly balls die, pitchers favored`;
      if (isHighWindPark) add(text, 'UNDER', 1, 'wind_in_strong'); else signals.push(text);
    } else if (maxWind >= 10 && isIn) {
      const text = `Wind IN at ${maxWind}mph ${windDir} — mild suppression`;
      if (isHighWindPark) add(text, 'UNDER', 1, 'wind_in_mild'); else signals.push(text);
    } else if (maxWind >= 10) {
      signals.push(`Crosswind at ${maxWind}mph ${windDir} — minimal scoring effect`);
    } else {
      signals.push(`Calm wind at ${maxWind}mph — no wind edge`);
    }

    if (stadiumNotes?.windReliability === 'LOW') {
      signals.push(`⚠️ WIND UNRELIABLE — ${stadiumNotes.notes}`);
    } else if (stadiumNotes?.windReliability === 'MEDIUM') {
      signals.push(`⚡ VERIFY WIND — ${stadiumNotes.notes}`);
    }

    // Altitude is display-only: Coors' parkFactor (1.30) already encodes the
    // altitude effect, and it fires its own Tier-1 OVER above. Scoring
    // altitude separately double-counted the same physical cause, giving
    // Coors games an automatic two-Tier-1 head start (and HIGH confidence)
    // before any pitcher/lineup signal was even considered — the market
    // already prices Coors, so that head start was pure noise.
    if (stadiumNotes?.altitudeBoost) {
      signals.push(`Altitude park (${venue}) — effect already captured in park factor`);
    }

    // Tier 2 — temperature extremes only (90F+ / 50F-); mild warm/cool bands display only.
    if (avgTemp >= 90) {
      add(`Very hot (${avgTemp}F) — ball carries significantly`, 'OVER', 2, 'temp_hot');
    } else if (avgTemp >= 80) {
      signals.push(`Warm (${avgTemp}F) — slight carry boost`);
    } else if (avgTemp <= 50) {
      add(`Cold (${avgTemp}F) — ball suppressed noticeably`, 'UNDER', 2, 'temp_cold');
    } else if (avgTemp <= 60) {
      signals.push(`Cool (${avgTemp}F) — mild suppression`);
    } else {
      signals.push(`Neutral temp (${avgTemp}F)`);
    }

    // A "chance" or "isolated/scattered" pop-up storm mention is routine
    // summer MLB weather, not a reason to skip — most games carry some
    // rain chance in their forecast. Only auto-skip when precipitation
    // probability is genuinely high (SEVERE_RAIN_PROB_THRESHOLD+), which is
    // where NWS language shifts to "likely"/"widespread" and postponement
    // becomes a real possibility.
    const rainKeywords = ['rain', 'shower', 'storm', 'thunderstorm', 'drizzle'];
    const hasRainKeyword = rainKeywords.some(k => condition.toLowerCase().includes(k));
    if (hasRainKeyword && maxPrecipProb >= SEVERE_RAIN_PROB_THRESHOLD) {
      signals.push(`${condition} (${maxPrecipProb}% precip) — high postponement risk, avoid or wait`);
      return { lean: 'AVOID', signals, score: 0, confidence: 'N/A' };
    } else if (hasRainKeyword) {
      signals.push(`${condition} (${maxPrecipProb}% precip) — rain chance noted, not severe enough to skip`);
    }
  }

  const pitcherResult = scorePitchers(awayStats, homeStats);
  merge(pitcherResult);

  const awayLineup = scoreLineup(awayHitters, 'Away');
  const homeLineup = scoreLineup(homeHitters, 'Home');
  merge(awayLineup);
  merge(homeLineup);

  const bullpenResult = scoreBullpen(awayBullpen, homeBullpen);
  merge(bullpenResult);

  const rawScore = overScore - underScore;
  const score = Math.round(rawScore / SCORE_NORMALIZATION);

  let lean;
  if (isDome) {
    lean = 'DOME — NEUTRAL';
    if (score >= 2) lean = 'DOME — LEAN OVER';
    else if (score <= -2) lean = 'DOME — LEAN UNDER';
  } else {
    if (score >= 4) lean = 'STRONG OVER';
    else if (score === 3) lean = 'OVER';
    else if (score === 2) lean = 'LEAN OVER';
    else if (score === -2) lean = 'LEAN UNDER';
    else if (score === -3) lean = 'UNDER';
    else if (score <= -4) lean = 'STRONG UNDER';
    else lean = 'NEUTRAL'; // covers score === 1, 0, -1 — TILT removed, folds into NEUTRAL
  }

  const confidence = computeConfidence(weighted);

  return { lean, signals, score, confidence, weighted };
}
async function getOdds() {
  try {
    const res = await axios.get('https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/', {
      params: {
        apiKey: process.env.ODDS_API_KEY,
        regions: 'us',
        markets: 'totals',
        oddsFormat: 'american',
        dateFormat: 'iso',
      },
    });
    // The Odds API free tier has a monthly request quota; when it's exhausted
    // every game shows "No odds available" with no explanation. Log the
    // remaining balance each call so quota exhaustion is visible in daemon.log
    // before it becomes a mystery.
    const remaining = res.headers['x-requests-remaining'];
    if (remaining != null) {
      appendDaemonLog(`[ODDS-API] requests remaining this period: ${remaining}`);
      if (parseFloat(remaining) < 50) console.log(`⚠️ Odds API quota low: ${remaining} requests remaining`);
    }
    const oddsMap = {};
    for (const game of res.data) {
      const key = `${game.away_team}|${game.home_team}`;
      const lines = [];
      for (const book of game.bookmakers) {
        const market = book.markets.find(m => m.key === 'totals');
        if (!market) continue;
        const over = market.outcomes.find(o => o.name === 'Over');
        const under = market.outcomes.find(o => o.name === 'Under');
        if (over && under) lines.push({ point: over.point, overPrice: over.price, underPrice: under.price });
      }
      if (lines.length > 0) {
        // American odds must be averaged in implied-probability space, not
        // directly — a raw mean of e.g. -110 and +105 lands between -100 and
        // +100, which isn't a valid American price at all. Direct averaging
        // shipped originally and wrote impossible juice like "-19" and "+6"
        // into picks_log.csv, inflating HIT payouts in calcPnL.
        const americanToProb = (a) => a < 0 ? -a / (-a + 100) : 100 / (a + 100);
        const probToAmericanStr = (p) => {
          const a = p >= 0.5 ? -(p * 100) / (1 - p) : ((1 - p) * 100) / p;
          return a >= 0 ? `+${Math.round(a)}` : `${Math.round(a)}`;
        };
        const avgTotal = lines.reduce((a, b) => a + b.point, 0) / lines.length;
        const avgOverProb = lines.reduce((a, b) => a + americanToProb(b.overPrice), 0) / lines.length;
        const avgUnderProb = lines.reduce((a, b) => a + americanToProb(b.underPrice), 0) / lines.length;
        const overJuice = probToAmericanStr(avgOverProb);
        const underJuice = probToAmericanStr(avgUnderProb);
        oddsMap[key] = {
          display: `O/U ${avgTotal.toFixed(1)} | Over ${overJuice} / Under ${underJuice} (avg of ${lines.length} books)`,
          total: avgTotal.toFixed(1),
          overJuice,
          underJuice,
        };
      }
    }
    return oddsMap;
  } catch {
    return {};
  }
}

// --- Kalshi market price integration ---------------------------------------
// NOTE: Kalshi retired trading-api.kalshi.com in favor of api.elections.kalshi.com
// (confirmed live — the old host now 401s with a redirect notice). Markets also
// no longer expose plain integer yes_bid/no_bid cent fields; they return
// yes_bid_dollars/no_bid_dollars as decimal-dollar strings instead. Both were
// verified directly against the live API before writing this.

const KALSHI_API_BASE = 'https://api.elections.kalshi.com';
const KALSHI_PATH_PREFIX = '/trade-api/v2';
const KALSHI_KEY_PATH = path.join(__dirname, 'kalshi_private_key.pem');

let kalshiPrivateKeyCache = null;
function getKalshiPrivateKey() {
  if (kalshiPrivateKeyCache) return kalshiPrivateKeyCache;
  if (process.env.KALSHI_PRIVATE_KEY) {
    // Hosts like Railway store multi-line PEM values with literal "\n" —
    // normalize those to real newlines; a no-op if they're already real.
    kalshiPrivateKeyCache = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    kalshiPrivateKeyCache = fs.readFileSync(KALSHI_KEY_PATH, 'utf8');
  }
  return kalshiPrivateKeyCache;
}

function signKalshiRequest(method, pathWithPrefix) {
  const timestamp = Date.now().toString();
  const message = timestamp + method + pathWithPrefix;
  const privateKey = getKalshiPrivateKey();
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return {
    'KALSHI-ACCESS-KEY': process.env.KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  };
}

// Confirms the private key loads and can actually produce an RSA-PSS signature
// — a local check, no network call — so a bad/missing KALSHI_PRIVATE_KEY env
// var on Railway shows up immediately in the deploy logs instead of surfacing
// later as silent "No Kalshi market found" results.
function verifyKalshiAuth() {
  try {
    signKalshiRequest('GET', `${KALSHI_PATH_PREFIX}/markets`);
    console.log('Kalshi auth: OK');
    return true;
  } catch (err) {
    console.log(`Kalshi auth: FAILED - check KALSHI_PRIVATE_KEY env var (${err.message})`);
    return false;
  }
}

async function kalshiGet(pathNoQuery, params) {
  const headers = signKalshiRequest('GET', pathNoQuery);
  const res = await axios.get(`${KALSHI_API_BASE}${pathNoQuery}`, { headers, params });
  return res.data;
}

// A market's "yes" price is a probability expressed in dollars (e.g. "0.4700"
// for 47%); decimal odds are just its inverse (1 / 0.47 = 2.13x).
function kalshiDollarsToDecimal(dollarStr) {
  const p = parseFloat(dollarStr);
  return p > 0 ? 1 / p : null;
}

// Converts decimal odds (e.g. 2.13x) to an American odds string (e.g. "+113"),
// matching the format Side_Juice already uses when it comes from the Odds API.
function decimalToAmericanOdds(decimal) {
  if (decimal == null) return null;
  const american = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  return american >= 0 ? `+${Math.round(american)}` : `${Math.round(american)}`;
}

const KALSHI_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
// Converts a 'YYYY-MM-DD' (UTC) date string into Kalshi's ticker date token,
// e.g. '2026-06-24' -> '26JUN24'. Kalshi's event_ticker embeds this token
// right after the series prefix (e.g. KXMLBTOTAL-26JUN241910CHCNYM...).
function kalshiDateToken(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${y.slice(2)}${KALSHI_MONTHS[parseInt(m, 10) - 1]}${d}`;
}

// Extracts the date token embedded in an event_ticker right after the series
// prefix (e.g. 'KXMLBTOTAL-26JUN241910CHCNYM' -> '26JUN24'), or null if absent.
function kalshiTickerDateToken(eventTicker) {
  const match = (eventTicker || '').match(/^[A-Z]+-(\d{2}[A-Z]{3}\d{2})/);
  return match ? match[1] : null;
}

// Fetches today's open MLB total-runs markets from Kalshi (series KXMLBTOTAL)
// and returns a map of "{away}|{home}" -> { overPrice, underPrice } in decimal
// odds format. Each game has one Kalshi market per strike (e.g. 6.5, 7.5, 8.5
// runs) rather than a single line like a sportsbook, so games are matched via
// the team abbreviations embedded in event_ticker (e.g. "CHCNYM"), filtered to
// tickers whose embedded date matches today — Kalshi has been observed leaving
// stale markets from prior days flagged "open" (e.g. a 2-day-old CHC/NYM total
// market with degenerate prices), so the date check rejects those outright.
// The strike closest to the sportsbook's posted total is selected when a total
// is available; otherwise the strike nearest a 0.50 yes price (the market's
// own implied pick'em line) is used instead, so a missing sportsbook total no
// longer skips the game entirely. Returns an empty map on any failure or when
// nothing matches — callers fall back to sportsbook odds in that case.
async function getKalshiMLBPrices(games, today) {
  const priceMap = new Map();
  const todayToken = kalshiDateToken(today);

  let markets;
  try {
    const data = await kalshiGet(`${KALSHI_PATH_PREFIX}/markets`, { status: 'open', limit: 1000, series_ticker: 'KXMLBTOTAL' });
    markets = data?.markets || [];
  } catch (err) {
    appendDaemonLog(`[KALSHI-DEBUG] Failed to fetch Kalshi markets: ${err.message}`);
    return priceMap;
  }

  for (const { away, home, awayAbbr, homeAbbr, total, gameNumber, isDoubleheader } of games) {
    const label = `${away} @ ${home}${isDoubleheader ? ` (Game ${gameNumber})` : ''}`;

    if (!awayAbbr || !homeAbbr) {
      appendDaemonLog(`[KALSHI-DEBUG] ${label} | oddsTotal=${total ?? 'NONE'} | matchAttempted=no (missing team abbreviation) | result=SKIPPED`);
      continue;
    }

    // Doubleheader event tickers carry a G-suffix after the team pair
    // (e.g. ...MILSTLG1 / ...MILSTLG2); single games have no suffix
    // (e.g. ...CHCBAL). Without matching the suffix to this game's number,
    // both games' strike markets get mixed into one pool and the second
    // game's prices overwrite the first's in the map.
    const abbrPair = `${awayAbbr}${homeAbbr}`;
    const suffixRe = new RegExp(`${abbrPair}(?:G(\\d))?$`);
    const gameMarkets = markets.filter(m => {
      const ticker = m.event_ticker || '';
      if (kalshiTickerDateToken(ticker) !== todayToken) return false;
      const match = ticker.match(suffixRe);
      if (!match) return false;
      const tickerGameNum = match[1] ? parseInt(match[1], 10) : null;
      return isDoubleheader ? tickerGameNum === gameNumber : tickerGameNum === null;
    });

    if (!gameMarkets.length) {
      appendDaemonLog(`[KALSHI-DEBUG] ${label} | oddsTotal=${total ?? 'NONE'} | matchAttempted=yes (abbrPair=${abbrPair}) | result=NO_TICKER_MATCH (0 markets found for date token ${todayToken})`);
      continue;
    }

    // When there's no sportsbook total to anchor against, fall back to the
    // strike nearest a 0.50 yes price as the market's own implied consensus line.
    let best = null;
    let bestDiff = Infinity;
    if (total != null) {
      const targetTotal = parseFloat(total);
      for (const m of gameMarkets) {
        if (m.floor_strike == null) continue;
        const diff = Math.abs(m.floor_strike - targetTotal);
        if (diff < bestDiff) { bestDiff = diff; best = m; }
      }
    } else {
      for (const m of gameMarkets) {
        const yesPrice = parseFloat(m.yes_bid_dollars);
        if (isNaN(yesPrice)) continue;
        const diff = Math.abs(yesPrice - 0.5);
        if (diff < bestDiff) { bestDiff = diff; best = m; }
      }
    }

    if (!best) {
      appendDaemonLog(`[KALSHI-DEBUG] ${label} | oddsTotal=${total ?? 'NONE'} | matchAttempted=yes (abbrPair=${abbrPair}) | result=NO_USABLE_STRIKE (${gameMarkets.length} markets found, none had usable pricing)`);
      continue;
    }

    // Yes = over the strike, No = under, matching Kalshi's "Total Runs?" phrasing.
    // Price off the ASK — that's what you'd actually pay to enter the position.
    // Bid prices overstate the payout by the spread on every market, which
    // made every detected edge systematically optimistic. Falls back to the
    // bid only when no ask is posted (illiquid book).
    const askOrBid = (ask, bid) => parseFloat(ask) > 0 ? parseFloat(ask) : (parseFloat(bid) > 0 ? parseFloat(bid) : null);

    // The probability model evaluates EVERY strike for the game, so collect
    // all of them (with tickers, needed later for CLV close-price capture),
    // alongside the nearest-strike display summary the console/email use.
    const allStrikes = gameMarkets
      .filter(m => m.floor_strike != null)
      .map(m => ({
        strike: m.floor_strike,
        ticker: m.ticker,
        overCost: askOrBid(m.yes_ask_dollars, m.yes_bid_dollars),
        underCost: askOrBid(m.no_ask_dollars, m.no_bid_dollars),
      }))
      .filter(s => s.overCost != null && s.underCost != null);

    const overCost = askOrBid(best.yes_ask_dollars, best.yes_bid_dollars);
    const underCost = askOrBid(best.no_ask_dollars, best.no_bid_dollars);
    const overPrice = overCost != null ? 1 / overCost : null;
    const underPrice = underCost != null ? 1 / underCost : null;
    if (overPrice != null && underPrice != null) {
      priceMap.set(`${away}|${home}|${gameNumber || 1}`, { overPrice, underPrice, strike: best.floor_strike, strikes: allStrikes });
      appendDaemonLog(`[KALSHI-DEBUG] ${label} | oddsTotal=${total ?? 'NONE'} | matchAttempted=yes (abbrPair=${abbrPair}) | result=MATCHED strike=${best.floor_strike} over=${overPrice.toFixed(2)}x under=${underPrice.toFixed(2)}x strikes=${allStrikes.length}`);
    } else {
      appendDaemonLog(`[KALSHI-DEBUG] ${label} | oddsTotal=${total ?? 'NONE'} | matchAttempted=yes (abbrPair=${abbrPair}) | result=BAD_PRICE_DATA strike=${best.floor_strike} yes=${best.yes_bid_dollars} no=${best.no_bid_dollars}`);
    }
  }

  return priceMap;
}

// --- Display-only narrative helpers ---------------------------------------
// These re-derive plain-English explanations from the same raw inputs the
// decision model already used. They duplicate a few of the model's display
// thresholds (xERA/ERA bands, park factor cutoffs, OPS bands) purely for
// presentation — same pattern as fmtPitcher's FB/GB classification — and
// never touch scoring, signals, or the lean/confidence computed in analyzeGame.

function narrativeDepth(lean) {
  if (lean.includes('STRONG')) return 3;
  if (lean === 'OVER' || lean === 'UNDER') return 2;
  if (lean.includes('LEAN')) return 1;
  return 0;
}

function pitcherFact(awayStats, homeStats, awayPitcher, homePitcher, isOverLean) {
  const wantDir = isOverLean ? 'OVER' : 'UNDER';
  const candidates = [];
  for (const [side, name, stats] of [['Away', awayPitcher, awayStats], ['Home', homePitcher, homeStats]]) {
    if (!stats) continue;
    const usingXera = stats.xera != null;
    const qualityStat = usingXera ? stats.xera : stats.era;
    const qualityLabel = usingXera ? `${qualityStat.toFixed(2)} xERA (${stats.era.toFixed(2)} ERA)` : `${qualityStat.toFixed(2)} ERA`;
    let dir = null, rank = 0;
    if (qualityStat < 2.75) { dir = 'UNDER'; rank = 2; }
    else if (qualityStat < 3.50) { dir = 'UNDER'; rank = 1; }
    else if (qualityStat > 4.75) { dir = 'OVER'; rank = 2; }
    if (dir === wantDir) candidates.push({ side, name, qualityLabel, rank, dir });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank);
  const c = candidates[0];
  return c.dir === 'UNDER'
    ? `${c.side}'s ${c.name} has been excellent at ${c.qualityLabel}, keeping the lid on scoring.`
    : `${c.side}'s ${c.name} has been hittable at ${c.qualityLabel}, opening the door for more runs.`;
}

function parkFactorFact(stadiumNotes, venue, isOverLean) {
  const pf = stadiumNotes?.parkFactor;
  if (pf == null) return null;
  if (pf > 1.08 && isOverLean) return `${venue} is one of the more hitter-friendly parks in MLB (factor ${pf.toFixed(2)}).`;
  if (pf < 0.95 && !isOverLean) return `${venue} suppresses scoring as a pitcher's park (factor ${pf.toFixed(2)}).`;
  return null;
}

function windFact(weather, coords, stadiumNotes, venue, isOverLean) {
  if (!weather || !coords?.outDirs) return null;
  if (stadiumNotes?.windReliability !== 'HIGH') return null;
  const { maxWind, windDir } = weather;
  if (maxWind < 10) return null;
  const isOut = coords.outDirs.includes(windDir);
  const isCross = CROSSWIND_DIRS[venue]?.includes(windDir);
  const isIn = !isOut && !isCross;
  if (isOut && isOverLean) return `Wind is blowing out at ${maxWind}mph ${windDir}, giving the ball extra carry.`;
  if (isIn && !isOverLean) return `Wind is blowing in at ${maxWind}mph ${windDir}, knocking down fly balls.`;
  return null;
}

function opsFact(awayHitters, homeHitters, away, home, isOverLean) {
  const wantDir = isOverLean ? 'OVER' : 'UNDER';
  const dirOf = (ops) => ops == null ? null : ops > 0.780 ? 'OVER' : ops < 0.660 ? 'UNDER' : null;
  for (const [team, hitters] of [[away, awayHitters], [home, homeHitters]]) {
    if (!hitters) continue;
    const { recentOps, seasonOps } = hitters;
    const rd = dirOf(recentOps);
    const sd = dirOf(seasonOps);
    if (rd != null && rd === sd && rd === wantDir) {
      const verb = wantDir === 'OVER' ? 'hot' : 'cold';
      return `${team}'s lineup has been ${verb}, with a ${recentOps.toFixed(3)} OPS over the last 15 games and ${seasonOps.toFixed(3)} on the season.`;
    }
  }
  return null;
}

function marketSentence(kalshi, isOverLean) {
  if (!kalshi) return 'Market: No Kalshi market available.';
  const { overPrice, underPrice } = kalshi;
  const fmt = (p) => `${p.toFixed(2)}x`;
  if (overPrice === underPrice) {
    return `Market: Kalshi is split evenly on this total (Over ${fmt(overPrice)} / Under ${fmt(underPrice)}).`;
  }
  const kalshiFavorsOver = overPrice < underPrice;
  const kalshiAgrees = isOverLean ? kalshiFavorsOver : !kalshiFavorsOver;
  const kalshiSide = kalshiFavorsOver ? 'over' : 'under';
  return kalshiAgrees
    ? `Market: Kalshi also favors the ${kalshiSide} (Over ${fmt(overPrice)} / Under ${fmt(underPrice)}), agreeing with the bot's lean.`
    : `Market: Kalshi favors the ${kalshiSide} (Over ${fmt(overPrice)} / Under ${fmt(underPrice)}), conflicting with the bot's lean.`;
}

// Surfaces the strongest signal pointing the other way as the pick's main
// risk. Falls back to park-level wind unreliability, then confidence tier,
// then a generic caveat — always grounded in this game's real weighted
// signals, never a fabricated or generic-only claim.
function riskFactorFact(weighted, isOverLean, stadiumNotes, isDome, confidence) {
  const pickDir = isOverLean ? 'OVER' : 'UNDER';
  const opposing = (weighted || []).filter(w => w.direction !== pickDir).sort((a, b) => b.weight - a.weight);
  if (opposing.length) {
    return `Biggest risk: ${opposing[0].text}, a signal pointing the other way that could still flip this total.`;
  }
  if (!isDome && stadiumNotes?.windReliability && stadiumNotes.windReliability !== 'HIGH') {
    return `Biggest risk: wind at this park is ${stadiumNotes.windReliability.toLowerCase()}-reliability, so the forecast behind this call may not match what actually happens in-stadium.`;
  }
  if (confidence !== 'HIGH') {
    return `Biggest risk: confidence is only ${confidence}, meaning fewer signals lined up behind this call than an ideal setup.`;
  }
  return `Biggest risk: no clear counter-signal fired, but a single bad bullpen inning or late weather shift could still flip a total this close.`;
}

function printExplain({ away, home, venue, awayPitcher, homePitcher, awayStats, homeStats, awayBullpen, homeBullpen, awayHitters, homeHitters, weather, stadiumNotes, odds, kalshi, analysis, edge }) {
  const pf = stadiumNotes?.parkFactor;

  console.log(`\n================ EXPLAIN: ${away} @ ${home} ================`);
  console.log(`Venue: ${venue} | Park Factor: ${pf != null ? pf.toFixed(2) : 'N/A'}`);
  console.log(`Lean: ${analysis.lean} | Edge: ${edge.label} | Confidence: ${analysis.confidence}`);
  console.log(`Sportsbook consensus: O/U ${odds ? odds.total : 'N/A'}`);
  console.log(kalshi
    ? `Kalshi: Over ${kalshi.overPrice.toFixed(2)}x / Under ${kalshi.underPrice.toFixed(2)}x`
    : `Kalshi: No Kalshi market found.`);

  const pitcherLine = (side, name, stats) => {
    if (!stats) return `${side} pitcher: ${name} — no stats`;
    return stats.xera != null
      ? `${side} pitcher: ${name} — xERA ${stats.xera.toFixed(2)} (ERA ${stats.era.toFixed(2)})`
      : `${side} pitcher: ${name} — ERA ${stats.era.toFixed(2)} (no xERA available)`;
  };
  console.log(`\n${pitcherLine('Away', awayPitcher, awayStats)}`);
  console.log(pitcherLine('Home', homePitcher, homeStats));

  const bullpenLine = (side, bullpen) =>
    bullpen?.era != null ? `${side} bullpen ERA: ${bullpen.era.toFixed(2)}` : `${side} bullpen: no data`;
  console.log(`\n${bullpenLine('Away', awayBullpen)}`);
  console.log(bullpenLine('Home', homeBullpen));

  const opsLine = (side, hitters) => {
    if (!hitters) return `${side} lineup OPS: no data`;
    const r = hitters.recentOps != null ? hitters.recentOps.toFixed(3) : 'N/A';
    const s = hitters.seasonOps != null ? hitters.seasonOps.toFixed(3) : 'N/A';
    return `${side} lineup OPS — last 15: ${r}, season: ${s}`;
  };
  console.log(`\n${opsLine('Away', awayHitters)}`);
  console.log(opsLine('Home', homeHitters));

  console.log(weather
    ? `\nWind: ${weather.maxWind}mph ${weather.windDir} | Temp: ${weather.avgTemp}F | ${weather.condition}`
    : `\nWind: N/A (dome)`);

  console.log(`\nSignals that fired:`);
  if (!analysis.weighted || analysis.weighted.length === 0) {
    console.log('  (none)');
  } else {
    analysis.weighted.forEach(w => {
      console.log(`  [Tier ${w.tier}] ${w.text} (${w.direction}, weight ${w.weight})`);
    });
  }

  const count = (tier, direction) => (analysis.weighted || []).filter(w => w.tier === tier && w.direction === direction).length;
  console.log(`\nConfidence breakdown:`);
  console.log(`  Tier 1 — OVER: ${count(1, 'OVER')}, UNDER: ${count(1, 'UNDER')}`);
  console.log(`  Tier 2 — OVER: ${count(2, 'OVER')}, UNDER: ${count(2, 'UNDER')}`);
  console.log(`  → Confidence: ${analysis.confidence}`);

  console.log(`\n${edge.label} — ${edge.reason}`);
  console.log(`================================================================\n`);
}

async function getTodayGames(opts = {}) {
  const explain = !!opts.explain;
  const today = new Date().toISOString().split('T')[0];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,venue,team,lineups`;
  const [response, oddsMap] = await Promise.all([axios.get(url), getOdds()]);
  const games = response.data.dates[0]?.games || [];

  // Count matchups so doubleheaders can be labeled "(Game N)" — without the
  // suffix, game 2 collides with game 1 everywhere keyed by Date+Game name
  // (pick dedup silently drops it, final-score grading is ambiguous).
  const matchupCounts = {};
  for (const g of games) {
    const key = `${g.teams.away.team.name}|${g.teams.home.team.name}`;
    matchupCounts[key] = (matchupCounts[key] || 0) + 1;
  }
  const isDoubleheaderGame = (g) =>
    g.doubleHeader !== 'N' || matchupCounts[`${g.teams.away.team.name}|${g.teams.home.team.name}`] > 1;

  const kalshiPrices = await getKalshiMLBPrices(
    games.map(g => {
      const away = g.teams.away.team.name;
      const home = g.teams.home.team.name;
      return {
        away,
        home,
        awayAbbr: g.teams.away.team.abbreviation,
        homeAbbr: g.teams.home.team.abbreviation,
        total: oddsMap[`${away}|${home}`]?.total,
        gameNumber: g.gameNumber || 1,
        isDoubleheader: isDoubleheaderGame(g),
      };
    }),
    today
  );

  console.log(`\n============================`);
  console.log(explain ? ` MLB OVER/UNDER BOT — EXPLAIN MODE — ${today}` : ` MLB OVER/UNDER BOT — ${today}`);
  console.log(`============================\n`);

  const results = [];
  let explainCount = 0;
  let gamesWithOdds = 0;
  let gamesWithKalshi = 0;

  for (const game of games) {
    const home = game.teams.home.team.name;
    const away = game.teams.away.team.name;
    const homeId = game.teams.home.team.id;
    const awayId = game.teams.away.team.id;
    const venue = game.venue.name;
    const homePitcher = game.teams.home.probablePitcher?.fullName || 'TBD';
    const awayPitcher = game.teams.away.probablePitcher?.fullName || 'TBD';
    const homePitcherId = game.teams.home.probablePitcher?.id;
    const awayPitcherId = game.teams.away.probablePitcher?.id;
    const coords = STADIUMS[venue];
    const gameNumber = game.gameNumber || 1;
    const gameLabel = `${away} @ ${home}${isDoubleheaderGame(game) ? ` (Game ${gameNumber})` : ''}`;

    const weather = coords?.outDirs !== undefined && coords.outDirs !== null
      ? await getWeather(coords.lat, coords.lon, game.gameDate)
      : null;

    const awayLineupIds = (game.lineups?.awayPlayers || []).map(p => p.id).filter(Boolean);
    const homeLineupIds = (game.lineups?.homePlayers || []).map(p => p.id).filter(Boolean);

    const [awayStats, homeStats, awayHitters, homeHitters, awayBullpen, homeBullpen] = await Promise.all([
      getPitcherStats(awayPitcher, awayPitcherId),
      getPitcherStats(homePitcher, homePitcherId),
      getTeamHitters(awayId, awayLineupIds),
      getTeamHitters(homeId, homeLineupIds),
      getBullpenStats(awayId, awayPitcherId),
      getBullpenStats(homeId, homePitcherId),
    ]);

    const analysis = analyzeGame(weather, venue, awayStats, homeStats, awayHitters, homeHitters, awayBullpen, homeBullpen);

    const oddsKey = `${away}|${home}`;
    const odds = oddsMap[oddsKey];
    const kalshi = kalshiPrices.get(`${away}|${home}|${gameNumber}`);
    if (odds) gamesWithOdds++;
    if (kalshi) gamesWithKalshi++;
    appendDaemonLog(`[KALSHI-DEBUG] ${gameLabel} | oddsTotal=${odds ? odds.total : 'NONE'} | kalshiMatchFound=${kalshi ? 'yes' : 'no'}`);
    const stadiumNotes = STADIUM_NOTES[venue];
    const isDome = !coords?.outDirs;

    // The probability model is the decision-maker: project the total, price
    // P(over) for every Kalshi strike, and act only on a fee-adjusted edge.
    // The signal scorecard (analysis) is retained for narrative, the Signals
    // regression column, and the rain-out AVOID guard.
    const projection = analysis.lean === 'AVOID' ? null
      : projectGameTotal({ awayStats, homeStats, awayBullpen, homeBullpen, awayHitters, homeHitters, stadiumNotes, weather, coords, venue, isDome });
    const edge = analysis.lean === 'AVOID' ? null : detectProbEdge(projection, kalshi?.strikes);

    const isOverLean = edge?.side ? edge.side === 'OVER' : OVER_LEANS.includes(analysis.lean);

    if (edge && (edge.label === 'TARGET' || edge.label === 'PRIME TARGET')) {
      // Log the bet we'd actually place: the chosen strike as the line, and
      // juice derived from the fee-inclusive cost so recorded P&L nets fees.
      const chosen = (kalshi?.strikes || []).find(s => s.strike === edge.strike);
      const pickOdds = {
        total: edge.strike.toFixed(1),
        overJuice: chosen ? decimalToAmericanOdds(1 / (chosen.overCost + kalshiFee(chosen.overCost))) : null,
        underJuice: chosen ? decimalToAmericanOdds(1 / (chosen.underCost + kalshiFee(chosen.underCost))) : null,
      };
      const signalFact = pitcherFact(awayStats, homeStats, awayPitcher, homePitcher, isOverLean)
        || parkFactorFact(stadiumNotes, venue, isOverLean)
        || windFact(weather, coords, stadiumNotes, venue, isOverLean)
        || opsFact(awayHitters, homeHitters, away, home, isOverLean)
        || 'No single dominant signal — the call comes from the runs projection.';
      const marketFact = `Model projects ${projection.projectedTotal.toFixed(2)} runs — P(${edge.side} ${edge.strike}) = ${(edge.ourProb * 100).toFixed(1)}% vs market cost ${(edge.effectiveCost * 100).toFixed(1)}% including fees.`;
      const riskFact = riskFactorFact(analysis.weighted, isOverLean, stadiumNotes, isDome, analysis.confidence);
      logPick(today, gameLabel, analysis.lean, analysis.confidence, edge.label, pickOdds,
        { signalFact, marketFact, riskFact, signals: encodeSignals(analysis.weighted) },
        { side: edge.side, modelTotal: projection.projectedTotal, modelProb: edge.ourProb, entryCost: edge.cost, ticker: edge.ticker });
    }

    if (explain) {
      if (edge && (edge.label === 'TARGET' || edge.label === 'PRIME TARGET')) {
        printExplain({ away, home, venue, awayPitcher, homePitcher, awayStats, homeStats, awayBullpen, homeBullpen, awayHitters, homeHitters, weather, stadiumNotes, odds, kalshi, analysis, edge });
        explainCount++;
      }
      continue;
    }

    const pf = stadiumNotes?.parkFactor;
    const line1 = `${gameLabel} | ${venue} | Park Factor: ${pf != null ? pf.toFixed(2) : 'N/A'}`;
    let line2 = null;
    let sportsbookLine = null;
    let kalshiLine = null;
    let leaderboardSentence = null;

    console.log(line1);

    if (analysis.lean === 'AVOID') {
      console.log('Rain/storm risk — skip.');
    } else {
      const edgeLabelText = edge ? edge.label : 'No Edge';
      line2 = `${analysis.lean} | ${edgeLabelText}`;
      console.log(line2);

      sportsbookLine = odds
        ? `Sportsbook consensus: O/U ${odds.total}`
        : `Sportsbook consensus: No odds available.`;
      console.log(sportsbookLine);

      kalshiLine = kalshi
        ? `Kalshi: Over ${kalshi.overPrice.toFixed(2)}x / Under ${kalshi.underPrice.toFixed(2)}x`
        : `Kalshi: No Kalshi market found.`;
      console.log(kalshiLine);

      if (projection && edge?.ourProb != null) {
        console.log(`Model: ${projection.projectedTotal.toFixed(2)} projected runs | best value: ${edge.side} ${edge.strike} at ${(edge.ourProb * 100).toFixed(1)}% model vs ${(edge.effectiveCost * 100).toFixed(1)}% cost (edge ${(edge.edge * 100).toFixed(1)}%)`);
      } else if (projection) {
        console.log(`Model: ${projection.projectedTotal.toFixed(2)} projected runs`);
      }

      const depth = narrativeDepth(analysis.lean);
      if (depth > 0) {
        const facts = [
          pitcherFact(awayStats, homeStats, awayPitcher, homePitcher, isOverLean),
          parkFactorFact(stadiumNotes, venue, isOverLean),
          windFact(weather, coords, stadiumNotes, venue, isOverLean),
          opsFact(awayHitters, homeHitters, away, home, isOverLean),
        ].filter(Boolean);
        const sentences = facts.slice(0, depth);
        if (sentences.length) {
          console.log(sentences.join(' '));
          leaderboardSentence = sentences[0];
        }
        console.log(marketSentence(kalshi, isOverLean));
      }
    }

    console.log('---\n');

    results.push({ game: gameLabel, lean: analysis.lean, odds, kalshi, score: analysis.score, confidence: analysis.confidence, edge, line1, line2, sportsbookLine, kalshiLine, leaderboardSentence });
  }

  writeBotStatus({
    date: today,
    timestamp: new Date().toISOString(),
    gamesTotal: games.length,
    gamesWithOdds,
    gamesWithKalshi,
    kalshiAuthOk: verifyKalshiAuth(),
  });

  if (explain) {
    if (explainCount === 0) console.log('No TARGET or PRIME TARGET calls today.\n');
    console.log(`============================\n`);
    return;
  }

  // Leaderboard — TARGET and PRIME TARGET calls only
  const actionable = results
    .filter(r => r.edge && (r.edge.label === 'TARGET' || r.edge.label === 'PRIME TARGET'))
    .sort((a, b) => {
      const rank = (r) => (r.edge.label === 'PRIME TARGET' ? 1 : 0);
      if (rank(b) !== rank(a)) return rank(b) - rank(a);
      return (LEAN_RANK[b.lean] || 0) - (LEAN_RANK[a.lean] || 0);
    });

  console.log(`\n============================`);
  console.log(` TODAY\'S TOP CALLS`);
  console.log(`============================\n`);

  if (actionable.length === 0) {
    console.log('No TARGET or PRIME TARGET calls today.');
  } else {
    actionable.forEach((r) => {
      console.log(r.line1);
      console.log(r.line2);
      console.log(r.sportsbookLine);
      console.log(r.kalshiLine);
      if (r.leaderboardSentence) console.log(r.leaderboardSentence);
      console.log('');
    });
  }

  console.log(`(Showing TARGET and PRIME TARGET calls only)`);
  console.log(`============================\n`);
}

// --- Daemon scheduler -------------------------------------------------------
// `node index.js --daemon` keeps the process alive and triggers scheduled
// runs at fixed UTC times: full analysis at 11:00 and 17:00 UTC (7am/1pm ET),
// and --update-results at 04:00 UTC (midnight ET).

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const DAEMON_LOG_PATH = path.join(LOGS_DIR, 'daemon.log');

// Pushes picks_log.csv after the daemon's update-results run using the GitHub
// Contents API, so it works even when git isn't available (e.g. Railway container).
// Reads the current SHA, base64-encodes the file, and PUTs via GitHub API with
// GITHUB_TOKEN. Failures are swallowed so they never take the daemon down.
//
// CRITICAL: skips the PUT when local content is byte-identical to what's
// already on GitHub. Every push to main triggers a Railway redeploy, and a
// redeploy rebuilds the container filesystem from the repo — wiping
// scheduler_state.json (gitignored) so the catch-up scheduler refires
// update-results, which called this function, which pushed a no-op commit,
// which triggered another redeploy... an infinite deploy loop that produced
// 350+ empty "auto: update picks log" commits in a single day. Comparing the
// git blob SHA of local content against the remote SHA breaks that cycle:
// a refire with unchanged content pushes nothing, so no redeploy follows.
async function autoPushPicksLog() {
  const dateStr = new Date().toISOString().split('T')[0];
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN not set — skipping auto-push');
    return;
  }

  try {
    // Read the current file from the repo to get the SHA.
    const getRes = await fetch(
      'https://api.github.com/repos/joeygir/mlb-polymarket-bot/contents/picks_log.csv',
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } }
    );

    if (!getRes.ok) {
      console.error(`Failed to fetch current SHA: ${getRes.status}`);
      return;
    }

    const { sha } = await getRes.json();

    // Read the local file and base64-encode it.
    const content = fs.readFileSync(PICKS_LOG, 'utf8');

    // Git blob SHA = sha1("blob <byteLength>\0<content>"). If it matches the
    // remote file's SHA, the content is identical — push nothing.
    const localBlobSha = crypto.createHash('sha1')
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest('hex');
    if (localBlobSha === sha) {
      console.log('picks_log.csv unchanged from GitHub — skipping auto-push (no redeploy triggered)');
      return;
    }

    const encoded = Buffer.from(content).toString('base64');

    // Push the updated file via GitHub Contents API.
    const putRes = await fetch(
      'https://api.github.com/repos/joeygir/mlb-polymarket-bot/contents/picks_log.csv',
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `auto: update picks log [${dateStr}]`,
          content: encoded,
          sha,
        }),
      }
    );

    if (!putRes.ok) {
      console.error(`Failed to push to GitHub: ${putRes.status}`);
      return;
    }

    console.log('Auto-committed and pushed picks_log.csv via GitHub API');
  } catch (err) {
    console.error('Auto-push failed:', err.message);
  }
}

// Returns the schedule for the given day (0=Sunday, 6=Saturday).
// Weekdays: 16:00 UTC (noon ET), 23:00 UTC (7pm ET), 04:00 UTC (midnight ET)
// Saturdays: 15:00 UTC (11am ET), 18:00 UTC (2pm ET), 04:00 UTC (midnight ET)
// Sundays: 14:00 UTC (10am ET), 15:30 UTC (11:30am ET), 04:00 UTC (midnight ET)
function getScheduleForDay(dayOfWeek) {
  const updateTask = async () => { await updateResults(); await autoPushPicksLog(); };
  const analysisWithEmail = async () => { await getTodayGames(); await sendEmailReport(); };

  if (dayOfWeek === 0) {
    // Sunday
    return [
      { hour: 14, minute: 0, name: 'morning-analysis', task: analysisWithEmail },
      { hour: 15, minute: 30, name: 'pregame-analysis', task: analysisWithEmail },
      { hour: 4, minute: 0, name: 'update-results', task: updateTask },
    ];
  } else if (dayOfWeek === 6) {
    // Saturday
    return [
      { hour: 15, minute: 0, name: 'morning-analysis', task: analysisWithEmail },
      { hour: 18, minute: 0, name: 'pregame-analysis', task: analysisWithEmail },
      { hour: 4, minute: 0, name: 'update-results', task: updateTask },
    ];
  } else {
    // Weekday (Monday-Friday)
    return [
      { hour: 16, minute: 0, name: 'morning-analysis', task: analysisWithEmail },
      { hour: 23, minute: 0, name: 'pregame-analysis', task: analysisWithEmail },
      { hour: 4, minute: 0, name: 'update-results', task: updateTask },
    ];
  }
}

function getDayName(dayOfWeek) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];
}

// Getaway-day slates (early businessman's-special starts, common on travel
// days) can be well underway or even over before the fixed morning-analysis
// time — e.g. a 12:35pm ET first pitch is already past the 16:00 UTC/noon ET
// weekday run, and the 23:00 UTC/7pm ET pregame run happens after the game
// has ended, so it never gets a properly-timed pass either way. This looks
// up the day's actual earliest first pitch and, if it's earlier than the
// scheduled morning-analysis time can front-run with a reasonable buffer,
// moves that run earlier so it still catches the game with real odds/Kalshi
// data available. Never pushes the run later than its normal fixed time.
const EARLY_PITCH_LEAD_MINUTES = 90;
const EARLY_PITCH_FLOOR_UTC_MINUTES = 9 * 60; // never earlier than 09:00 UTC (05:00 ET)

let earliestPitchCache = null; // { date: 'YYYY-MM-DD', earliestUTCMinutes: number|null }

async function getEarliestFirstPitchUTCMinutes(dateStr) {
  if (earliestPitchCache?.date === dateStr) return earliestPitchCache.earliestUTCMinutes;

  let earliestUTCMinutes = null;
  try {
    const res = await axios.get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}`);
    const games = res.data.dates[0]?.games || [];
    const dateStartMs = new Date(`${dateStr}T00:00:00Z`).getTime();
    for (const g of games) {
      // Minutes since the start of dateStr's UTC day, not hour-of-day — an ET
      // evening game (e.g. 8:05pm ET) lands on the *next* UTC calendar day
      // and must not wrap back around to look like an early-morning start.
      const minutes = Math.round((new Date(g.gameDate).getTime() - dateStartMs) / 60000);
      if (earliestUTCMinutes == null || minutes < earliestUTCMinutes) earliestUTCMinutes = minutes;
    }
  } catch {
    earliestUTCMinutes = null;
  }

  earliestPitchCache = { date: dateStr, earliestUTCMinutes };
  return earliestUTCMinutes;
}

async function applyGetawayDayAdjustment(schedule, dateStr) {
  const earliestUTCMinutes = await getEarliestFirstPitchUTCMinutes(dateStr);
  if (earliestUTCMinutes == null) return schedule;

  const desiredMinutes = Math.max(earliestUTCMinutes - EARLY_PITCH_LEAD_MINUTES, EARLY_PITCH_FLOOR_UTC_MINUTES);

  return schedule.map(entry => {
    if (entry.name !== 'morning-analysis') return entry;
    const entryMinutes = entry.hour * 60 + entry.minute;
    if (desiredMinutes >= entryMinutes) return entry;
    return { ...entry, hour: Math.floor(desiredMinutes / 60), minute: desiredMinutes % 60 };
  });
}

function appendDaemonLog(message) {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFileSync(DAEMON_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
}

// Runs a scheduled task, capturing everything it would normally print to the
// console into its own timestamped file under logs/, while still printing to
// the console as usual. Also records start/completion/failure in daemon.log.
async function runScheduledTask(name, task) {
  const timestamp = new Date().toISOString();
  const runLogPath = path.join(LOGS_DIR, `${timestamp.replace(/[:.]/g, '-')}-${name}.log`);
  const captured = [];

  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...a) => { captured.push(a.join(' ')); originalLog(...a); };
  console.error = (...a) => { captured.push('[ERROR] ' + a.join(' ')); originalError(...a); };

  appendDaemonLog(`Starting ${name}`);
  try {
    await task();
    appendDaemonLog(`Completed ${name}`);
  } catch (err) {
    captured.push(`[ERROR] ${err.message}`);
    appendDaemonLog(`FAILED ${name}: ${err.message}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.writeFileSync(runLogPath, captured.join('\n') + '\n');
  }
}

function runDaemon() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

  console.log(`\n${PAPER_TRADING_NOTICE}\n`);
  appendDaemonLog(PAPER_TRADING_NOTICE);

  const kalshiAuthOk = verifyKalshiAuth();
  appendDaemonLog(kalshiAuthOk ? 'Kalshi auth: OK' : 'Kalshi auth: FAILED - check KALSHI_PRIVATE_KEY env var');

  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const dayName = getDayName(dayOfWeek);
  const schedule = getScheduleForDay(dayOfWeek);

  const scheduleTimes = schedule.map(s => `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`).join(', ');
  appendDaemonLog(`Daemon started (${dayName}) — schedule: ${scheduleTimes} UTC`);
  console.log(`Daemon started (${dayName}). Checking schedule every 60s — ${scheduleTimes} UTC.`);

  // Tracks which task-keys ("date-taskname") have already fired, reset
  // whenever the UTC date rolls over. Using "has this passed and not yet
  // fired today" instead of an exact hour===X && minute===Y match means a
  // container that starts late (crash-restart, redeploy, cold start) still
  // catches up on any task whose time already passed today instead of
  // silently skipping it until tomorrow — an exact-minute match only ever
  // gets one chance per day and permanently misses it if the process isn't
  // alive at that precise minute.
  //
  // Persisted to disk (not just in-memory) because a crash-restart loop
  // would otherwise forget it already caught up today on every single
  // restart, re-firing update-results (and its GitHub auto-push) every
  // time the process comes back up — exactly what happened in production:
  // 170+ auto-commits in one day once the in-memory-only version of this
  // logic shipped.
  let triggeredKeys = new Set();
  let lastCheckedDate = null;
  let lastLoggedAdjustmentDate = null;

  setInterval(() => {
    (async () => {
      const now = new Date();
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();
      const dayOfWeek = now.getUTCDay();
      const dateStr = now.toISOString().split('T')[0];

      if (dateStr !== lastCheckedDate) {
        triggeredKeys = loadSchedulerState(dateStr);
        lastCheckedDate = dateStr;
      }

      const baseSchedule = getScheduleForDay(dayOfWeek);
      const schedule = await applyGetawayDayAdjustment(baseSchedule, dateStr);

      if (lastLoggedAdjustmentDate !== dateStr) {
        const base = baseSchedule.find(s => s.name === 'morning-analysis');
        const adjusted = schedule.find(s => s.name === 'morning-analysis');
        if (base && adjusted && (base.hour !== adjusted.hour || base.minute !== adjusted.minute)) {
          appendDaemonLog(`Getaway-day adjustment: morning-analysis moved from ${String(base.hour).padStart(2, '0')}:${String(base.minute).padStart(2, '0')} to ${String(adjusted.hour).padStart(2, '0')}:${String(adjusted.minute).padStart(2, '0')} UTC (early first pitch detected)`);
        }
        lastLoggedAdjustmentDate = dateStr;
      }

      const nowMinutes = hour * 60 + minute;
      for (const s of schedule) {
        const key = `${dateStr}-${s.name}`;
        if (triggeredKeys.has(key)) continue;
        const scheduledMinutes = s.hour * 60 + s.minute;
        if (nowMinutes < scheduledMinutes) continue;

        triggeredKeys.add(key);
        saveSchedulerState(dateStr, triggeredKeys);
        if (nowMinutes > scheduledMinutes) {
          appendDaemonLog(`Catch-up trigger: ${s.name} scheduled for ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} UTC, running now at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (process wasn't running at the scheduled time)`);
        }
        // Await so multiple due tasks (e.g. a catch-up firing update-results
        // AND morning-analysis in one tick) run sequentially — both do
        // read-modify-write on picks_log.csv and both patch console.log in
        // runScheduledTask, so running them concurrently risks CSV corruption
        // and nested console-patching restoring the wrong logger.
        await runScheduledTask(s.name, s.task);
      }
    })().catch(err => appendDaemonLog(`Scheduler tick failed: ${err.message}`));
  }, 60000);
}

const args = process.argv.slice(2);
if (args.includes('--daemon')) {
  runDaemon();
} else if (args.includes('--update-results')) {
  updateResults().then(() => process.exit(0));
} else if (args.includes('--summary')) {
  printSummary();
} else if (args.includes('--send-test-email')) {
  testEmailReport().then(() => process.exit(0));
} else if (args.includes('--send-email')) {
  sendEmailReport().then(() => process.exit(0));
} else if (args.includes('--stake')) {
  const i = args.indexOf('--stake');
  const [game, amount, date] = args.slice(i + 1);
  setStake(game, amount, date);
} else if (args.includes('--explain')) {
  getTodayGames({ explain: true });
} else {
  getTodayGames();
}