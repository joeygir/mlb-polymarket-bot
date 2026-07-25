# Operations Runbook

How the bot runs day to day, everything it depends on, and the few things
only the account owner can do. Written so no conversation context is needed.

## What runs, and when (all times US Eastern)

The Railway service runs `node index.js --daemon` (see `Procfile`). The
daemon checks its schedule every 60 seconds and fires three tasks per day:

| Task | Weekdays | Saturday | Sunday | What it does |
|---|---|---|---|---|
| morning-analysis | 12:00pm | 11:00am | 10:00am | Analyze today's slate, log picks, **send email** |
| pregame-analysis | 7:00pm | 2:00pm | 11:30am | Re-analyze with fresher lineups/prices, **send email** |
| update-results | 12:00am | 12:00am | 12:00am | Grade finished games, capture CLV closes, push picks_log.csv to GitHub |

Reliability behaviors built in:

- **Catch-up**: if the process wasn't alive at a scheduled time (restart,
  redeploy), the task fires within 60s of the process coming back up.
- **Early-slate adjustment**: if the day's earliest first pitch is before the
  usual morning run, the morning run moves earlier automatically.
- **Per-game isolation**: one game with broken data is skipped and logged;
  the rest of the slate, the status file, and the email all still happen.
- **Email failsafe**: if an analysis ran today but no email has been
  confirmed sent (tracked in `email_ledger.json`), the daemon retries the
  send every 30 minutes until one succeeds.

## Email delivery (Resend)

Email goes out via Resend's HTTP API (`https://api.resend.com/emails`) —
plain HTTPS, no SMTP. Gmail SMTP was removed after repeated unfixable
network failures on Railway (see git history around 2026-07-22).

- **Sender**: `RESEND_FROM_EMAIL`, defaulting to Resend's sandbox address
  `onboarding@resend.dev`.
- **Recipients**: comma-separated `EMAIL_TO`.
- **Unverified-account limitation (currently active)**: until a custom
  domain is verified at resend.com/domains, Resend only delivers to the
  account owner's address. The code always tries the full `EMAIL_TO` list
  first and falls back automatically, so verifying a domain later requires
  **no code change** — the full list just starts working.

## Environment variables (Railway → service → Variables)

| Variable | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | **Yes — emails silently skip without it** | Resend API auth |
| `EMAIL_TO` | Yes | Comma-separated recipient list |
| `RESEND_FROM_EMAIL` | No | Custom sender once a domain is verified |
| `ODDS_API_KEY` | Yes | the-odds-api.com sportsbook consensus lines |
| `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY` | Yes | Kalshi market prices (PEM newlines may be literal `\n`) |
| `GITHUB_TOKEN` | Yes | Nightly picks_log.csv push via GitHub Contents API |
| `DATA_DIR` | Recommended | Set to a mounted volume path (e.g. `/data`) so state survives deploys |
| `EMAIL_USER` / `EMAIL_PASS` | Obsolete | Gmail-era; safe to delete |

## Owner-account actions (cannot be automated)

1. **Set `RESEND_API_KEY` on Railway** — without it the live daemon skips
   every email send. This is the single most common cause of "no email."
2. **Verify a domain with Resend** (resend.com/domains, add their DNS
   records) to deliver to all recipients instead of only the owner.
3. **Attach a Railway volume** (mount `/data`, set `DATA_DIR=/data`) so
   picks, scheduler state, and the email ledger survive restarts/deploys.
   Without it, each deploy briefly re-runs and re-sends today's analysis
   (duplicate email after deploys) and live-logged picks depend on the
   nightly GitHub push for durability.

## Diagnosing "no email today"

Check Railway deploy logs in this order:

1. `Daemon started` — is the process even up?
2. `Starting morning-analysis` / `pregame-analysis` — did the task fire?
3. `✗ Error processing <game>` — a skipped game (fine, non-fatal, but says
   which game had broken data).
4. `Preparing email with N picks` → `✓ Email sent successfully via Resend`
   or `✗ Failed to send email: <reason>` — the send itself.
5. `RESEND_API_KEY: ✗` — the env var is missing on Railway.
6. `Email failsafe: retrying today's email...` — a send failed earlier and
   the daemon is retrying (every 30 min until success).

Every email also carries a **BOT STATUS** header: last completed run,
games/odds/Kalshi coverage, and warnings.

## Pick accuracy — what is and isn't guaranteed

Picks come from a runs-projection probability model (starter xERA, bullpen
ERA weighted by innings, lineup OPS, park, game-time weather) priced
against live Kalshi asks including fees. "Accuracy" is being **validated,
not assumed**: every pick logs its model probability, entry price, and
closing line value (CLV) to `picks_log.csv`, and signal weights get
recalibrated at 200 resolved picks. Treat results as paper-trading until
that validation supports more.

## Local commands

```bash
node index.js                    # analyze today's slate once (logs picks)
node index.js --send-test-email  # build + send the report right now
node index.js --update-results   # grade pending picks, capture CLV
node index.js --summary          # performance summary incl. CLV
node index.js --explain          # deep-dive output for TARGET+ picks
node index.js --daemon           # what Railway runs
```
