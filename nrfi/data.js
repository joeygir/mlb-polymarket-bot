const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Local cache ------------------------------------------------------------
// Every MLB Stats API / Savant response pulled below is cached to
// data/nrfi_cache/{date}/{key}.json so a single run never hits the same
// endpoint twice, matching the file-based persistence style already used for
// picks_log.csv in ../index.js.

const CACHE_DIR = path.join(__dirname, '..', 'data', 'nrfi_cache');

function cacheFile(date, key) {
  return path.join(CACHE_DIR, date, `${key}.json`);
}

function readCache(date, key) {
  const file = cacheFile(date, key);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(date, key, data) {
  const dir = path.join(CACHE_DIR, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFile(date, key), JSON.stringify(data));
}

async function cachedGet(date, key, url, params) {
  const cached = readCache(date, key);
  if (cached) return cached;
  const res = await axios.get(url, { params });
  writeCache(date, key, res.data);
  return res.data;
}

// --- 1. Today's schedule with probable pitchers ------------------------------

async function getScheduleWithProbables(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,venue`;
  const data = await cachedGet(date, 'schedule', url);
  const games = data.dates?.[0]?.games || [];

  return games.map(g => ({
    gamePk: g.gamePk,
    gameDate: g.gameDate,
    venue: g.venue?.name || null,
    homeTeamId: g.teams.home.team.id,
    awayTeamId: g.teams.away.team.id,
    homeTeamName: g.teams.home.team.name,
    awayTeamName: g.teams.away.team.name,
    homePitcherId: g.teams.home.probablePitcher?.id || null,
    homePitcherName: g.teams.home.probablePitcher?.fullName || null,
    awayPitcherId: g.teams.away.probablePitcher?.id || null,
    awayPitcherName: g.teams.away.probablePitcher?.fullName || null,
    // Empty until MLB posts the confirmed lineup (usually ~2-3hrs before first
    // pitch) — batting order 0 = leadoff, 1 = #2 hitter.
    homeLineup: (g.lineups?.homePlayers || []).map(p => ({ id: p.id, fullName: p.fullName })),
    awayLineup: (g.lineups?.awayPlayers || []).map(p => ({ id: p.id, fullName: p.fullName })),
  }));
}

// --- 2. First-inning pitching splits per probable pitcher -------------------
// Confirms the inning-1 situation code before pulling splits — MLB's own docs
// aren't explicit that i01 = 1st inning, so this checks live rather than
// assuming it.

let situationCodeCache = null;

async function verifyFirstInningSituationCode(date) {
  if (situationCodeCache) return situationCodeCache;

  const candidates = [
    { key: 'situation_codes', url: 'https://statsapi.mlb.com/api/v1/situationCodes' },
    { key: 'situation_codes_meta', url: 'https://statsapi.mlb.com/api/v1/meta?type=situationCodes' },
  ];

  for (const { key, url } of candidates) {
    try {
      const data = await cachedGet(date, key, url);
      const codes = Array.isArray(data) ? data : (data.situationCodes || []);
      const match = codes.find(c => c.code === 'i01' || /1st inning/i.test(c.description || ''));
      if (match) {
        situationCodeCache = match.code;
        console.error(`Confirmed first-inning situation code: ${situationCodeCache} (${match.description || 'no description'})`);
        return situationCodeCache;
      }
    } catch {
      // try the next candidate endpoint
    }
  }

  console.error('WARNING: could not verify the first-inning situation code from either endpoint — defaulting to i01.');
  situationCodeCache = 'i01';
  return situationCodeCache;
}

let firstInningSplitsLogged = false;

async function getFirstInningSplits(pitcherId, currentSeason, date) {
  const sitCode = await verifyFirstInningSituationCode(date);
  const seasons = [currentSeason, currentSeason - 1, currentSeason - 2];

  const bySeason = {};
  for (const yr of seasons) {
    const key = `splits_${pitcherId}_${yr}`;
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&group=pitching&sitCodes=${sitCode}&season=${yr}`;

    let data;
    try {
      data = await cachedGet(date, key, url);
    } catch {
      bySeason[yr] = null;
      continue;
    }

    if (!firstInningSplitsLogged) {
      console.error(`--- Raw first-inning splits JSON (pitcher ${pitcherId}, season ${yr}) — printed once to verify field names ---`);
      console.error(JSON.stringify(data, null, 2));
      firstInningSplitsLogged = true;
    }

    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    bySeason[yr] = stat ? {
      inningsPitched: stat.inningsPitched ?? null,
      earnedRuns: stat.earnedRuns ?? null,
      hits: stat.hits ?? null,
      baseOnBalls: stat.baseOnBalls ?? null,
      strikeOuts: stat.strikeOuts ?? null,
      homeRuns: stat.homeRuns ?? null,
    } : null;
  }

  return bySeason;
}

