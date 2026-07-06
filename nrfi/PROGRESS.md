# NRFI Module — Status

## Architecture
- nrfi/data.js: single source of truth for MLB API fetching/caching (JS, not Python)
- nrfi/bridge.js: subprocess bridge, model.py calls into it
- nrfi/model.py: Poisson NRFI model

## Key decisions
- lambda0 must be calibrated as -ln(scoreless_rate), NOT mean runs per half-inning.
  Mean runs gives ~0.55 -> P(NRFI)=0.33, badly wrong. Effective lambda gives ~0.31-0.36 -> P(NRFI)~0.52, matches reality.
- Component (b) regresses toward the pitcher's own multi-year overall rate, gated on 40+ career first innings.
- Weather uses api.weather.gov, same source as O/U bot. Silently no-ops on this
  machine (Homebrew Python missing root certs, not a code bug). Should work on
  Railway (proper Linux certs) — VERIFY this on first prod run, check for the
  per-game weather multiplier log line.
- Park factors are a hardcoded dict (Coors 1.25, Oracle 0.92) with a TODO to replace
  with computed first-inning-specific factors once a season of linescores is cached.

## Last status
[paste whatever the backtest printed, or "backtest re-running after lambda0 fix, awaiting bucket calibration + Brier score"]

## Next steps
- Confirm 55-65% predicted bucket hits close to 55-65% actual
- If still miscalibrated, check for over-aggressive multiplicative component
- Then move to Kalshi KXMLBRFI market matching (Prompt 3)
