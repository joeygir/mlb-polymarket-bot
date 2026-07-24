const fs = require('fs');
const path = require('path');

// Mirrors index.js: DATA_DIR points at a persistent volume when set (see the
// DATA_DIR comment at the top of index.js), so the email reads the same
// picks/status files the bot writes.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PICKS_LOG = path.join(DATA_DIR, 'picks_log.csv');
const BOT_STATUS_PATH = path.join(DATA_DIR, 'bot_status.json');

// Reads the self-check snapshot index.js writes at the end of every
// getTodayGames() run, so the email can confirm the bot actually ran today
// and flag anything that looked off (no odds, no Kalshi matches, auth
// failure) instead of that only ever showing up as a quiet lack of picks.
function getBotHealthStatus() {
  const today = getTodayString();

  if (!fs.existsSync(BOT_STATUS_PATH)) {
    return {
      available: false,
      warnings: ['No bot_status.json found — the bot may not have completed a run since this check was added.'],
    };
  }

  let status;
  try {
    status = JSON.parse(fs.readFileSync(BOT_STATUS_PATH, 'utf8'));
  } catch {
    return {
      available: false,
      warnings: ['bot_status.json could not be read/parsed — treat bot health as unknown.'],
    };
  }

  const warnings = [];
  if (status.date !== today) {
    warnings.push(`Last recorded run was ${status.date}, not today (${today}) — the bot may not have run today.`);
  }
  if (status.kalshiAuthOk === false) {
    warnings.push('Kalshi authentication FAILED — check the KALSHI_PRIVATE_KEY env var.');
  }
  if (status.gamesTotal > 0 && status.gamesWithOdds === 0) {
    warnings.push(`Odds API returned no data for any of today's ${status.gamesTotal} games.`);
  }
  if (status.gamesTotal > 0 && status.gamesWithKalshi === 0) {
    warnings.push(`Kalshi returned no matching markets for any of today's ${status.gamesTotal} games.`);
  }

  return { available: true, ...status, warnings };
}

const PAPER_TRADING_NOTICE = 'PAPER TRADING MODE — Accuracy tracking is the #1 priority. Every TARGET and PRIME TARGET pick is being logged to picks_log.csv for statistical regression analysis at 200 resolved picks. Do not optimize for pick volume. Only log picks where edge detection is confident. The goal is clean, validated data — not picks.';
const REGRESSION_MILESTONE_TARGET = 200;

function regressionMilestoneLine(resolvedCount) {
  return `Regression milestone: ${resolvedCount}/${REGRESSION_MILESTONE_TARGET} resolved picks logged. At ${REGRESSION_MILESTONE_TARGET} picks, signal weights will be recalibrated based on empirical hit rates.`;
}

function getResolvedPicksCount() {
  if (!fs.existsSync(PICKS_LOG)) return 0;
  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  return rows.filter(r => r.Hit_Miss && r.Hit_Miss !== 'PUSH').length;
}

// Display-only relabeling — the underlying Lean values in picks_log.csv and
// the scoring logic that produces them are untouched.
const LEAN_DISPLAY_NAMES = {
  'STRONG OVER': 'CONFIDENT OVER',
  'OVER': 'SOLID OVER',
  'LEAN OVER': 'POSSIBLE OVER',
  'STRONG UNDER': 'CONFIDENT UNDER',
  'UNDER': 'SOLID UNDER',
  'LEAN UNDER': 'POSSIBLE UNDER',
};

function displayLean(lean) {
  return LEAN_DISPLAY_NAMES[lean] || lean;
}

function parseCSV(content) {
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length < 1) return { headers: [], rows: [] };
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

