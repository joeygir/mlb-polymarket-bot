# MLB Polymarket Bot

A Node.js CLI that generates daily MLB over/under betting recommendations and tracks their performance.

## What it does

Each run pulls today's MLB slate and scores every game on a small set of weighted signals — starting pitcher quality (xERA), ERA-vs-xERA regression risk, park factor, wind (only at high-reliability parks), temperature extremes, bullpen ERA quality, and team OPS (last 15 games and season, only when they agree) — to produce a lean (STRONG OVER through STRONG UNDER, or NEUTRAL/AVOID) with a confidence rating (HIGH/MEDIUM/LOW).

Edge detection compares that lean against live Kalshi market prices (decimal odds) to flag actionable mispricings as TARGET or PRIME TARGET. Sportsbook odds are used only to anchor which Kalshi strike to compare against — Kalshi is the sole pricing source for edge labeling.

Recommendations are logged to `picks_log.csv`, and results can be graded after the games finish to track real hit rate and P&L over time.

## APIs used

- **MLB Stats API** (`statsapi.mlb.com`) — schedule, probable pitchers, rosters, pitching/hitting stats, bullpen stats, final scores
- **Baseball Savant** (`baseballsavant.mlb.com`) — xERA leaderboard CSV
- **National Weather Service** (`api.weather.gov`) — temperature and wind forecast for outdoor parks
- **The Odds API** (`api.the-odds-api.com`) — sportsbook consensus O/U total line (used only to pick the matching Kalshi strike)
- **Kalshi** (`api.elections.kalshi.com`) — live market prices for MLB total-runs markets; primary source for edge detection. Requires RSA-PSS authenticated requests.

## Setup

1. `npm install`
2. Create a `.env` file with:
   ```
   ODDS_API_KEY=your_odds_api_key
   KALSHI_API_KEY_ID=your_kalshi_key_id
   ```
3. Place your Kalshi RSA private key at `kalshi_private_key.pem` in the project root.

## Running it

```
node index.js                  # run today's slate, print full per-game breakdown + leaderboard
node index.js --explain        # verbose breakdown (all fired signals, tiers, confidence) for TARGET/PRIME TARGET calls only
node index.js --summary        # performance summary from picks_log.csv (hit rate, P&L, by edge label/lean/confidence)
node index.js --update-results # fetch final scores and grade pending picks in picks_log.csv
node index.js --stake "<game>" <amount> <date>   # set the stake for a logged pick
```

Picks that meet the confidence gate (MEDIUM or HIGH) and earn a TARGET or PRIME TARGET edge label are automatically logged to `picks_log.csv` for tracking.

## Daemon mode (continuous operation)

For research and daily tracking, run the daemon to automatically execute all tasks on schedule:

```bash
node index.js --daemon
```

**Schedule (UTC):**
- **Weekdays** (Mon-Fri): 16:00 (morning analysis), 23:00 (pregame analysis), 04:00 (grade results)
- **Saturdays**: 15:00, 18:00, 04:00
- **Sundays**: 14:00, 15:30, 04:00

The daemon will:
1. Generate daily picks at scheduled times
2. Grade picks from the previous day at 04:00 UTC
3. Send email summaries after analysis runs (if configured)
4. Log all activity to `logs/daemon.log`

**Deployment:** The daemon should run continuously (e.g., on Railway, Heroku, or a local machine). See `logs/daemon.log` for execution history.

## Email reporting (optional)

The daemon can automatically send daily email summaries of yesterday's results and today's picks.

### Setup

1. **Generate a Gmail app password:**
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Enable 2-Step Verification (if not already enabled)
   - Generate an app password for "Mail" and "Windows Computer"
   - Copy the 16-character password

2. **Add to `.env`:**
   ```
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-16-character-app-password
   EMAIL_TO=recipient@example.com
   ```

3. **For Railway deployment:**
   - Add the same three environment variables to your Railway project settings

### Features

Emails are sent automatically after the noon and 7pm analysis runs (if `EMAIL_USER`, `EMAIL_PASS`, and `EMAIL_TO` are configured).

Each email includes:
- **Yesterday's Results** — All resolved picks from the previous day with game, lean, result, and P&L
- **Today's Picks** — Only TARGET and PRIME TARGET calls with two-line format (lean + edge label + line + Kalshi price)
- **Overall Summary** — Total picks logged, overall hit rate, total P&L, current streak, and hit rate breakdown by lean type

Email is skipped if there are no TARGET or PRIME TARGET picks for the day.

### Testing email

To send a test email immediately:
```
node index.js --send-email
```
