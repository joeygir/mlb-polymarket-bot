const axios = require('axios');

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

    // ERA scoring
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

    // GB/FB + wind interaction
    if (isFlyBall && windIsOut) {
      signals.push(`${side} pitcher is fly ball type (GO/AO ${stats.groundOutsToAirouts.toFixed(2)}) + wind out — amplified OVER signal`);
      overScore += 2;
    } else if (isFlyBall && !windIsOut) {
      signals.push(`${side} pitcher is fly ball type (GO/AO ${stats.groundOutsToAirouts.toFixed(2)}) — neutral without wind`);
    } else if (isGroundBall && windIsOut) {
      signals.push(`${side} pitcher is ground ball type (GO/AO ${stats.groundOutsToAirouts.toFixed(2)}) — wind out effect reduced`);
      overScore -= 1;
    }

    // Coors adjustment
    if (isCoors && isFlyBall) {
      signals.push(`${side} fly ball pitcher at Coors — extreme OVER amplifier`);
      overScore += 2;
    }

    // High K rate caps scoring
    if (isHighK) {
      signals.push(`${side} pitcher K/9 ${stats.strikeoutsPer9Inn.toFixed(1)} — high strikeout rate caps offense`);
      underScore += 1;
    }
  }

  return { overScore, underScore, signals };
}

function analyzeGame(weather, venue, awayStats, homeStats) {
  const stadium = STADIUMS[venue];
  if (!stadium) return { lean: 'UNKNOWN VENUE', signals: [] };

  if (!stadium.outDirs) {
    const pitcherSignals = [];
    let overScore = 0;
    let underScore = 0;

    for (const [side, stats] of [['Away', awayStats], ['Home', homeStats]]) {
      if (!stats) continue;
      if (stats.era < 2.50) { pitcherSignals.push(`${side} ERA ${stats.era.toFixed(2)} — elite`); underScore += 2; }
      else if (stats.era < 3.50) { pitcherSignals.push(`${side} ERA ${stats.era.toFixed(2)} — solid`); underScore += 1; }
      else if (stats.era > 5.00) { pitcherSignals.push(`${side} ERA ${stats.era.toFixed(2)} — hittable`); overScore += 1; }
      if (stats.strikeoutsPer9Inn > 10.0) { pitcherSignals.push(`${side} K/9 ${stats.strikeoutsPer9Inn.toFixed(1)} — high K rate`); underScore += 1; }
    }

    const score = overScore - underScore;
    let lean = 'DOME — NEUTRAL';
    if (score >= 2) lean = 'DOME — LEAN OVER (pitchers hittable)';
    else if (score <= -2) lean = 'DOME — LEAN UNDER (pitchers dominant)';

    return { lean, signals: ['Weather irrelevant', ...pitcherSignals] };
  }

  if (!weather) return { lean: 'NO DATA', signals: ['Could not fetch weather'] };

  const { avgTemp, maxWind, windDir, condition } = weather;
  const signals = [];
  let overScore = 0;
  let underScore = 0;

  // Wind analysis
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

  // Temperature analysis
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

  // Rain check
  const rainKeywords = ['rain', 'shower', 'storm', 'thunderstorm', 'drizzle'];
  if (rainKeywords.some(k => condition.toLowerCase().includes(k))) {
    signals.push(`${condition} — postponement risk, avoid or wait`);
    return { lean: 'AVOID', signals };
  }

  // Pitcher scoring
  const windIsOut = isOut && maxWind >= 10;
  const pitcherResult = scorePitchers(awayStats, homeStats, windIsOut, venue);
  overScore += pitcherResult.overScore;
  underScore += pitcherResult.underScore;
  signals.push(...pitcherResult.signals);

  // Final lean
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

  return { lean, signals };
}

async function getTodayGames() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,venue`;
  const response = await axios.get(url);
  const games = response.data.dates[0]?.games || [];

  console.log(`\n============================`);
  console.log(` MLB OVER/UNDER BOT — ${today}`);
  console.log(`============================\n`);

  for (const game of games) {
    const home = game.teams.home.team.name;
    const away = game.teams.away.team.name;
    const venue = game.venue.name;
    const homePitcher = game.teams.home.probablePitcher?.fullName || 'TBD';
    const awayPitcher = game.teams.away.probablePitcher?.fullName || 'TBD';
    const coords = STADIUMS[venue];

    const weather = coords?.outDirs !== undefined && coords.outDirs !== null
      ? await getWeather(coords.lat, coords.lon)
      : null;

    const [awayStats, homeStats] = await Promise.all([
      getPitcherStats(awayPitcher),
      getPitcherStats(homePitcher),
    ]);

    const analysis = analyzeGame(weather, venue, awayStats, homeStats);

    const fmtPitcher = (name, stats) => {
      if (!stats) return `${name} (no stats)`;
      const type = stats.groundOutsToAirouts < 0.9 ? 'FB' : stats.groundOutsToAirouts > 1.2 ? 'GB' : 'Neutral';
      return `${name} — ERA: ${stats.era.toFixed(2)}, K/9: ${stats.strikeoutsPer9Inn.toFixed(1)}, BB/9: ${stats.walksPer9Inn.toFixed(1)}, ${type}`;
    };

    console.log(`${away} @ ${home}`);
    console.log(`  ${venue}`);
    console.log(`  Away: ${fmtPitcher(awayPitcher, awayStats)}`);
    console.log(`  Home: ${fmtPitcher(homePitcher, homeStats)}`);
    if (weather && !analysis.lean.startsWith('DOME')) {
      console.log(`  ${weather.condition}, ${weather.avgTemp}F, Wind ${weather.maxWind}mph ${weather.windDir}`);
    }
    console.log(`  Lean: ${analysis.lean}`);
    analysis.signals.forEach(s => console.log(`   -> ${s}`));
    console.log('---');
  }
}

getTodayGames();