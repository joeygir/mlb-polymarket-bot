require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PICKS_LOG = path.join(__dirname, 'picks_log.csv');
const CSV_HEADERS = ['Date','Game','Lean','Confidence','Edge_Label','Total_Line','Side','Side_Juice','Stake','Result','Hit_Miss','PnL'];

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

function logPick(date, game, lean, confidence, edgeLabel, odds) {
  const isOver = OVER_LEANS.includes(lean);
  const side = isOver ? 'OVER' : 'UNDER';
  const sideJuice = isOver ? odds.overJuice : odds.underJuice;
  const newRow = { Date: date, Game: game, Lean: lean, Confidence: confidence, Edge_Label: edgeLabel, Total_Line: odds.total, Side: side, Side_Juice: sideJuice, Stake: '', Result: '', Hit_Miss: '', PnL: '' };

  if (!fs.existsSync(PICKS_LOG)) {
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rowToCSV(newRow, CSV_HEADERS) + '\n');
    return;
  }

  const { headers, rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));

  if (rows.some(r => r.Date === date && r.Game === game)) return;

  const hasSide = headers.includes('Side');
  const hasConfidence = headers.includes('Confidence');

  if (!hasSide || !hasConfidence) {
    const migrated = rows.map(r => ({
      ...r,
      Side: hasSide ? r.Side : (OVER_LEANS.includes(r.Lean) ? 'OVER' : 'UNDER'),
      Confidence: hasConfidence ? r.Confidence : '',
    }));
    migrated.push(newRow);
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + migrated.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
  } else {
    fs.appendFileSync(PICKS_LOG, rowToCSV(newRow, CSV_HEADERS) + '\n');
  }
}

function calcPnL(hitMiss, sideJuice, stake) {
  if (hitMiss === 'PUSH') return 0;
  const juice = parseInt(sideJuice);
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
    const scoreMap = {};
    for (const g of games) {
      if (g.status.abstractGameState !== 'Final') continue;
      const key = `${g.teams.away.team.name} @ ${g.teams.home.team.name}`;
      const awayRuns = g.teams.away.score;
      const homeRuns = g.teams.home.score;
      if (awayRuns != null && homeRuns != null) scoreMap[key] = awayRuns + homeRuns;
    }
    return scoreMap;
  } catch {
    return {};
  }
}

