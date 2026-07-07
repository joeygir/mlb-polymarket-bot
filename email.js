const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const PICKS_LOG = path.join(__dirname, 'picks_log.csv');

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

function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getTodayString() {
  return new Date().toISOString().split('T')[0];
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

  return {
    totalPicks: rows.length,
    resolvedPicks: resolved.length,
    hits,
    hitRate: (hits / resolved.length * 100).toFixed(1),
    totalPnL: totalPnL.toFixed(2),
    leanStats,
    streak: streakCount > 0 ? `${streakCount} ${streakType}${streakCount > 1 ? 'S' : ''}` : 'None',
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

  let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: monospace; line-height: 1.6; background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; background: #2d2d2d; padding: 20px; border-radius: 5px; }
    .header { color: #4ec9b0; font-size: 18px; font-weight: bold; margin-bottom: 20px; border-bottom: 2px solid #4ec9b0; padding-bottom: 10px; }
    .section { margin-bottom: 30px; }
    .section-title { color: #569cd6; font-weight: bold; font-size: 14px; margin-top: 20px; margin-bottom: 10px; }
    .pick-row { background: #1e1e1e; padding: 8px; margin: 5px 0; border-left: 3px solid #4ec9b0; }
    .hit { border-left-color: #4ec9b0; }
    .miss { border-left-color: #ce9178; }
    .push { border-left-color: #d7ba7d; }
    .stat-row { padding: 5px 0; }
    .stat-label { color: #9cdcfe; display: inline-block; width: 180px; }
    .stat-value { color: #b5cea8; font-weight: bold; }
    .positive { color: #4ec9b0; }
    .negative { color: #ce9178; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #444; }
    th { background: #3e3e3e; color: #569cd6; font-weight: bold; }
    td { background: #252525; }
    .notice-banner { background: #3a2f00; border: 2px solid #d7ba7d; color: #ffd866; padding: 12px; margin-bottom: 20px; border-radius: 4px; font-weight: bold; }
    .milestone-line { margin-top: 8px; color: #9cdcfe; font-weight: normal; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">⚾ MLB BOT REPORT — ${today}</div>
  <div class="notice-banner">
    ${PAPER_TRADING_NOTICE}
    <div class="milestone-line">${regressionMilestoneLine(resolvedCount)}</div>
  </div>
`;

  // Yesterday's Results Section
  html += `
  <div class="section">
    <div class="section-title">📊 YESTERDAY'S RESULTS (${yesterday})</div>
`;

  if (yesterdayStats) {
    html += `
    <div class="stat-row">
      <span class="stat-label">Picks Resolved:</span>
      <span class="stat-value">${yesterdayStats.hits}/${yesterdayStats.total}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Hit Rate:</span>
      <span class="stat-value">${yesterdayStats.hitRate}%</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">P&L:</span>
      <span class="stat-value ${yesterdayStats.totalPnL >= 0 ? 'positive' : 'negative'}">${yesterdayStats.totalPnL >= 0 ? '+' : ''}${yesterdayStats.totalPnL}</span>
    </div>
    <br>
`;

    yesterdayPicks.forEach(pick => {
      const hitClass = pick.Hit_Miss === 'HIT' ? 'hit' : (pick.Hit_Miss === 'MISS' ? 'miss' : 'push');
      const pnl = parseFloat(pick.PnL) || 0;
      html += `
    <div class="pick-row ${hitClass}">
      <strong>${pick.Game}</strong> | ${pick.Lean}<br>
      ${pick.Side} vs ${pick.Total_Line} → ${pick.Result} → <strong>${pick.Hit_Miss}</strong>
      <span class="stat-value ${pnl >= 0 ? 'positive' : 'negative'}">(${pnl >= 0 ? '+' : ''}${pnl})</span>
    </div>
`;
    });
  } else {
    html += `<p style="color: #808080;">No results from yesterday.</p>`;
  }

  html += `</div>`;

  // Today's Picks Section
  html += `
  <div class="section">
    <div class="section-title">🎯 TODAY'S PICKS (${today})</div>
`;

  if (todayPicks.length === 0) {
    html += `<p style="color: #808080;">No TARGET or PRIME TARGET calls today.</p>`;
  } else {
    todayPicks.forEach(pick => {
      html += `
    <div class="pick-row hit">
      <strong>${pick.Game}</strong> [${pick.Edge_Label}]<br>
      ${pick.Lean} | Line: ${pick.Total_Line}<br>
      Kalshi: <span class="stat-value">${pick.Side_Juice}</span> juice
    </div>
`;
    });
  }

  html += `</div>`;

  // Overall Summary Section
  html += `
  <div class="section">
    <div class="section-title">📈 OVERALL SUMMARY</div>
`;

  if (overallStats) {
    html += `
    <div class="stat-row">
      <span class="stat-label">Total Picks Made:</span>
      <span class="stat-value">${overallStats.totalPicks}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Overall Hit Rate:</span>
      <span class="stat-value">${overallStats.hits}/${overallStats.resolvedPicks} (${overallStats.hitRate}%)</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total P&L:</span>
      <span class="stat-value ${overallStats.totalPnL >= 0 ? 'positive' : 'negative'}">${overallStats.totalPnL >= 0 ? '+' : ''}${overallStats.totalPnL}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Current Streak:</span>
      <span class="stat-value">${overallStats.streak}</span>
    </div>

    <div style="margin-top: 15px;">
      <div style="color: #569cd6; font-weight: bold; margin-bottom: 8px;">Hit Rate by Lean:</div>
      <table>
        <tr>
          <th>Lean Type</th>
          <th>Record</th>
          <th>Hit Rate</th>
          <th>P&L</th>
        </tr>
`;

    for (const [lean, stats] of Object.entries(overallStats.leanStats)) {
      html += `
        <tr>
          <td>${lean}</td>
          <td>${stats.hits}/${stats.total}</td>
          <td>${stats.hitRate}%</td>
          <td><span class="${stats.pnl >= 0 ? 'positive' : 'negative'}">${stats.pnl >= 0 ? '+' : ''}${stats.pnl}</span></td>
        </tr>
`;
    }

    html += `
      </table>
    </div>
`;
  } else {
    html += `<p style="color: #808080;">No resolved picks yet.</p>`;
  }

  html += `
  </div>
</div>
</body>
</html>
`;

  return { subject, html };
}

async function sendEmailReport(opts = {}) {
  const forceTest = opts.forceTest || false;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const to = process.env.EMAIL_TO;

  if (!user || !pass || !to) {
    console.log('Email credentials not configured — skipping email report');
    console.log(`  EMAIL_USER: ${user ? '✓' : '✗'}`);
    console.log(`  EMAIL_PASS: ${pass ? '✓' : '✗'}`);
    console.log(`  EMAIL_TO: ${to ? '✓' : '✗'}`);
    return;
  }

  const todayPicks = getTodaysPicks();
  if (todayPicks.length === 0 && !forceTest) {
    console.log('No picks today — skipping email');
    return;
  }

  if (forceTest) {
    console.log('[TEST MODE] Sending test email regardless of picks...');
  }

  console.log(`Preparing email with ${todayPicks.length} picks for ${to}...`);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass,
    },
  });

  const { subject, html } = buildEmailHTML();

  try {
    console.log(`Connecting to Gmail SMTP...`);
    const info = await transporter.sendMail({
      from: user,
      to,
      subject,
      html,
    });
    console.log(`✓ Email sent successfully to ${to}`);
    console.log(`  Message ID: ${info.messageId}`);
  } catch (err) {
    console.error(`✗ Failed to send email: ${err.message}`);
    if (err.response) console.error(`  Response: ${err.response}`);
  }
}

module.exports = {
  sendEmailReport,
  testEmailReport: () => sendEmailReport({ forceTest: true })
};