// --- 3. Full-season skill stats (primary signal) -----------------------------
// FIP isn't returned by the API, so it's computed from the season stat line.

function ipToDecimal(ip) {
  // MLB reports fractional innings in thirds (".1"/".2"), e.g. "6.1" = 6⅓ IP,
  // not 6.1 IP — must convert before using IP as a divisor.
  if (ip == null) return null;
  const val = parseFloat(ip);
  if (Number.isNaN(val)) return null;
  const whole = Math.trunc(val);
  const frac = Math.round((val - whole) * 10);
  return whole + (frac === 1 ? 1 / 3 : frac === 2 ? 2 / 3 : 0);
}

function computeFIP({ homeRuns, baseOnBalls, hitBatsmen, strikeOuts, inningsPitchedDecimal }) {
  if (!inningsPitchedDecimal) return null;
  return (13 * homeRuns + 3 * (baseOnBalls + hitBatsmen) - 2 * strikeOuts) / inningsPitchedDecimal + 3.15;
}

async function getSeasonPitchingStats(pitcherId, season, date) {
  const key = `season_stats_${pitcherId}_${season}`;
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;

  let data;
  try {
    data = await cachedGet(date, key, url);
  } catch {
    return null;
  }

  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  if (!stat) return null;

  const battersFaced = parseFloat(stat.battersFaced) || null;
  const strikeOuts = parseFloat(stat.strikeOuts) || 0;
  const baseOnBalls = parseFloat(stat.baseOnBalls) || 0;
  const homeRuns = parseFloat(stat.homeRuns) || 0;
  const hitBatsmen = parseFloat(stat.hitBatsmen) || 0;
  const inningsPitchedDecimal = ipToDecimal(stat.inningsPitched);

  return {
    era: parseFloat(stat.era) || null,
    kPercent: battersFaced ? strikeOuts / battersFaced : null,
    bbPercent: battersFaced ? baseOnBalls / battersFaced : null,
    hrPer9: inningsPitchedDecimal ? (homeRuns * 9) / inningsPitchedDecimal : null,
    fip: computeFIP({ homeRuns, baseOnBalls, hitBatsmen, strikeOuts, inningsPitchedDecimal }),
    inningsPitched: stat.inningsPitched ?? null,
  };
}

async function getSeasonHittingStats(hitterId, season, date) {
  const key = `season_hitting_${hitterId}_${season}`;
  const url = `https://statsapi.mlb.com/api/v1/people/${hitterId}/stats?stats=season&group=hitting&season=${season}`;

  let data;
  try {
    data = await cachedGet(date, key, url);
  } catch {
    return null;
  }

  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  if (!stat) return null;

  return { obp: parseFloat(stat.obp) || null };
}

// League-average FIP, computed (not hardcoded) by summing every team's raw
// season pitching totals and applying the same FIP formula used per-pitcher —
// gives the actual league run-environment scale for that season/constant.
async function getLeagueAverageFIP(season, date) {
  const key = `league_pitching_${season}`;
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${season}&sportId=1`;

  let data;
  try {
    data = await cachedGet(date, key, url);
  } catch {
    return null;
  }

  const splits = data.stats?.[0]?.splits || [];
  let homeRuns = 0, baseOnBalls = 0, hitBatsmen = 0, strikeOuts = 0, inningsPitchedDecimal = 0;
  for (const s of splits) {
    const stat = s.stat;
    homeRuns += parseFloat(stat.homeRuns) || 0;
    baseOnBalls += parseFloat(stat.baseOnBalls) || 0;
    hitBatsmen += parseFloat(stat.hitBatsmen) || 0;
    strikeOuts += parseFloat(stat.strikeOuts) || 0;
    inningsPitchedDecimal += ipToDecimal(stat.inningsPitched) || 0;
  }

  return computeFIP({ homeRuns, baseOnBalls, hitBatsmen, strikeOuts, inningsPitchedDecimal });
}

// League-average OBP, computed the same way (summed raw counts, not a
// hardcoded constant) — used to judge whether a confirmed 1-2 hitter is
// above or below a league-average on-base threat.
async function getLeagueAverageOBP(season, date) {
  const key = `league_hitting_${season}`;
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=${season}&sportId=1`;

  let data;
  try {
    data = await cachedGet(date, key, url);
  } catch {
    return null;
  }

  const splits = data.stats?.[0]?.splits || [];
  let hits = 0, baseOnBalls = 0, hitByPitch = 0, atBats = 0, sacFlies = 0;
  for (const s of splits) {
    const stat = s.stat;
    hits += parseFloat(stat.hits) || 0;
    baseOnBalls += parseFloat(stat.baseOnBalls) || 0;
    hitByPitch += parseFloat(stat.hitByPitch) || 0;
    atBats += parseFloat(stat.atBats) || 0;
    sacFlies += parseFloat(stat.sacFlies) || 0;
  }

  const denom = atBats + baseOnBalls + hitByPitch + sacFlies;
  return denom ? (hits + baseOnBalls + hitByPitch) / denom : null;
}