// Mirrors index.js's getEasternDateString: MLB's schedule and picks_log.csv
// dates follow the US Eastern calendar day, not UTC midnight. UTC's day
// rolls over at 8pm ET in summer, so a raw UTC date computed anywhere in
// that ~4-hour window is a full calendar day ahead of the actual baseball
// day still in progress — this caused a live incident where an email sent
// at 9:34pm ET looked for "today's" picks under the wrong (next) date and
// found none, despite 6 real picks being logged under the correct date.
function getEasternDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function getYesterdayString() {
  return getEasternDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function getTodayString() {
  return getEasternDateString();
}

function getYesterdaysResults() {
  if (!fs.existsSync(PICKS_LOG)) return { picks: [], stats: null };

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const yesterday = getYesterdayString();
  const yesterdayPicks = rows.filter(r => r.Date === yesterday && r.Hit_Miss && r.Hit_Miss !== 'PUSH');

  if (yesterdayPicks.length === 0) return { picks: [], stats: null };

  const hits = yesterdayPicks.filter(r => r.Hit_Miss === 'HIT').length;
  const totalPnL = yesterdayPicks.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);

  return {
    picks: yesterdayPicks,
    stats: {
      total: yesterdayPicks.length,
      hits,
      hitRate: (hits / yesterdayPicks.length * 100).toFixed(1),
      totalPnL: totalPnL.toFixed(2),
    }
  };
}

function getTodaysPicks() {
  if (!fs.existsSync(PICKS_LOG)) return [];

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const today = getTodayString();
  return rows.filter(r => r.Date === today && (r.Edge_Label === 'TARGET' || r.Edge_Label === 'PRIME TARGET') && !r.Result);
}

function getOverallStats() {
  if (!fs.existsSync(PICKS_LOG)) return null;

  const { rows } = parseCSV(fs.readFileSync(PICKS_LOG, 'utf8'));
  const resolved = rows.filter(r => r.Hit_Miss && r.Hit_Miss !== 'PUSH');

  if (resolved.length === 0) return null;

  const hits = resolved.filter(r => r.Hit_Miss === 'HIT').length;
  const totalPnL = resolved.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);

  // By lean
  const leanStats = {};
  const leanOrder = ['STRONG OVER', 'OVER', 'LEAN OVER', 'STRONG UNDER', 'UNDER', 'LEAN UNDER'];
  for (const lean of leanOrder) {
    const g = resolved.filter(r => r.Lean === lean);
    if (g.length === 0) continue;
    const gHits = g.filter(r => r.Hit_Miss === 'HIT').length;
    const gPnL = g.reduce((s, r) => s + (parseFloat(r.PnL) || 0), 0);
    leanStats[lean] = {
      hits: gHits,
      total: g.length,
      hitRate: (gHits / g.length * 100).toFixed(1),
      pnl: gPnL.toFixed(2),
    };
  }

  // Current streak
  const sorted = [...resolved].sort((a, b) => a.Date.localeCompare(b.Date));
  let streakType = null, streakCount = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const hm = sorted[i].Hit_Miss;
    if (!streakType) { streakType = hm; streakCount = 1; }
    else if (hm === streakType) { streakCount++; }
    else break;
  }

  // Closing line value: avg movement of the market toward/away from our
  // entries. Sustained positive CLV is the earliest reliable evidence the
  // model beats the market.
  const clvRows = rows.filter(r => r.CLV !== '' && r.CLV != null && !isNaN(parseFloat(r.CLV)));
  const avgClv = clvRows.length ? clvRows.reduce((s, r) => s + parseFloat(r.CLV), 0) / clvRows.length : null;
  const clvBeat = clvRows.filter(r => parseFloat(r.CLV) > 0).length;

  return {
    totalPicks: rows.length,
    resolvedPicks: resolved.length,
    hits,
    hitRate: (hits / resolved.length * 100).toFixed(1),
    totalPnL: totalPnL.toFixed(2),
    leanStats,
    streak: streakCount > 0 ? `${streakCount} ${streakType}${streakCount > 1 ? (streakType === 'MISS' ? 'ES' : 'S') : ''}` : 'None',
    clv: avgClv != null ? { avg: avgClv.toFixed(1), count: clvRows.length, beat: clvBeat } : null,
  };
}

