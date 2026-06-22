require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PICKS_LOG = path.join(__dirname, 'picks_log.csv');
const CSV_HEADERS = ['Date','Game','Lean','Edge_Label','Total_Line','Side','Side_Juice','Result','Hit_Miss','PnL'];

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

const OVER_LEANS = ['STRONG OVER','OVER','LEAN OVER','TILT OVER','DOME — LEAN OVER'];

function logPick(date, game, lean, edgeLabel, odds) {
  const isOver = OVER_LEANS.includes(lean);
  const side = isOver ? 'OVER' : 'UNDER';
  const sideJuice = isOver ? odds.overJuice : odds.underJuice;

  if (!fs.existsSync(PICKS_LOG)) {
    const row = { Date: date, Game: game, Lean: lean, Edge_Label: edgeLabel, Total_Line: odds.total, Side: side, Side_Juice: sideJuice, Result: '', Hit_Miss: '', PnL: '' };
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + rowToCSV(row, CSV_HEADERS) + '\n');
    return;
  }

  const { headers, rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));

  if (rows.some(r => r.Date === date && r.Game === game)) return;

  const hasNewFormat = headers.includes('Side');
  const newRow = { Date: date, Game: game, Lean: lean, Edge_Label: edgeLabel, Total_Line: odds.total, Side: side, Side_Juice: sideJuice, Result: '', Hit_Miss: '', PnL: '' };

  if (!hasNewFormat) {
    const migrated = rows.map(r => ({ ...r, Side: OVER_LEANS.includes(r.Lean) ? 'OVER' : 'UNDER' }));
    migrated.push(newRow);
    fs.writeFileSync(PICKS_LOG, CSV_HEADERS.join(',') + '\n' + migrated.map(r => rowToCSV(r, CSV_HEADERS)).join('\n') + '\n');
  } else {
    fs.appendFileSync(PICKS_LOG, rowToCSV(newRow, CSV_HEADERS) + '\n');
  }
}

function calcPnL(hitMiss, sideJuice) {
  if (hitMiss === 'PUSH') return 0;
  const juice = parseInt(sideJuice);
  const unit = 10;
  if (hitMiss === 'HIT') return juice < 0 ? +(unit * 100 / Math.abs(juice)).toFixed(2) : +(unit * juice / 100).toFixed(2);
  return -unit;
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
      const pnl = calcPnL(hitMiss, row.Side_Juice);
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
  const leanOrder = ['STRONG OVER','OVER','LEAN OVER','TILT OVER','STRONG UNDER','UNDER','LEAN UNDER','TILT UNDER'];
  for (const lean of leanOrder) {
    const g = resolved.filter(r => r.Lean === lean);
    if (g.length === 0) continue;
    const gHits = g.filter(r => r.Hit_Miss === 'HIT').length;
    const gPnL = g.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
    console.log(`  ${lean.padEnd(14)}: ${gHits}/${g.length} (${(gHits/g.length*100).toFixed(1)}%) | P&L: ${gPnL >= 0 ? '+' : ''}${gPnL.toFixed(2)}`);
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
  'TILT OVER': 3,
  'STRONG UNDER': 6,
  'UNDER': 5,
  'LEAN UNDER': 4,
  'TILT UNDER': 3,
  'AVOID': 2,
  'NEUTRAL': 0,
  'DOME — NEUTRAL': 0,
  'DOME — LEAN OVER': 3,
  'DOME — LEAN UNDER': 3,
};

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

    return {
      name: pitcherName,
      era: parseFloat(splits.era),
      groundOutsToAirouts: parseFloat(splits.groundOutsToAirouts),
      strikeoutsPer9Inn: parseFloat(splits.strikeoutsPer9Inn),
      walksPer9Inn: parseFloat(splits.walksPer9Inn),
    };
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
        const res = await axios.get(
          `https://statsapi.mlb.com/api/v1/people/${player.person.id}/stats?stats=lastXGames&season=2026&group=hitting&limit=15`
        );
        const stat = res.data.stats?.[0]?.splits?.[0]?.stat;
        if (!stat || !stat.atBats || stat.atBats < 10) return null;
        return {
          name: player.person.fullName,
          ops: parseFloat(stat.ops || 0),
          avg: stat.avg,
          atBats: stat.atBats,
        };
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(statsPromises)).filter(Boolean);
    results.sort((a, b) => b.ops - a.ops);
    return results;
  } catch {
    return [];
  }
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