// --- 4. Historical first-inning results (grading + NRFI rates) --------------

async function getLinescore(gamePk, date) {
  const key = `linescore_${gamePk}`;
  const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/linescore`;
  try {
    return await cachedGet(date, key, url);
  } catch {
    return null;
  }
}

function isNRFI(linescore) {
  const first = linescore?.innings?.[0];
  if (!first || first.home?.runs == null || first.away?.runs == null) return null;
  return (first.home.runs + first.away.runs) === 0;
}

// Walks the current season's full schedule, grades every completed game's
// first inning via its linescore, and rolls that up into: the league-wide
// first-inning run environment (lambda0 — see nrfi/model.py), each team's
// first-inning scoring (offense) rate (both NRFI-rate and raw runs/game), and
// each starter's NRFI rate. Slow on a cold cache (one linescore fetch per
// completed game) but every fetch is cached, so re-running the same day is
// instant.
async function computeSeasonNRFIRates(season, date) {
  const key = `season_schedule_${season}`;
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R&hydrate=probablePitcher`;

  let data;
  try {
    data = await cachedGet(date, key, url);
  } catch {
    return { teamRates: {}, pitcherRates: {}, teamFirstInningRunRates: {}, lambda0: null, gamesUsed: 0, halfInningsUsed: 0 };
  }

  const games = (data.dates || []).flatMap(d => d.games || []);
  const completed = games.filter(g => g.status?.abstractGameState === 'Final');

  const teamCounts = {};
  const teamRuns = {};
  const pitcherCounts = {};
  const bump = (map, id, nrfiHit) => {
    if (id == null) return;
    if (!map[id]) map[id] = { games: 0, nrfi: 0 };
    map[id].games++;
    if (nrfiHit) map[id].nrfi++;
  };

  let processed = 0;
  let totalFirstInningRuns = 0;
  let halfInningsUsed = 0;
  let gamesUsed = 0;

  for (const g of completed) {
    const linescore = await getLinescore(g.gamePk, date);
    const first = linescore?.innings?.[0];
    const homeRuns = first?.home?.runs;
    const awayRuns = first?.away?.runs;
    if (homeRuns == null || awayRuns == null) continue;

    const nrfi = (homeRuns + awayRuns) === 0;
    const homeTeamId = g.teams.home.team.id;
    const awayTeamId = g.teams.away.team.id;
    const homePitcherId = g.teams.home.probablePitcher?.id;
    const awayPitcherId = g.teams.away.probablePitcher?.id;

    bump(teamCounts, homeTeamId, nrfi);
    bump(teamCounts, awayTeamId, nrfi);
    bump(pitcherCounts, homePitcherId, nrfi);
    bump(pitcherCounts, awayPitcherId, nrfi);

    if (!teamRuns[homeTeamId]) teamRuns[homeTeamId] = { games: 0, runs: 0 };
    if (!teamRuns[awayTeamId]) teamRuns[awayTeamId] = { games: 0, runs: 0 };
    teamRuns[homeTeamId].games++;
    teamRuns[homeTeamId].runs += homeRuns;
    teamRuns[awayTeamId].games++;
    teamRuns[awayTeamId].runs += awayRuns;

    totalFirstInningRuns += homeRuns + awayRuns;
    halfInningsUsed += 2;
    gamesUsed++;

    processed++;
    if (processed % 250 === 0) console.error(`  computeSeasonNRFIRates: graded ${processed}/${completed.length} completed games...`);
  }

  const toRates = (counts) => Object.fromEntries(
    Object.entries(counts).map(([id, c]) => [id, c.games ? c.nrfi / c.games : null])
  );
  const toRunRates = (counts) => Object.fromEntries(
    Object.entries(counts).map(([id, c]) => [id, c.games ? c.runs / c.games : null])
  );

  const lambda0 = halfInningsUsed ? totalFirstInningRuns / halfInningsUsed : null;
  if (lambda0 != null) {
    console.error(`Calibrated league-average first-inning lambda0 = ${lambda0.toFixed(4)} runs/half-inning (${totalFirstInningRuns} runs / ${halfInningsUsed} half-innings across ${gamesUsed} completed games, season ${season})`);
  }

  return {
    teamRates: toRates(teamCounts),
    pitcherRates: toRates(pitcherCounts),
    teamFirstInningRunRates: toRunRates(teamRuns),
    lambda0,
    gamesUsed,
    halfInningsUsed,
  };
}

