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