function scorePitchers(awayStats, homeStats, windIsOut, venue) {
  const signals = [];
  let overScore = 0;
  let underScore = 0;
  const isCoors = venue === 'Coors Field';

  for (const [side, stats] of [['Away', awayStats], ['Home', homeStats]]) {
    if (!stats) continue;

    const isFlyBall = stats.groundOutsToAirouts < 0.9;
    const isGroundBall = stats.groundOutsToAirouts > 1.2;
    const isElite = stats.era < 2.50;
    const isSolid = stats.era < 3.50;
    const isHittable = stats.era > 5.00;
    const isHighK = stats.strikeoutsPer9Inn > 10.0;

    if (isElite) {
      signals.push(`${side} pitcher ERA ${stats.era.toFixed(2)} — elite, suppresses scoring`);
      underScore += 2;
    } else if (isSolid) {
      signals.push(`${side} pitcher ERA ${stats.era.toFixed(2)} — solid, mild under lean`);
      underScore += 1;
    } else if (isHittable) {
      signals.push(`${side} pitcher ERA ${stats.era.toFixed(2)} — hittable, over lean`);
      overScore += 1;
    }

    if (isFlyBall && windIsOut) {
      signals.push(`${side} fly ball pitcher (GO/AO ${stats.groundOutsToAirouts.toFixed(2)}) + wind out — amplified OVER`);
      overScore += 2;
    } else if (isGroundBall && windIsOut) {
      signals.push(`${side} ground ball pitcher (GO/AO ${stats.groundOutsToAirouts.toFixed(2)}) — wind out effect reduced`);
      overScore -= 1;
    }

    if (isCoors && isFlyBall) {
      signals.push(`${side} fly ball pitcher at Coors — extreme OVER amplifier`);
      overScore += 2;
    }

    if (isHighK) {
      signals.push(`${side} K/9 ${stats.strikeoutsPer9Inn.toFixed(1)} — high strikeout rate caps offense`);
      underScore += 1;
    }
  }

  return { overScore, underScore, signals };
}

function scoreLineup(hitters, label) {
  const signals = [];
  let overScore = 0;
  let underScore = 0;

  if (!hitters || hitters.length === 0) return { overScore, underScore, signals };

  const avgOps = hitters.reduce((a, b) => a + b.ops, 0) / hitters.length;
  const hotHitters = hitters.filter(h => h.ops > 0.800);
  const coldHitters = hitters.filter(h => h.ops < 0.650);

  if (avgOps > 0.780) {
    signals.push(`${label} lineup hot (avg OPS ${avgOps.toFixed(3)} last 15 games)`);
    overScore += 1;
  } else if (avgOps < 0.660) {
    signals.push(`${label} lineup cold (avg OPS ${avgOps.toFixed(3)} last 15 games)`);
    underScore += 1;
  }

  if (hotHitters.length >= 3) {
    signals.push(`${label} has ${hotHitters.length} hot hitters (OPS > .800): ${hotHitters.slice(0,3).map(h => h.name.split(' ')[1]).join(', ')}`);
    overScore += 1;
  }

  if (coldHitters.length >= 3) {
    signals.push(`${label} has ${coldHitters.length} cold hitters (OPS < .650): ${coldHitters.slice(0,3).map(h => h.name.split(' ')[1]).join(', ')}`);
    underScore += 1;
  }

  return { overScore, underScore, signals };
}