// --- 5. Optional Statcast first-inning layer ---------------------------------
// pybaseball has no JS equivalent, so this hits Baseball Savant's own CSV
// export directly with the inning filter (hfInn=1|) — same CSV-export
// approach already used for the xERA leaderboard pull in ../index.js
// (getXERA/parseSavantCSV). Savant rate-limits aggressively, so any failure
// here is swallowed and the caller just proceeds without this layer.

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
  if (lines.length < 1) return [];
  const headers = parseSavantCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const fields = parseSavantCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (fields[i] || '').trim(); });
    return obj;
  });
}

async function getStatcastFirstInningProfile(pitcherId, seasons, date) {
  const key = `statcast_i1_${pitcherId}_${seasons.join('-')}`;
  const cached = readCache(date, key);
  if (cached) return cached;

  try {
    const hfSea = seasons.map(s => `${s}%7C`).join('');
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${hfSea}&hfInn=1%7C&player_type=pitcher&pitchers_lookup%5B%5D=${pitcherId}&group_by=name&sort_col=pitches&sort_order=desc&type=details`;
    const res = await axios.get(url);
    const rows = parseSavantCSV(res.data);

    const xwobaValues = rows
      .map(r => parseFloat(r.estimated_woba_using_speedangle))
      .filter(v => !Number.isNaN(v));
    const battedBalls = rows.filter(r => r.launch_speed_angle && r.launch_speed_angle !== 'null');
    const barrels = battedBalls.filter(r => r.launch_speed_angle === '6');

    const profile = {
      pitches: rows.length,
      firstInningXwOBA: xwobaValues.length ? xwobaValues.reduce((a, b) => a + b, 0) / xwobaValues.length : null,
      firstInningBarrelRate: battedBalls.length ? barrels.length / battedBalls.length : null,
    };

    writeCache(date, key, profile);
    return profile;
  } catch (err) {
    console.error(`Statcast first-inning pull failed for pitcher ${pitcherId} (Savant likely rate-limiting) — continuing without it: ${err.message}`);
    return null;
  }
}

// --- Orchestration ------------------------------------------------------------

async function buildDailyDataset(date) {
  const season = new Date(date).getFullYear();
  const games = await getScheduleWithProbables(date);
  const { teamRates, pitcherRates } = await computeSeasonNRFIRates(season, date);

  const pitcherCache = new Map();
  const loadPitcher = async (pitcherId) => {
    if (pitcherId == null) return null;
    if (pitcherCache.has(pitcherId)) return pitcherCache.get(pitcherId);

    const [firstInningSplits, seasonStats, statcast] = await Promise.all([
      getFirstInningSplits(pitcherId, season, date),
      getSeasonPitchingStats(pitcherId, season, date),
      getStatcastFirstInningProfile(pitcherId, [season, season - 1], date),
    ]);

    const profile = {
      pitcherId,
      firstInningSplits,
      seasonStats,
      statcast,
      nrfiRate: pitcherRates[pitcherId] ?? null,
    };
    pitcherCache.set(pitcherId, profile);
    return profile;
  };

  const enriched = [];
  for (const game of games) {
    const [homePitcher, awayPitcher] = await Promise.all([
      loadPitcher(game.homePitcherId),
      loadPitcher(game.awayPitcherId),
    ]);

    enriched.push({
      ...game,
      homeTeamFirstInningRate: teamRates[game.homeTeamId] ?? null,
      awayTeamFirstInningRate: teamRates[game.awayTeamId] ?? null,
      homePitcher,
      awayPitcher,
    });
  }

  return enriched;
}

module.exports = {
  getScheduleWithProbables,
  verifyFirstInningSituationCode,
  getFirstInningSplits,
  getSeasonPitchingStats,
  getSeasonHittingStats,
  getLeagueAverageFIP,
  getLeagueAverageOBP,
  computeFIP,
  ipToDecimal,
  getLinescore,
  isNRFI,
  computeSeasonNRFIRates,
  getStatcastFirstInningProfile,
  buildDailyDataset,
};