function buildEmailHTML() {
  const yesterday = getYesterdayString();
  const today = getTodayString();
  const { picks: yesterdayPicks, stats: yesterdayStats } = getYesterdaysResults();
  const todayPicks = getTodaysPicks();
  const overallStats = getOverallStats();

  const picksCount = todayPicks.length;
  const streak = overallStats?.streak || 'None';
  const subject = `MLB Bot — ${today} | ${picksCount} picks today | Streak: ${streak}`;
  const resolvedCount = getResolvedPicksCount();

  const FONT = 'font-family: Arial, Helvetica, sans-serif;';
  const TEXT = 'color:#222222;';
  const MUTED = 'color:#666666;';

  const pnlColor = (pnl) => parseFloat(pnl) >= 0 ? '#2e7d32' : '#c62828';
  const hitMissColor = (hm) => hm === 'HIT' ? '#2e7d32' : (hm === 'MISS' ? '#c62828' : '#757575');
  const sideColor = (side) => side === 'OVER' ? '#2e7d32' : '#c62828';

  const health = getBotHealthStatus();
  const hasWarnings = health.warnings && health.warnings.length > 0;
  const statusColor = hasWarnings ? '#c62828' : '#2e7d32';
  const statusLabel = hasWarnings ? 'WARNING' : 'OK';

  let statusHtml = `
        <tr>
          <td style="padding: 16px; background-color:#f7f7f7; border:1px solid #dddddd; border-left: 4px solid ${statusColor};">
            <span style="${FONT} font-size:13px; font-weight:bold; color:${statusColor};">BOT STATUS: ${statusLabel}</span><br>`;
  if (health.available) {
    const lastRun = new Date(health.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    statusHtml += `
            <span style="${FONT} font-size:12.5px; ${TEXT}">Last run: ${lastRun} &nbsp;|&nbsp; Games: ${health.gamesTotal} &nbsp;|&nbsp; Odds coverage: ${health.gamesWithOdds}/${health.gamesTotal} &nbsp;|&nbsp; Kalshi coverage: ${health.gamesWithKalshi}/${health.gamesTotal} &nbsp;|&nbsp; Kalshi auth: ${health.kalshiAuthOk ? 'OK' : 'FAILED'}</span>`;
  }
  if (hasWarnings) {
    health.warnings.forEach(w => {
      statusHtml += `<br><span style="${FONT} font-size:12.5px; color:${statusColor};">- ${w}</span>`;
    });
  } else {
    statusHtml += `<br><span style="${FONT} font-size:12.5px; ${MUTED}">No issues detected.</span>`;
  }
  statusHtml += `
          </td>
        </tr>`;

  const sectionHeader = (title) => `
        <tr>
          <td style="padding: 20px 0 10px 0; border-bottom: 2px solid #16324f;">
            <span style="${FONT} font-size:16px; font-weight:bold; color:#16324f;">${title}</span>
          </td>
        </tr>`;

  const emptyRow = (text) => `
        <tr>
          <td style="padding: 10px 0 0 0;">
            <span style="${FONT} font-size:13px; ${MUTED}">${text}</span>
          </td>
        </tr>`;

  const resultCardRow = (pick) => {
    const pnl = parseFloat(pick.PnL) || 0;
    return `
        <tr>
          <td style="padding: 6px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-left: 4px solid ${sideColor(pick.Side)}; background-color:#f7f7f7; padding: 10px 12px;">
                  <span style="${FONT} font-size:14px; ${TEXT} font-weight:bold;">${pick.Game}</span>
                  <span style="${FONT} font-size:13px; ${MUTED}"> | ${displayLean(pick.Lean)}</span><br>
                  <span style="${FONT} font-size:13px; ${TEXT}">${pick.Side} vs ${pick.Total_Line} &rarr; ${pick.Result} &rarr; <strong>${pick.Hit_Miss}</strong></span>
                  <span style="${FONT} font-size:13px; font-weight:bold; color:${hitMissColor(pick.Hit_Miss)};"> (${pnl >= 0 ? '+' : ''}${pnl})</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  };

  const pickCardRow = (pick) => {
    const hasReasoning = pick.Signal_Fact || pick.Market_Fact || pick.Risk_Fact;
    const reasoningHtml = hasReasoning
      ? `<br>
                  <span style="${FONT} font-size:12.5px; ${TEXT}">${pick.Signal_Fact || 'Signal detail not available for this pick.'}</span><br>
                  <span style="${FONT} font-size:12.5px; ${TEXT}">${pick.Market_Fact || 'Market comparison not available for this pick.'}</span><br>
                  <span style="${FONT} font-size:12.5px; ${TEXT}">${pick.Risk_Fact || 'Risk factor not available for this pick.'}</span>`
      : `<br>
                  <span style="${FONT} font-size:12.5px; ${MUTED}">Detailed reasoning not available (logged before reasoning tracking began).</span>`;
    return `
        <tr>
          <td style="padding: 6px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-left: 4px solid ${sideColor(pick.Side)}; background-color:#f7f7f7; padding: 10px 12px;">
                  <span style="${FONT} font-size:14px; ${TEXT} font-weight:bold;">${pick.Game}</span>
                  <span style="${FONT} font-size:12.5px; ${MUTED}"> [${pick.Edge_Label}]</span><br>
                  <span style="${FONT} font-size:13px; ${TEXT}">${pick.Side} ${pick.Total_Line} | ${displayLean(pick.Lean)}</span><br>
                  <span style="${FONT} font-size:13px; ${TEXT}">Kalshi: <strong>${pick.Side_Juice}</strong> juice${pick.Model_Prob ? ` | Model: <strong>${(parseFloat(pick.Model_Prob) * 100).toFixed(1)}%</strong> vs entry cost ${(parseFloat(pick.Entry_Cost) * 100).toFixed(0)}%` : ''}</span>
                  ${reasoningHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
  };

  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MLB Bot Report</title>
</head>
<body style="margin:0; padding:0; background-color:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">
  <tr>
    <td align="center" style="padding: 20px 10px;">
      <table role="presentation" width="700" cellpadding="0" cellspacing="0" border="0" style="width:700px; max-width:700px; background-color:#ffffff;">
        <tr>
          <td style="padding-bottom:16px; border-bottom:2px solid #16324f;">
            <span style="${FONT} font-size:20px; font-weight:bold; color:#16324f;">MLB BOT REPORT — ${today}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 16px; background-color:#fff8e1; border:1px solid #e0c46c;">
            <span style="${FONT} font-size:13px; font-weight:bold; color:#6b5900;">${PAPER_TRADING_NOTICE}</span><br>
            <span style="${FONT} font-size:13px; color:#6b5900;">${regressionMilestoneLine(resolvedCount)}</span>
          </td>
        </tr>
${statusHtml}
${sectionHeader(`YESTERDAY'S RESULTS (${yesterday})`)}`;

  if (yesterdayStats) {
    html += `
        <tr>
          <td style="padding: 10px 0 4px 0;">
            <span style="${FONT} font-size:13px; ${TEXT}">Picks Resolved: <strong>${yesterdayStats.hits}/${yesterdayStats.total}</strong> &nbsp;|&nbsp; Hit Rate: <strong>${yesterdayStats.hitRate}%</strong> &nbsp;|&nbsp; P&amp;L: <strong style="color:${pnlColor(yesterdayStats.totalPnL)};">${yesterdayStats.totalPnL >= 0 ? '+' : ''}${yesterdayStats.totalPnL}</strong></span>
          </td>
        </tr>`;
    yesterdayPicks.forEach(pick => { html += resultCardRow(pick); });
  } else {
    html += emptyRow('No results from yesterday.');
  }

  html += sectionHeader(`TODAY'S PICKS (${today})`);

  if (todayPicks.length === 0) {
    html += emptyRow('No TARGET or PRIME TARGET calls today.');
  } else {
    todayPicks.forEach(pick => { html += pickCardRow(pick); });
  }

  html += sectionHeader('OVERALL SUMMARY');

  if (overallStats) {
    html += `
        <tr>
          <td style="padding: 10px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="${FONT} font-size:13px; ${TEXT} padding:3px 0;">Total Picks Made:</td><td style="${FONT} font-size:13px; ${TEXT} font-weight:bold; padding:3px 0;" align="right">${overallStats.totalPicks}</td></tr>
              <tr><td style="${FONT} font-size:13px; ${TEXT} padding:3px 0;">Overall Hit Rate:</td><td style="${FONT} font-size:13px; ${TEXT} font-weight:bold; padding:3px 0;" align="right">${overallStats.hits}/${overallStats.resolvedPicks} (${overallStats.hitRate}%)</td></tr>
              <tr><td style="${FONT} font-size:13px; ${TEXT} padding:3px 0;">Total P&amp;L:</td><td style="${FONT} font-size:13px; font-weight:bold; padding:3px 0; color:${pnlColor(overallStats.totalPnL)};" align="right">${overallStats.totalPnL >= 0 ? '+' : ''}${overallStats.totalPnL}</td></tr>
              <tr><td style="${FONT} font-size:13px; ${TEXT} padding:3px 0;">Current Streak:</td><td style="${FONT} font-size:13px; ${TEXT} font-weight:bold; padding:3px 0;" align="right">${overallStats.streak}</td></tr>
              ${overallStats.clv ? `<tr><td style="${FONT} font-size:13px; ${TEXT} padding:3px 0;">Closing Line Value:</td><td style="${FONT} font-size:13px; font-weight:bold; padding:3px 0; color:${overallStats.clv.avg >= 0 ? '#2e7d32' : '#c62828'};" align="right">avg ${overallStats.clv.avg >= 0 ? '+' : ''}${overallStats.clv.avg} pts (${overallStats.clv.beat}/${overallStats.clv.count} beat close)</td></tr>` : ''}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0 6px 0;">
            <span style="${FONT} font-size:13px; font-weight:bold; ${TEXT}">Hit Rate by Lean</span>
          </td>
        </tr>
        <tr>
          <td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; border:1px solid #dddddd;">
              <tr>
                <td style="${FONT} font-size:12.5px; font-weight:bold; color:#16324f; background-color:#f0f0f0; border:1px solid #dddddd; padding:6px 8px;">Lean Type</td>
                <td style="${FONT} font-size:12.5px; font-weight:bold; color:#16324f; background-color:#f0f0f0; border:1px solid #dddddd; padding:6px 8px;">Record</td>
                <td style="${FONT} font-size:12.5px; font-weight:bold; color:#16324f; background-color:#f0f0f0; border:1px solid #dddddd; padding:6px 8px;">Hit Rate</td>
                <td style="${FONT} font-size:12.5px; font-weight:bold; color:#16324f; background-color:#f0f0f0; border:1px solid #dddddd; padding:6px 8px;">P&amp;L</td>
              </tr>`;

    for (const [lean, stats] of Object.entries(overallStats.leanStats)) {
      html += `
              <tr>
                <td style="${FONT} font-size:12.5px; ${TEXT} border:1px solid #dddddd; padding:6px 8px;">${displayLean(lean)}</td>
                <td style="${FONT} font-size:12.5px; ${TEXT} border:1px solid #dddddd; padding:6px 8px;">${stats.hits}/${stats.total}</td>
                <td style="${FONT} font-size:12.5px; ${TEXT} border:1px solid #dddddd; padding:6px 8px;">${stats.hitRate}%</td>
                <td style="${FONT} font-size:12.5px; font-weight:bold; color:${pnlColor(stats.pnl)}; border:1px solid #dddddd; padding:6px 8px;">${stats.pnl >= 0 ? '+' : ''}${stats.pnl}</td>
              </tr>`;
    }

    html += `
            </table>
          </td>
        </tr>`;
  } else {
    html += emptyRow('No resolved picks yet.');
  }

  html += `
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

  return { subject, html };
}

function buildEmailText() {
  const yesterday = getYesterdayString();
  const today = getTodayString();
  const { picks: yesterdayPicks, stats: yesterdayStats } = getYesterdaysResults();
  const todayPicks = getTodaysPicks();
  const overallStats = getOverallStats();
  const resolvedCount = getResolvedPicksCount();

  const rule = '='.repeat(40);
  const lines = [];

  lines.push(`MLB BOT REPORT — ${today}`, '');
  lines.push(PAPER_TRADING_NOTICE);
  lines.push(regressionMilestoneLine(resolvedCount), '');

  const health = getBotHealthStatus();
  const hasWarnings = health.warnings && health.warnings.length > 0;
  lines.push(rule, `BOT STATUS: ${hasWarnings ? 'WARNING' : 'OK'}`, rule);
  if (health.available) {
    const lastRun = new Date(health.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    lines.push(`Last run: ${lastRun} | Games: ${health.gamesTotal} | Odds coverage: ${health.gamesWithOdds}/${health.gamesTotal} | Kalshi coverage: ${health.gamesWithKalshi}/${health.gamesTotal} | Kalshi auth: ${health.kalshiAuthOk ? 'OK' : 'FAILED'}`);
  }
  if (hasWarnings) {
    health.warnings.forEach(w => lines.push(`- ${w}`));
  } else {
    lines.push('No issues detected.');
  }
  lines.push('');

  lines.push(rule, `YESTERDAY'S RESULTS (${yesterday})`, rule);
  if (yesterdayStats) {
    lines.push(`Picks Resolved: ${yesterdayStats.hits}/${yesterdayStats.total}`);
    lines.push(`Hit Rate: ${yesterdayStats.hitRate}%`);
    lines.push(`P&L: ${yesterdayStats.totalPnL >= 0 ? '+' : ''}${yesterdayStats.totalPnL}`, '');
    yesterdayPicks.forEach(pick => {
      const pnl = parseFloat(pick.PnL) || 0;
      lines.push(`- ${pick.Game} | ${displayLean(pick.Lean)}`);
      lines.push(`  ${pick.Side} vs ${pick.Total_Line} -> ${pick.Result} -> ${pick.Hit_Miss} (${pnl >= 0 ? '+' : ''}${pnl})`);
    });
  } else {
    lines.push('No results from yesterday.');
  }
  lines.push('');

  lines.push(rule, `TODAY'S PICKS (${today})`, rule);
  if (todayPicks.length === 0) {
    lines.push('No TARGET or PRIME TARGET calls today.');
  } else {
    todayPicks.forEach(pick => {
      lines.push(`- ${pick.Game} [${pick.Edge_Label}]`);
      lines.push(`  ${pick.Side} ${pick.Total_Line} | ${displayLean(pick.Lean)}`);
      lines.push(`  Kalshi: ${pick.Side_Juice} juice${pick.Model_Prob ? ` | Model: ${(parseFloat(pick.Model_Prob) * 100).toFixed(1)}% vs entry cost ${(parseFloat(pick.Entry_Cost) * 100).toFixed(0)}%` : ''}`);
      if (pick.Signal_Fact || pick.Market_Fact || pick.Risk_Fact) {
        lines.push(`  ${pick.Signal_Fact || 'Signal detail not available for this pick.'}`);
        lines.push(`  ${pick.Market_Fact || 'Market comparison not available for this pick.'}`);
        lines.push(`  ${pick.Risk_Fact || 'Risk factor not available for this pick.'}`);
      } else {
        lines.push('  Detailed reasoning not available (logged before reasoning tracking began).');
      }
      lines.push('');
    });
  }

  lines.push(rule, 'OVERALL SUMMARY', rule);
  if (overallStats) {
    lines.push(`Total Picks Made: ${overallStats.totalPicks}`);
    lines.push(`Overall Hit Rate: ${overallStats.hits}/${overallStats.resolvedPicks} (${overallStats.hitRate}%)`);
    lines.push(`Total P&L: ${overallStats.totalPnL >= 0 ? '+' : ''}${overallStats.totalPnL}`);
    lines.push(`Current Streak: ${overallStats.streak}`);
    if (overallStats.clv) {
      lines.push(`Closing Line Value: avg ${overallStats.clv.avg >= 0 ? '+' : ''}${overallStats.clv.avg} pts (${overallStats.clv.beat}/${overallStats.clv.count} beat close)`);
    }
    lines.push('');
    lines.push('Hit Rate by Lean:');
    for (const [lean, stats] of Object.entries(overallStats.leanStats)) {
      lines.push(`  ${displayLean(lean).padEnd(16)}: ${stats.hits}/${stats.total} (${stats.hitRate}%) | P&L: ${stats.pnl >= 0 ? '+' : ''}${stats.pnl}`);
    }
  } else {
    lines.push('No resolved picks yet.');
  }

  return lines.join('\n');
}

// Sends via Resend's HTTP API instead of raw SMTP — a plain authenticated
// HTTPS POST, the exact same mechanism every other network call in this bot
// (MLB, Kalshi, weather.gov) already uses reliably on Railway every single
// run. This replaces nodemailer/Gmail SMTP entirely after repeated live
// failures there (connection timeouts, then an IPv6 routing dead end that
// survived two separate fix attempts) — the failure mode was the transport
// itself, not any one bug in it.
//
// Resend restricts un-verified accounts (no custom domain added at
// resend.com/domains) to sending only to the account's own registered email
// — confirmed live: a real send to 2 recipients came back
// "You can only send testing emails to your own email address (X)". Rather
// than hard-code that single address, the first attempt always targets the
// full configured EMAIL_TO list; if Resend rejects it with that specific
// message, the allowed address is parsed straight out of Resend's own error
// text and used for a fallback send. Once a domain is verified, the first
// attempt just succeeds and this fallback never triggers again — no code
// change needed then.
const RESEND_RESTRICTED_RE = /You can only send testing emails to your own email address \(([^)]+)\)/;

async function sendViaResend({ from, to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const post = async (toList) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toList, subject, html, text }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  const fullList = to.split(',').map(e => e.trim()).filter(Boolean);
  console.log(`  Sending via Resend API to ${fullList.join(', ')}...`);
  let result = await post(fullList);

  if (!result.ok) {
    const restricted = RESEND_RESTRICTED_RE.exec(result.data?.message || '');
    if (restricted && fullList.length > 1) {
      const ownEmail = restricted[1];
      console.log(`  Resend account isn't domain-verified yet — falling back to ${ownEmail} only (${fullList.length - 1} other recipient(s) won't get this one). Verify a domain at resend.com/domains to unlock everyone on EMAIL_TO.`);
      result = await post([ownEmail]);
    }
  }

  if (!result.ok) {
    throw new Error(result.data?.message || `Resend API error (HTTP ${result.status})`);
  }
  return result.data;
}

async function sendEmailReport(opts = {}) {
  const forceTest = opts.forceTest || false;
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.EMAIL_TO;
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  if (!apiKey || !to) {
    console.log('Email not configured — skipping email report');
    console.log(`  RESEND_API_KEY: ${apiKey ? '✓' : '✗'}`);
    console.log(`  EMAIL_TO: ${to ? '✓' : '✗'}`);
    return;
  }

  const todayPicks = getTodaysPicks();
  if (forceTest) {
    console.log('[TEST MODE] Sending test email...');
  }

  // Always send — even with zero picks today, the email is the way to
  // confirm the bot ran and to see yesterday's summary and health status.
  console.log(`Preparing email with ${todayPicks.length} picks for ${to}...`);

  const { subject, html } = buildEmailHTML();
  const text = buildEmailText();

  try {
    const info = await sendViaResend({ from, to, subject, html, text });
    console.log(`✓ Email sent successfully via Resend`);
    console.log(`  Message ID: ${info.id}`);
  } catch (err) {
    console.error(`✗ Failed to send email: ${err.message}`);
  }
}

module.exports = {
  sendEmailReport,
  testEmailReport: () => sendEmailReport({ forceTest: true })
};