function analyzeGame(weather, venue, awayStats, homeStats, awayHitters, homeHitters) {
  const stadium = STADIUMS[venue];
  if (!stadium) return { lean: 'UNKNOWN VENUE', signals: [], score: 0 };

  if (!stadium.outDirs) {
    const signals = ['Weather irrelevant — dome'];
    let overScore = 0;
    let underScore = 0;

    for (const [side, stats] of [['Away', awayStats], ['Home', homeStats]]) {
      if (!stats) continue;
      if (stats.era < 2.50) { signals.push(`${side} ERA ${stats.era.toFixed(2)} — elite`); underScore += 2; }
      else if (stats.era < 3.50) { signals.push(`${side} ERA ${stats.era.toFixed(2)} — solid`); underScore += 1; }
      else if (stats.era > 5.00) { signals.push(`${side} ERA ${stats.era.toFixed(2)} — hittable`); overScore += 1; }
      if (stats.strikeoutsPer9Inn > 10.0) { signals.push(`${side} K/9 ${stats.strikeoutsPer9Inn.toFixed(1)} — high K`); underScore += 1; }
    }

    const awayLineup = scoreLineup(awayHitters, 'Away');
    const homeLineup = scoreLineup(homeHitters, 'Home');
    overScore += awayLineup.overScore + homeLineup.overScore;
    underScore += awayLineup.underScore + homeLineup.underScore;
    signals.push(...awayLineup.signals, ...homeLineup.signals);

    const score = overScore - underScore;
    let lean = 'DOME — NEUTRAL';
    if (score >= 2) lean = 'DOME — LEAN OVER';
    else if (score <= -2) lean = 'DOME — LEAN UNDER';
    return { lean, signals, score };
  }

  if (!weather) return { lean: 'NO DATA', signals: ['Could not fetch weather'], score: 0 };

  const { avgTemp, maxWind, windDir, condition } = weather;
  const signals = [];
  let overScore = 0;
  let underScore = 0;

  const isOut = stadium.outDirs.includes(windDir);
  const isCross = CROSSWIND_DIRS[venue]?.includes(windDir);
  const isIn = !isOut && !isCross;

  if (maxWind >= 15 && isOut) {
    signals.push(`Wind OUT at ${maxWind}mph ${windDir} — ball carries, HR risk up`);
    overScore += 2;
  } else if (maxWind >= 10 && isOut) {
    signals.push(`Wind OUT at ${maxWind}mph ${windDir} — mild carry boost`);
    overScore += 1;
  } else if (maxWind >= 15 && isIn) {
    signals.push(`Wind IN at ${maxWind}mph ${windDir} — fly balls die, pitchers favored`);
    underScore += 2;
  } else if (maxWind >= 10 && isIn) {
    signals.push(`Wind IN at ${maxWind}mph ${windDir} — mild suppression`);
    underScore += 1;
  } else if (maxWind >= 10) {
    signals.push(`Crosswind at ${maxWind}mph ${windDir} — minimal scoring effect`);
  } else {
    signals.push(`Calm wind at ${maxWind}mph — no wind edge`);
  }

  if (avgTemp >= 90) {
    signals.push(`Very hot (${avgTemp}F) — ball carries significantly`);
    overScore += 2;
  } else if (avgTemp >= 80) {
    signals.push(`Warm (${avgTemp}F) — slight carry boost`);
    overScore += 1;
  } else if (avgTemp <= 50) {
    signals.push(`Cold (${avgTemp}F) — ball suppressed noticeably`);
    underScore += 2;
  } else if (avgTemp <= 60) {
    signals.push(`Cool (${avgTemp}F) — mild suppression`);
    underScore += 1;
  } else {
    signals.push(`Neutral temp (${avgTemp}F)`);
  }

  const rainKeywords = ['rain', 'shower', 'storm', 'thunderstorm', 'drizzle'];
  if (rainKeywords.some(k => condition.toLowerCase().includes(k))) {
    signals.push(`${condition} — postponement risk, avoid or wait`);
    return { lean: 'AVOID', signals, score: 0 };
  }

  const windIsOut = isOut && maxWind >= 10;
  const pitcherResult = scorePitchers(awayStats, homeStats, windIsOut, venue);
  overScore += pitcherResult.overScore;
  underScore += pitcherResult.underScore;
  signals.push(...pitcherResult.signals);

  const awayLineup = scoreLineup(awayHitters, 'Away');
  const homeLineup = scoreLineup(homeHitters, 'Home');
  overScore += awayLineup.overScore + homeLineup.overScore;
  underScore += awayLineup.underScore + homeLineup.underScore;
  signals.push(...awayLineup.signals, ...homeLineup.signals);

  const score = overScore - underScore;
  let lean;
  if (score >= 4) lean = 'STRONG OVER';
  else if (score === 3) lean = 'OVER';
  else if (score === 2) lean = 'LEAN OVER';
  else if (score === 1) lean = 'TILT OVER';
  else if (score === -1) lean = 'TILT UNDER';
  else if (score === -2) lean = 'LEAN UNDER';
  else if (score === -3) lean = 'UNDER';
  else if (score <= -4) lean = 'STRONG UNDER';
  else lean = 'NEUTRAL';

  return { lean, signals, score };
}
function detectEdge(lean, odds) {
  if (!odds || lean === 'AVOID' || lean === 'NEUTRAL' || lean === 'DOME — NEUTRAL') {
    return null;
  }

  const isOverLean = ['STRONG OVER', 'OVER', 'LEAN OVER', 'TILT OVER', 'DOME — LEAN OVER'].includes(lean);
  const isUnderLean = ['STRONG UNDER', 'UNDER', 'LEAN UNDER', 'TILT UNDER', 'DOME — LEAN UNDER'].includes(lean);
  const isStrong = ['STRONG OVER', 'STRONG UNDER'].includes(lean);
  const isMedium = ['OVER', 'UNDER', 'LEAN OVER', 'LEAN UNDER'].includes(lean);

  const overJuice = parseInt(odds.overJuice);
  const underJuice = parseInt(odds.underJuice);

  const marketFavorsOver = overJuice < underJuice;
  const marketFavorsUnder = underJuice < overJuice;

  const relevantJuice = isOverLean ? overJuice : underJuice;
  const marketAgrees = (isOverLean && marketFavorsOver) || (isUnderLean && marketFavorsUnder);
  const marketDisagrees = (isOverLean && marketFavorsUnder) || (isUnderLean && marketFavorsOver);

  // Juice thresholds
  const juiceTooExpensive = relevantJuice < -130;
  const juiceFair = relevantJuice >= -115;
  const juiceNearEven = relevantJuice >= -108;

  if (juiceTooExpensive) {
    return { label: 'PASS', reason: `Market already priced this — juice too expensive (${odds.overJuice}/${odds.underJuice})` };
  }

  if (marketDisagrees && isStrong) {
    return { label: 'PRIME TARGET', reason: `Bot strongly disagrees with market direction — maximum gap (${odds.overJuice}/${odds.underJuice})` };
  }

  if (marketDisagrees && isMedium) {
    return { label: 'TARGET', reason: `Bot leans against market direction — gap exists (${odds.overJuice}/${odds.underJuice})` };
  }

  if (marketAgrees && juiceNearEven && isStrong) {
    return { label: 'SHARP', reason: `Market agrees but juice still fair — strong signal at good price (${odds.overJuice}/${odds.underJuice})` };
  }

  if (marketAgrees && juiceFair) {
    return { label: 'CONSIDER', reason: `Market agrees, price acceptable (${odds.overJuice}/${odds.underJuice})` };
  }

  return { label: 'PASS', reason: `Market agrees but juice not favorable enough (${odds.overJuice}/${odds.underJuice})` };
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

async function getTodayGames() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,venue,team`;
  const [response, oddsMap] = await Promise.all([axios.get(url), getOdds()]);
  const games = response.data.dates[0]?.games || [];

  console.log(`\n============================`);
  console.log(` MLB OVER/UNDER BOT — ${today}`);
  console.log(`============================\n`);

  const results = [];

  for (const game of games) {
    const home = game.teams.home.team.name;
    const away = game.teams.away.team.name;
    const homeId = game.teams.home.team.id;
    const awayId = game.teams.away.team.id;
    const venue = game.venue.name;
    const homePitcher = game.teams.home.probablePitcher?.fullName || 'TBD';
    const awayPitcher = game.teams.away.probablePitcher?.fullName || 'TBD';
    const coords = STADIUMS[venue];

    const weather = coords?.outDirs !== undefined && coords.outDirs !== null
      ? await getWeather(coords.lat, coords.lon)
      : null;

    const [awayStats, homeStats, awayHitters, homeHitters] = await Promise.all([
      getPitcherStats(awayPitcher),
      getPitcherStats(homePitcher),
      getTeamHitters(awayId),
      getTeamHitters(homeId),
    ]);

    const analysis = analyzeGame(weather, venue, awayStats, homeStats, awayHitters, homeHitters);

    const fmtPitcher = (name, stats) => {
      if (!stats) return `${name} (no stats)`;
      const type = stats.groundOutsToAirouts < 0.9 ? 'FB' : stats.groundOutsToAirouts > 1.2 ? 'GB' : 'Neutral';
      return `${name} — ERA: ${stats.era.toFixed(2)}, K/9: ${stats.strikeoutsPer9Inn.toFixed(1)}, BB/9: ${stats.walksPer9Inn.toFixed(1)}, ${type}`;
    };

    const oddsKey = `${away}|${home}`;
    const odds = oddsMap[oddsKey];
    const oddsLine = odds?.display || 'No odds available';

    console.log(`${away} @ ${home}`);
    console.log(`  ${venue}`);
    console.log(`  Away: ${fmtPitcher(awayPitcher, awayStats)}`);
    console.log(`  Home: ${fmtPitcher(homePitcher, homeStats)}`);
    if (weather && !analysis.lean.startsWith('DOME')) {
      console.log(`  ${weather.condition}, ${weather.avgTemp}F, Wind ${weather.maxWind}mph ${weather.windDir}`);
    }console.log(`  Line: ${oddsLine}`);
console.log(`  Lean: ${analysis.lean}`);
const edge = detectEdge(analysis.lean, odds);
if (edge) console.log(`  Edge: ${edge.label} — ${edge.reason}`);
if (edge && (edge.label === 'TARGET' || edge.label === 'PRIME TARGET') && odds) {
  logPick(today, `${away} @ ${home}`, analysis.lean, edge.label, odds);
}
    analysis.signals.forEach(s => console.log(`   -> ${s}`));
    console.log('---');

    results.push({ game: `${away} @ ${home}`, lean: analysis.lean, odds, score: analysis.score });
  }

  // Leaderboard
  const actionable = results
    .filter(r => !['NEUTRAL', 'DOME — NEUTRAL', 'NO DATA', 'UNKNOWN VENUE'].includes(r.lean))
    .sort((a, b) => (LEAN_RANK[b.lean] || 0) - (LEAN_RANK[a.lean] || 0));

  console.log(`\n============================`);
  console.log(` TODAY\'S TOP CALLS`);
  console.log(`============================\n`);

  if (actionable.length === 0) {
    console.log('No strong signals today.');
  } else {
    actionable.forEach((r, i) => {
      const line = r.odds ? `Line ${r.odds.total} | Over ${r.odds.overJuice} / Under ${r.odds.underJuice}` : 'No odds';
      console.log(`${i + 1}. ${r.lean.padEnd(14)} — ${r.game} | ${line}`);
    });
  }

  console.log(`\n(NEUTRAL and dome games with no lean hidden)`);
  console.log(`============================\n`);
}

const args = process.argv.slice(2);
if (args.includes('--update-results')) {
  updateResults().then(() => process.exit(0));
} else if (args.includes('--summary')) {
  printSummary();
} else {
  getTodayGames();
}