async function updateResults() {
  if (!fs.existsSync(PICKS_LOG)) { console.log('picks_log.csv not found.'); return; }

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const pending = rows.filter(r => !r.Result);
  if (pending.length === 0) { console.log('No pending results to update.'); return; }

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

  if (updated > 0) {
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rows.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
    console.log(`\nUpdated ${updated} row(s) in picks_log.csv`);
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
  console.log(`Total picks logged : ${rows.length}`);
  console.log(`Resolved picks     : ${total}`);
  console.log(`Overall hit rate   : ${hits}/${total} (${total > 0 ? (hits/total*100).toFixed(1) : '0.0'}%)`);
  console.log(`Total P&L          : ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`);

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
  console.log(`\nCurrent streak     : ${streakCount > 0 ? `${streakCount} ${streakType}${streakCount > 1 ? 'S' : ''}` : 'None'}`);
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
  'Coors Field':                    { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 2, roofRetractable: false, parkFactor: 1.30, notes: 'Altitude (5,200ft) is the dominant scoring factor — wind is secondary.' },
  'T-Mobile Park':                  { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: true,  parkFactor: 0.95, notes: 'Retractable roof affects in-stadium wind even when open — verify roof status before betting.' },
  'Comerica Park':                  { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.97, notes: 'Open outfield design — wind tracks forecast closely.' },
  'PNC Park':                       { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.04, notes: 'River-side open design — wind tracks forecast closely.' },
  'Busch Stadium':                  { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.00, notes: 'Open bowl — wind generally matches forecast.' },
  'Truist Park':                    { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.02, notes: 'Open concourse design — wind tracks forecast closely.' },
  'Great American Ball Park':       { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.12, notes: 'River-side open park — wind tracks forecast closely.' },
  'Guaranteed Rate Field':          { windReliability: 'HIGH',   weatherWeight: 1.0, altitudeBoost: 0, roofRetractable: false, parkFactor: 0.99, notes: 'Open design — wind generally matches forecast.' },
  'Camden Yards':                   { windReliability: 'MEDIUM', weatherWeight: 0.6, altitudeBoost: 0, roofRetractable: false, parkFactor: 1.07, notes: 'Warehouse beyond right field can create swirl that forecast wind direction misses.' },
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

function computeConfidence(weightedSignals) {
  const count = (tier, direction) => weightedSignals.filter(w => w.tier === tier && w.direction === direction).length;
  const tier1Max = Math.max(count(1, 'OVER'), count(1, 'UNDER'));
  const tier2Max = Math.max(count(2, 'OVER'), count(2, 'UNDER'));

  if (tier1Max >= 2) return 'HIGH';
  if (tier1Max >= 1 || tier2Max >= 3) return 'MEDIUM';
  return 'LOW';
}

async function getPitcherStats(pitcherName) {
  try {
    const search = await axios.get(
      `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(pitcherName)}`
    );
    const player = search.data.people?.[0];
    if (!player) return null;

    const stats = await axios.get(
      `https://statsapi.mlb.com/api/v1/people/${player.id}/stats?stats=season&season=2026&group=pitching`
    );

    const splits = stats.data.stats?.[0]?.splits?.[0]?.stat;
    if (!splits) return null;

    const xera = await getXERA(player.id);

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
    if (!savantXeraTable || savantXeraTable.year !== year) {
      const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=asc&min=1&selections=p_game,p_formatted_ip,p_era,xera&chart=false&x=p_era&y=xera&r=no&toggledStat=&csv=true`;
      const res = await axios.get(url);
      savantXeraTable = { year, rows: parseSavantCSV(res.data) };
    }
    const row = savantXeraTable.rows.find(r => r.player_id === String(playerId));
    return row?.xera ? parseFloat(row.xera) : null;
  } catch {
    return null;
  }
}

async function getTeamHitters(teamId) {
  try {
    const roster = await axios.get(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`
    );
    const batters = roster.data.roster.filter(p => p.position.code !== '1');

    const statsPromises = batters.slice(0, 9).map(async (player) => {
      try {
        const [recentRes, seasonRes] = await Promise.all([
          axios.get(`https://statsapi.mlb.com/api/v1/people/${player.person.id}/stats?stats=lastXGames&season=2026&group=hitting&limit=15`),
          axios.get(`https://statsapi.mlb.com/api/v1/people/${player.person.id}/stats?stats=season&season=2026&group=hitting`),
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

const bullpenCache = new Map();

async function getBullpenStats(teamId, starterPlayerId) {
  if (bullpenCache.has(teamId)) return bullpenCache.get(teamId);

  let result = { era: null, whip: null };
  try {
    const rosterRes = await axios.get(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`);
    const relievers = rosterRes.data.roster.filter(p => p.position.code === '1' && p.person.id !== starterPlayerId);

    const statLines = await Promise.all(relievers.map(p =>
      axios.get(`https://statsapi.mlb.com/api/v1/people/${p.person.id}/stats?stats=season&season=${new Date().getFullYear()}&group=pitching`)
        .then(res => res.data.stats?.[0]?.splits?.[0]?.stat)
        .catch(() => null)
    ));

    const qualified = statLines.filter(s => s && parseFloat(s.inningsPitched) >= 5);
    const era = qualified.length ? qualified.reduce((sum, s) => sum + parseFloat(s.era), 0) / qualified.length : null;
    const whip = qualified.length ? qualified.reduce((sum, s) => sum + parseFloat(s.whip), 0) / qualified.length : null;

    result = { era, whip };
  } catch {
    // keep defaults
  }

  bullpenCache.set(teamId, result);
  return result;
}

function scoreBullpen(awayBullpen, homeBullpen) {
  const signals = [];
  const weighted = [];
  let overScore = 0;
  let underScore = 0;

  const add = (text, direction, tier) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight });
    if (direction === 'OVER') overScore += weight; else underScore += weight;
  };

  // Bullpen ERA quality only — no fatigue/workload component, at most one signal per team.
  for (const [side, bullpen] of [['Away', awayBullpen], ['Home', homeBullpen]]) {
    if (!bullpen || bullpen.era == null) continue;

    if (bullpen.era >= 4.50) {
      add(`${side} poor bullpen quality — late innings vulnerable`, 'OVER', 2);
    } else if (bullpen.era < 3.20) {
      add(`${side} elite bullpen quality`, 'UNDER', 2);
    }
  }

  return { overScore, underScore, signals, weighted };
}

async function getWeather(lat, lon) {
  try {
    const pointRes = await axios.get(`https://api.weather.gov/points/${lat},${lon}`);
    const forecastUrl = pointRes.data.properties.forecastHourly;
    const forecastRes = await axios.get(forecastUrl);
    const periods = forecastRes.data.properties.periods;
    const window = periods.slice(0, 6);

    const temps = window.map(p => p.temperature);
    const winds = window.map(p => parseInt(p.windSpeed));

    return {
      avgTemp: Math.round(temps.reduce((a, b) => a + b) / temps.length),
      maxWind: Math.max(...winds),
      windDir: window[0].windDirection,
      condition: window[0].shortForecast,
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

  const add = (text, direction, tier) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight });
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
      add(`${side} pitcher ${qualityLabel} — elite, suppresses scoring`, 'UNDER', 1);
    } else if (isSolid) {
      add(`${side} pitcher ${qualityLabel} — solid, mild under lean`, 'UNDER', 1);
    } else if (isHittable) {
      add(`${side} pitcher ${qualityLabel} — hittable, over lean`, 'OVER', 1);
    }

    // Tier 2 — ERA-xERA gap is a luck/regression indicator.
    if (usingXera) {
      const gap = stats.era - stats.xera;
      if (gap < -1.0) {
        add(`${side} ERA-xERA gap — pitcher has been lucky, regression risk`, 'OVER', 2);
      } else if (gap > 1.0) {
        add(`${side} ERA-xERA gap — pitcher has been unlucky, expect improvement`, 'UNDER', 2);
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

  const add = (text, direction, tier) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight });
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
    add(`${label} lineup ${verb} — recent OPS ${recentOps.toFixed(3)} and season OPS ${seasonOps.toFixed(3)} agree`, recentDir, 2);
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

  const add = (text, direction, tier) => {
    signals.push(text);
    const weight = TIER_WEIGHTS[tier];
    weighted.push({ text, direction, tier, weight });
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
      add(`Hitter-friendly park (factor ${pf.toFixed(2)})`, 'OVER', 1);
    } else if (pf < 0.95) {
      add(`Pitcher-friendly park (factor ${pf.toFixed(2)})`, 'UNDER', 1);
    } else {
      signals.push(`Park factor: ${pf.toFixed(2)}`);
    }
  }

  if (isDome) {
    signals.push('Weather irrelevant — dome');
  } else {
    const { avgTemp, maxWind, windDir, condition } = weather;

    const isOut = stadium.outDirs.includes(windDir);
    const isCross = CROSSWIND_DIRS[venue]?.includes(windDir);
    const isIn = !isOut && !isCross;

    // Wind direction only scores at HIGH-reliability parks (Tier 1) — MEDIUM and LOW
    // parks get the same display text but contribute zero scoring signal, no exceptions.
    const isHighWindPark = stadiumNotes?.windReliability === 'HIGH';

    if (maxWind >= 15 && isOut) {
      const text = `Wind OUT at ${maxWind}mph ${windDir} — ball carries, HR risk up`;
      if (isHighWindPark) add(text, 'OVER', 1); else signals.push(text);
    } else if (maxWind >= 10 && isOut) {
      const text = `Wind OUT at ${maxWind}mph ${windDir} — mild carry boost`;
      if (isHighWindPark) add(text, 'OVER', 1); else signals.push(text);
    } else if (maxWind >= 15 && isIn) {
      const text = `Wind IN at ${maxWind}mph ${windDir} — fly balls die, pitchers favored`;
      if (isHighWindPark) add(text, 'UNDER', 1); else signals.push(text);
    } else if (maxWind >= 10 && isIn) {
      const text = `Wind IN at ${maxWind}mph ${windDir} — mild suppression`;
      if (isHighWindPark) add(text, 'UNDER', 1); else signals.push(text);
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

    // Tier 1 — park factor / altitude environment.
    if (stadiumNotes?.altitudeBoost) {
      add(`Altitude effect at ${venue} — +${stadiumNotes.altitudeBoost} OVER boost regardless of wind direction`, 'OVER', 1);
    }

    // Tier 2 — temperature extremes only (90F+ / 50F-); mild warm/cool bands display only.
    if (avgTemp >= 90) {
      add(`Very hot (${avgTemp}F) — ball carries significantly`, 'OVER', 2);
    } else if (avgTemp >= 80) {
      signals.push(`Warm (${avgTemp}F) — slight carry boost`);
    } else if (avgTemp <= 50) {
      add(`Cold (${avgTemp}F) — ball suppressed noticeably`, 'UNDER', 2);
    } else if (avgTemp <= 60) {
      signals.push(`Cool (${avgTemp}F) — mild suppression`);
    } else {
      signals.push(`Neutral temp (${avgTemp}F)`);
    }

    const rainKeywords = ['rain', 'shower', 'storm', 'thunderstorm', 'drizzle'];
    if (rainKeywords.some(k => condition.toLowerCase().includes(k))) {
      signals.push(`${condition} — postponement risk, avoid or wait`);
      return { lean: 'AVOID', signals, score: 0, confidence: 'N/A' };
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
// Edge detection runs entirely on Kalshi decimal prices — that's where bets
// are actually placed. The Odds API no longer feeds this function at all; it
// only supplies the total-line number used elsewhere to pick the closest
// Kalshi strike. Price thresholds below are the decimal-odds equivalents of
// the old American-juice thresholds (-130 ≈ 1.77x, -115 ≈ 1.87x, -108 ≈ 1.93x).
function detectEdge(lean, kalshi, venue) {
  if (lean === 'AVOID' || lean === 'NEUTRAL' || lean === 'DOME — NEUTRAL') {
    return null;
  }

  if (!kalshi) {
    return { label: 'No Kalshi market', reason: 'No Kalshi market found — skipping edge scoring.' };
  }

  const isOverLean = ['STRONG OVER', 'OVER', 'LEAN OVER', 'DOME — LEAN OVER'].includes(lean);
  const isUnderLean = ['STRONG UNDER', 'UNDER', 'LEAN UNDER', 'DOME — LEAN UNDER'].includes(lean);
  const isStrong = ['STRONG OVER', 'STRONG UNDER'].includes(lean);
  const isMedium = ['OVER', 'UNDER', 'LEAN OVER', 'LEAN UNDER'].includes(lean);

  const { overPrice, underPrice } = kalshi;
  const fmt = (p) => `${p.toFixed(2)}x`;

  const kalshiFavorsOver = overPrice < underPrice;
  const kalshiFavorsUnder = underPrice < overPrice;

  const relevantPrice = isOverLean ? overPrice : underPrice;
  const kalshiAgrees = (isOverLean && kalshiFavorsOver) || (isUnderLean && kalshiFavorsUnder);
  const kalshiDisagrees = (isOverLean && kalshiFavorsUnder) || (isUnderLean && kalshiFavorsOver);

  const priceTooExpensive = relevantPrice < 1.77;
  const priceFair = relevantPrice >= 1.87;
  const priceNearEven = relevantPrice >= 1.93;

  if (priceTooExpensive) {
    return { label: 'PASS', reason: `Kalshi already priced this — too expensive (${fmt(overPrice)}/${fmt(underPrice)})` };
  }

  if (kalshiDisagrees && isStrong) {
    if (STADIUM_NOTES[venue]?.windReliability === 'LOW') {
      return { label: 'TARGET', reason: `Downgraded from PRIME TARGET — wind data unreliable at this park (${STADIUM_NOTES[venue].notes}) — maximum gap (${fmt(overPrice)}/${fmt(underPrice)})` };
    }
    return { label: 'PRIME TARGET', reason: `Bot strongly disagrees with Kalshi pricing — maximum gap (${fmt(overPrice)}/${fmt(underPrice)})` };
  }

  if (kalshiDisagrees && isMedium) {
    return { label: 'TARGET', reason: `Bot leans against Kalshi pricing — gap exists (${fmt(overPrice)}/${fmt(underPrice)})` };
  }

  if (kalshiAgrees && priceNearEven && isStrong) {
    return { label: 'SHARP', reason: `Kalshi agrees but price still fair — strong signal at good price (${fmt(overPrice)}/${fmt(underPrice)})` };
  }

  if (kalshiAgrees && priceFair) {
    return { label: 'CONSIDER', reason: `Kalshi agrees, price acceptable (${fmt(overPrice)}/${fmt(underPrice)})` };
  }

  return { label: 'PASS', reason: `Kalshi agrees but price not favorable enough (${fmt(overPrice)}/${fmt(underPrice)})` };
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
        const avgTotal = lines.reduce((a, b) => a + b.point, 0) / lines.length;
        const avgOver = lines.reduce((a, b) => a + b.overPrice, 0) / lines.length;
        const avgUnder = lines.reduce((a, b) => a + b.underPrice, 0) / lines.length;
        const fmt = p => p > 0 ? `+${Math.round(p)}` : `${Math.round(p)}`;
        oddsMap[key] = {
          display: `O/U ${avgTotal.toFixed(1)} | Over ${fmt(avgOver)} / Under ${fmt(avgUnder)} (avg of ${lines.length} books)`,
          total: avgTotal.toFixed(1),
          overJuice: fmt(avgOver),
          underJuice: fmt(avgUnder),
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
// The strike closest to the sportsbook's posted total is then selected for an
// apples-to-apples comparison. Games with no sportsbook total to anchor against
// are skipped. Returns an empty map on any failure or when nothing matches —
// callers fall back to sportsbook odds in that case.
async function getKalshiMLBPrices(games, today) {
  const priceMap = new Map();
  const todayToken = kalshiDateToken(today);

  let markets;
  try {
    const data = await kalshiGet(`${KALSHI_PATH_PREFIX}/markets`, { status: 'open', limit: 1000, series_ticker: 'KXMLBTOTAL' });
    markets = data?.markets || [];
  } catch {
    return priceMap;
  }

  for (const { away, home, awayAbbr, homeAbbr, total } of games) {
    if (total == null || !awayAbbr || !homeAbbr) continue;

    const abbrPair = `${awayAbbr}${homeAbbr}`;
    const gameMarkets = markets.filter(m =>
      (m.event_ticker || '').includes(abbrPair) && kalshiTickerDateToken(m.event_ticker) === todayToken
    );
    if (!gameMarkets.length) continue;

    const targetTotal = parseFloat(total);
    let best = null;
    let bestDiff = Infinity;
    for (const m of gameMarkets) {
      if (m.floor_strike == null) continue;
      const diff = Math.abs(m.floor_strike - targetTotal);
      if (diff < bestDiff) { bestDiff = diff; best = m; }
    }
    if (!best) continue;

    // Yes = over the strike, No = under, matching Kalshi's "Total Runs?" phrasing.
    const overPrice = kalshiDollarsToDecimal(best.yes_bid_dollars);
    const underPrice = kalshiDollarsToDecimal(best.no_bid_dollars);
    if (overPrice != null && underPrice != null) {
      priceMap.set(`${away}|${home}`, { overPrice, underPrice });
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
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,venue,team`;
  const [response, oddsMap] = await Promise.all([axios.get(url), getOdds()]);
  const games = response.data.dates[0]?.games || [];
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
      };
    }),
    today
  );

  console.log(`\n============================`);
  console.log(explain ? ` MLB OVER/UNDER BOT — EXPLAIN MODE — ${today}` : ` MLB OVER/UNDER BOT — ${today}`);
  console.log(`============================\n`);

  const results = [];
  let explainCount = 0;

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

    const weather = coords?.outDirs !== undefined && coords.outDirs !== null
      ? await getWeather(coords.lat, coords.lon)
      : null;

    const [awayStats, homeStats, awayHitters, homeHitters, awayBullpen, homeBullpen] = await Promise.all([
      getPitcherStats(awayPitcher),
      getPitcherStats(homePitcher),
      getTeamHitters(awayId),
      getTeamHitters(homeId),
      getBullpenStats(awayId, awayPitcherId),
      getBullpenStats(homeId, homePitcherId),
    ]);

    const analysis = analyzeGame(weather, venue, awayStats, homeStats, awayHitters, homeHitters, awayBullpen, homeBullpen);

    const oddsKey = `${away}|${home}`;
    const odds = oddsMap[oddsKey];
    const kalshi = kalshiPrices.get(oddsKey);
    const stadiumNotes = STADIUM_NOTES[venue];
    const isOverLean = OVER_LEANS.includes(analysis.lean);
    const edge = detectEdge(analysis.lean, kalshi, venue);

    const isHighConfEdge = analysis.confidence === 'MEDIUM' || analysis.confidence === 'HIGH';
    if (edge && (edge.label === 'TARGET' || edge.label === 'PRIME TARGET') && odds && isHighConfEdge) {
      logPick(today, `${away} @ ${home}`, analysis.lean, analysis.confidence, edge.label, odds);
    }

    if (explain) {
      if (edge && (edge.label === 'TARGET' || edge.label === 'PRIME TARGET')) {
        printExplain({ away, home, venue, awayPitcher, homePitcher, awayStats, homeStats, awayBullpen, homeBullpen, awayHitters, homeHitters, weather, stadiumNotes, odds, kalshi, analysis, edge });
        explainCount++;
      }
      continue;
    }

    const pf = stadiumNotes?.parkFactor;
    const line1 = `${away} @ ${home} | ${venue} | Park Factor: ${pf != null ? pf.toFixed(2) : 'N/A'}`;
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

    results.push({ game: `${away} @ ${home}`, lean: analysis.lean, odds, kalshi, score: analysis.score, confidence: analysis.confidence, edge, line1, line2, sportsbookLine, kalshiLine, leaderboardSentence });
  }

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

const LOGS_DIR = path.join(__dirname, 'logs');
const DAEMON_LOG_PATH = path.join(LOGS_DIR, 'daemon.log');

// Pushes picks_log.csv after the daemon's update-results run using the GitHub
// Contents API, so it works even when git isn't available (e.g. Railway container).
// Reads the current SHA, base64-encodes the file, and PUTs via GitHub API with
// GITHUB_TOKEN. Failures are swallowed so they never take the daemon down.
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

const DAEMON_SCHEDULE = [
  { hour: 14, minute: 0, name: 'morning-analysis', task: () => getTodayGames() },
  { hour: 17, minute: 0, name: 'afternoon-analysis', task: () => getTodayGames() },
  { hour: 4, minute: 0, name: 'update-results', task: async () => { await updateResults(); await autoPushPicksLog(); } },
];

function appendDaemonLog(message) {
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

  appendDaemonLog('Daemon started — schedule: 14:00 UTC (analysis), 17:00 UTC (analysis), 04:00 UTC (update-results)');
  console.log('Daemon started. Checking schedule every 60s — 14:00 & 17:00 UTC (analysis), 04:00 UTC (update-results).');

  let lastTriggeredKey = null;

  setInterval(() => {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    const match = DAEMON_SCHEDULE.find(s => s.hour === hour && s.minute === minute);
    if (!match) return;

    const key = `${now.toISOString().split('T')[0]}-${match.name}`;
    if (key === lastTriggeredKey) return;
    lastTriggeredKey = key;

    runScheduledTask(match.name, match.task);
  }, 60000);
}

const args = process.argv.slice(2);
if (args.includes('--daemon')) {
  runDaemon();
} else if (args.includes('--update-results')) {
  updateResults().then(() => process.exit(0));
} else if (args.includes('--summary')) {
  printSummary();
} else if (args.includes('--stake')) {
  const i = args.indexOf('--stake');
  const [game, amount, date] = args.slice(i + 1);
  setStake(game, amount, date);
} else if (args.includes('--explain')) {
  getTodayGames({ explain: true });
} else {
  getTodayGames();
}