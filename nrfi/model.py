"""Poisson-based NRFI (No Run First Inning) probability model.

Architecture note: this repo's MLB/Savant data-fetching + caching already
lives in nrfi/data.js (Node) — see that file's header for why. Rather than
re-implementing the same fetch/cache logic a second time in Python, this
module calls into nrfi/data.js through nrfi/bridge.js (a thin `node` CLI
subprocess) for every raw data need, so nrfi/data.js remains the single
source of truth and its on-disk cache (data/nrfi_cache/) is shared by both
languages. `node` must be on PATH to run this file.

This module outputs probabilities ONLY — p_nrfi and the per-component
lambda multipliers. It does not decide NRFI/YRFI/PASS; that classification
belongs to the edge-vs-market-price step downstream, per the model spec.
"""

import argparse
import json
import math
import subprocess
import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

NRFI_DIR = Path(__file__).resolve().parent
BRIDGE = NRFI_DIR / "bridge.js"


class DataLayerError(RuntimeError):
    pass


def _call(fn_name, *args):
    cmd = ["node", str(BRIDGE), fn_name] + [json.dumps(a) for a in args]
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(NRFI_DIR))
    if proc.returncode != 0:
        raise DataLayerError(f"{fn_name}({args!r}) failed:\n{proc.stderr}")
    return json.loads(proc.stdout) if proc.stdout.strip() else None


# --- Thin wrappers over nrfi/data.js -----------------------------------------

def get_schedule(date_str):
    return _call("getScheduleWithProbables", date_str)


def get_first_inning_splits(pitcher_id, season, date_str):
    return _call("getFirstInningSplits", pitcher_id, season, date_str)


def get_season_pitching_stats(pitcher_id, season, date_str):
    return _call("getSeasonPitchingStats", pitcher_id, season, date_str)


def get_season_hitting_stats(hitter_id, season, date_str):
    return _call("getSeasonHittingStats", hitter_id, season, date_str)


def get_league_average_fip(season, date_str):
    return _call("getLeagueAverageFIP", season, date_str)


def get_league_average_obp(season, date_str):
    return _call("getLeagueAverageOBP", season, date_str)


def get_linescore(game_pk, date_str):
    return _call("getLinescore", game_pk, date_str)


def compute_season_nrfi_rates(season, date_str):
    return _call("computeSeasonNRFIRates", season, date_str)


def is_nrfi(linescore):
    if not linescore or not linescore.get("innings"):
        return None
    first = linescore["innings"][0]
    home = first.get("home", {}).get("runs")
    away = first.get("away", {}).get("runs")
    if home is None or away is None:
        return None
    return (home + away) == 0


def ip_to_decimal(ip):
    # MLB reports fractional innings in thirds (".1"/".2"), e.g. "6.1" = 6⅓ IP.
    if ip is None:
        return None
    try:
        val = float(ip)
    except (TypeError, ValueError):
        return None
    whole = int(val)
    frac = round((val - whole) * 10)
    return whole + (1 / 3 if frac == 1 else 2 / 3 if frac == 2 else 0)


# --- Weather (component e) ----------------------------------------------------
# Same free source the over/under bot already uses (api.weather.gov, no key)
# and the same STADIUMS lat/lon/outDirs + CROSSWIND_DIRS tables from
# ../index.js, ported as-is so wind-direction classification matches exactly.

STADIUMS = {
    'Wrigley Field':                    {'lat': 41.9484, 'lon': -87.6553, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
    'Fenway Park':                      {'lat': 42.3467, 'lon': -71.0972, 'outDirs': ['S', 'SE', 'SSE', 'SW', 'SSW']},
    'Yankee Stadium':                   {'lat': 40.8296, 'lon': -73.9262, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'UNIQLO Field at Dodger Stadium':   {'lat': 34.0739, 'lon': -118.2400, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Dodger Stadium':                   {'lat': 34.0739, 'lon': -118.2400, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Oracle Park':                      {'lat': 37.7786, 'lon': -122.3893, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'Coors Field':                      {'lat': 39.7559, 'lon': -104.9942, 'outDirs': ['E', 'SE', 'ESE', 'NE', 'ENE']},
    'T-Mobile Park':                    {'lat': 47.5914, 'lon': -122.3325, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'Comerica Park':                    {'lat': 42.3390, 'lon': -83.0485, 'outDirs': ['S', 'SE', 'SSE', 'SW', 'SSW']},
    'PNC Park':                         {'lat': 40.4469, 'lon': -80.0057, 'outDirs': ['E', 'NE', 'ENE', 'SE', 'ESE']},
    'Busch Stadium':                    {'lat': 38.6226, 'lon': -90.1928, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'Truist Park':                      {'lat': 33.8908, 'lon': -84.4678, 'outDirs': ['E', 'SE', 'ESE', 'NE', 'ENE']},
    'Great American Ball Park':         {'lat': 39.0979, 'lon': -84.5082, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'Guaranteed Rate Field':            {'lat': 41.8300, 'lon': -87.6339, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
    'Camden Yards':                     {'lat': 39.2838, 'lon': -76.6218, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Oriole Park at Camden Yards':      {'lat': 39.2838, 'lon': -76.6218, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Nationals Park':                   {'lat': 38.8730, 'lon': -77.0074, 'outDirs': ['E', 'SE', 'ESE', 'NE', 'ENE']},
    'Citi Field':                       {'lat': 40.7571, 'lon': -73.8458, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Kauffman Stadium':                 {'lat': 39.0517, 'lon': -94.4803, 'outDirs': ['E', 'NE', 'ENE', 'SE', 'ESE']},
    'Target Field':                     {'lat': 44.9817, 'lon': -93.2781, 'outDirs': ['S', 'SE', 'SSE', 'SW', 'SSW']},
    'Sutter Health Park':               {'lat': 38.5802, 'lon': -121.5014, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
    'Petco Park':                       {'lat': 32.7076, 'lon': -117.1570, 'outDirs': ['W', 'SW', 'WSW', 'NW', 'WNW']},
    'Progressive Field':                {'lat': 41.4962, 'lon': -81.6852, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
    'loanDepot park':                   {'lat': 25.7781, 'lon': -80.2197, 'outDirs': ['E', 'NE', 'ENE', 'SE', 'ESE']},
    'Daikin Park':                      {'lat': 29.7573, 'lon': -95.3555, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
    'Citizens Bank Park':               {'lat': 39.9061, 'lon': -75.1665, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'American Family Field':            {'lat': 43.0280, 'lon': -87.9712, 'outDirs': None},
    'Chase Field':                      {'lat': 33.4453, 'lon': -112.0667, 'outDirs': None},
    'Globe Life Field':                 {'lat': 32.7473, 'lon': -97.0845, 'outDirs': None},
    'Minute Maid Park':                 {'lat': 29.7573, 'lon': -95.3555, 'outDirs': None},
    'Tropicana Field':                  {'lat': 27.7682, 'lon': -82.6534, 'outDirs': None},
    'Rogers Centre':                    {'lat': 43.6414, 'lon': -79.3894, 'outDirs': None},
    'Angel Stadium':                    {'lat': 33.8003, 'lon': -117.8827, 'outDirs': ['N', 'NW', 'NNW', 'NE', 'NNE']},
    'Rate Field':                       {'lat': 41.8300, 'lon': -87.6339, 'outDirs': ['S', 'SW', 'SSW', 'SE', 'SSE']},
}

CROSSWIND_DIRS = {
    'Wrigley Field':               ['E', 'W', 'ESE', 'WNW', 'ENE', 'WSW'],
    'Fenway Park':                 ['E', 'W', 'ESE', 'WNW', 'ENE', 'WSW'],
    'Yankee Stadium':              ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
    'Coors Field':                 ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
    'Comerica Park':               ['E', 'W', 'ESE', 'WNW', 'ENE', 'WSW'],
    'Truist Park':                 ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
    'Camden Yards':                ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
    'Oriole Park at Camden Yards': ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
    'Citi Field':                  ['N', 'S', 'NNE', 'SSW', 'NNW', 'SSE'],
}


def _http_get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'nrfi-model/1.0 (research use)'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def get_weather(lat, lon):
    try:
        points = _http_get_json(f'https://api.weather.gov/points/{lat},{lon}')
        forecast_url = points['properties']['forecastHourly']
        forecast = _http_get_json(forecast_url)
        periods = forecast['properties']['periods'][:6]
        temps = [p['temperature'] for p in periods]
        winds = []
        for p in periods:
            digits = ''.join(ch for ch in p['windSpeed'] if ch.isdigit())
            winds.append(int(digits) if digits else 0)
        return {
            'avgTemp': round(sum(temps) / len(temps)),
            'maxWind': max(winds),
            'windDir': periods[0]['windDirection'],
            'condition': periods[0]['shortForecast'],
        }
    except Exception:
        return None


def weather_multiplier(venue, weather):
    stadium = STADIUMS.get(venue)
    if not stadium or stadium.get('outDirs') is None:
        return 1.0, {'applied': False, 'reason': 'dome or unknown venue'}
    if not weather:
        # NWS has no historical forecast archive, so backtests always land
        # here (weather=None) — v1 skips weather for those rather than
        # inventing a retroactive forecast.
        return 1.0, {'applied': False, 'reason': 'no weather data available'}

    mult = 1.0
    notes = []

    if weather['avgTemp'] > 85:
        mult *= 1.05
        notes.append(f"temp {weather['avgTemp']}F > 85F -> x1.05")

    is_out = weather['windDir'] in stadium['outDirs']
    is_cross = weather['windDir'] in CROSSWIND_DIRS.get(venue, [])
    is_in = not is_out and not is_cross

    if weather['maxWind'] > 10 and is_out:
        mult *= 1.07
        notes.append(f"wind out {weather['maxWind']}mph {weather['windDir']} -> x1.07")
    elif weather['maxWind'] > 10 and is_in:
        mult *= 0.95
        notes.append(f"wind in {weather['maxWind']}mph {weather['windDir']} -> x0.95")

    return mult, {'applied': True, 'notes': notes, 'raw': weather}


# --- Park factor (component d) ------------------------------------------------
# Hand-set, hardcoded per the model spec — these are first-inning-scaled
# (narrower band than full-game park factors, since a single inning is far
# less exposed to the bullpen/fatigue/wind-drift effects that build up over
# 9 innings).
# TODO: replace with computed first-inning-specific factors once a full
# season of linescores is cached — same approach as lambda0 and the
# league-average FIP/OBP below (team first-inning runs at that venue /
# league-average first-inning runs), instead of this hand-set table.
PARK_FACTORS_FIRST_INNING = {
    'Coors Field': 1.25,
    'Great American Ball Park': 1.10,
    'Fenway Park': 1.08,
    'Chase Field': 1.07,
    'Oriole Park at Camden Yards': 1.06,
    'Camden Yards': 1.06,
    'Citizens Bank Park': 1.05,
    'Yankee Stadium': 1.05,
    'Globe Life Field': 1.03,
    'Rogers Centre': 1.03,
    'Truist Park': 1.02,
    'American Family Field': 1.02,
    'PNC Park': 1.02,
    'Minute Maid Park': 1.01,
    'Daikin Park': 1.01,
    'Busch Stadium': 1.00,
    'Kauffman Stadium': 1.00,
    'Nationals Park': 1.00,
    'Guaranteed Rate Field': 0.99,
    'Rate Field': 0.99,
    'Citi Field': 0.98,
    'Progressive Field': 0.98,
    'Angel Stadium': 0.97,
    'Target Field': 0.97,
    'loanDepot park': 0.96,
    'Sutter Health Park': 0.96,
    'Tropicana Field': 0.95,
    'T-Mobile Park': 0.95,
    'Dodger Stadium': 0.94,
    'UNIQLO Field at Dodger Stadium': 0.94,
    'Petco Park': 0.93,
    'Oracle Park': 0.92,
}
DEFAULT_PARK_FACTOR = 1.00


def park_factor_multiplier(venue):
    factor = PARK_FACTORS_FIRST_INNING.get(venue, DEFAULT_PARK_FACTOR)
    return factor, {'applied': venue in PARK_FACTORS_FIRST_INNING, 'venue': venue, 'factor': factor}


# --- Pitcher skill (component a) ---------------------------------------------
# Approximate modern-era distribution of starter K%/BB% used only as a minor
# z-score modifier on top of the FIP-driven multiplier. True per-season
# stdevs would require pulling every qualified starter's individual line
# (a much bigger data pull for a component the spec calls "minor") — these
# published sabermetric benchmarks are close enough for that role.
LEAGUE_K_PCT_MEAN = 0.225
LEAGUE_K_PCT_STDEV = 0.045
LEAGUE_BB_PCT_MEAN = 0.082
LEAGUE_BB_PCT_STDEV = 0.025


def pitcher_skill_multiplier(season_stats, league_fip):
    if not season_stats or season_stats.get('fip') is None or not league_fip:
        return 1.0, {'applied': False, 'reason': 'missing season stats or league FIP'}

    fip_ratio = season_stats['fip'] / league_fip
    skill_mult = fip_ratio ** 0.7

    k_pct = season_stats.get('kPercent')
    bb_pct = season_stats.get('bbPercent')
    z_k = ((k_pct - LEAGUE_K_PCT_MEAN) / LEAGUE_K_PCT_STDEV) if k_pct is not None else 0.0
    z_bb = ((bb_pct - LEAGUE_BB_PCT_MEAN) / LEAGUE_BB_PCT_STDEV) if bb_pct is not None else 0.0
    z_k = max(-3.0, min(3.0, z_k))
    z_bb = max(-3.0, min(3.0, z_bb))

    # Minor modifier: ~3% lambda swing per standard deviation of K%/BB%,
    # layered on top of (not replacing) the FIP-driven skill multiplier.
    kbb_mult = 1 - 0.03 * z_k + 0.03 * z_bb

    total = skill_mult * kbb_mult
    return total, {
        'applied': True,
        'fip': season_stats['fip'],
        'league_fip': league_fip,
        'fip_ratio': fip_ratio,
        'skill_multiplier': skill_mult,
        'k_pct': k_pct,
        'bb_pct': bb_pct,
        'z_k': z_k,
        'z_bb': z_bb,
        'kbb_multiplier': kbb_mult,
    }


# --- Pitcher multi-season first-inning tendency (component b) ---------------

MIN_CAREER_FIRST_INNINGS = 40
FIRST_INNING_REGRESSION = 0.60  # fraction of the raw deviation regressed away


def first_inning_tendency_multiplier(pitcher_id, first_inning_splits, date_str):
    if not first_inning_splits:
        return 1.0, {'applied': False, 'reason': 'no first-inning splits data'}

    total_fi_ip = 0.0
    total_fi_er = 0.0
    for season_data in first_inning_splits.values():
        if not season_data:
            continue
        ip = ip_to_decimal(season_data.get('inningsPitched'))
        er = season_data.get('earnedRuns')
        if ip is None or er is None:
            continue
        total_fi_ip += ip
        total_fi_er += er

    if total_fi_ip < MIN_CAREER_FIRST_INNINGS:
        return 1.0, {
            'applied': False,
            'reason': f'only {total_fi_ip:.1f} career first innings in data (<{MIN_CAREER_FIRST_INNINGS} minimum)',
        }

    # Compare against the pitcher's own overall rate across the SAME seasons
    # the first-inning splits span, not just the current season, for an
    # apples-to-apples multi-year comparison.
    seasons = [int(s) for s in first_inning_splits.keys()]
    total_overall_ip = 0.0
    total_overall_er = 0.0
    for yr in seasons:
        stats = get_season_pitching_stats(pitcher_id, yr, date_str)
        if not stats or stats.get('era') is None or stats.get('inningsPitched') is None:
            continue
        ip = ip_to_decimal(stats['inningsPitched'])
        if not ip:
            continue
        total_overall_ip += ip
        total_overall_er += stats['era'] * ip / 9

    if total_overall_ip == 0:
        return 1.0, {'applied': False, 'reason': 'no multi-season overall stats available'}

    fi_rate = total_fi_er / total_fi_ip
    overall_rate = total_overall_er / total_overall_ip
    if overall_rate <= 0:
        return 1.0, {'applied': False, 'reason': 'overall rate is zero/unavailable'}

    raw_deviation = fi_rate - overall_rate
    # First-inning ERA in a single season is noise (r^2 ~ 0.003 year over
    # year) even at 40+ IP, so most of the raw deviation is regressed away —
    # only (1 - FIRST_INNING_REGRESSION) of it is kept.
    regressed_deviation = raw_deviation * (1 - FIRST_INNING_REGRESSION)
    regressed_fi_rate = overall_rate + regressed_deviation
    multiplier = regressed_fi_rate / overall_rate

    return multiplier, {
        'applied': True,
        'career_first_inning_ip': total_fi_ip,
        'first_inning_rate': fi_rate,
        'overall_rate': overall_rate,
        'raw_deviation': raw_deviation,
        'regressed_deviation': regressed_deviation,
        'multiplier': multiplier,
    }


# --- Opposing offense (component c) ------------------------------------------

TEAM_RATE_REGRESSION = 0.40  # fraction of team rate pulled toward league average
LINEUP_OBP_SENSITIVITY = 1.0


def offense_multiplier(team_id, team_run_rates, league_avg_fi_runs, lineup, league_avg_obp, season, date_str):
    if league_avg_fi_runs is None or not team_run_rates:
        return 1.0, {'applied': False, 'reason': 'no league/team first-inning run rate data'}

    team_rate = team_run_rates.get(str(team_id))
    if team_rate is None:
        return 1.0, {'applied': False, 'reason': f'no first-inning run rate for team {team_id}'}

    regressed_rate = team_rate * (1 - TEAM_RATE_REGRESSION) + league_avg_fi_runs * TEAM_RATE_REGRESSION
    base_mult = regressed_rate / league_avg_fi_runs if league_avg_fi_runs else 1.0

    lineup_mult = 1.0
    lineup_note = 'no confirmed lineup'
    if lineup and len(lineup) >= 2 and league_avg_obp:
        obps = []
        for hitter in lineup[:2]:
            stats = get_season_hitting_stats(hitter['id'], season, date_str)
            if stats and stats.get('obp') is not None:
                obps.append(stats['obp'])
        if obps:
            avg_obp = sum(obps) / len(obps)
            obp_diff = avg_obp - league_avg_obp
            lineup_mult = max(0.90, min(1.10, 1 + obp_diff * LINEUP_OBP_SENSITIVITY))
            lineup_note = f'1-2 hitter avg OBP {avg_obp:.3f} vs league {league_avg_obp:.3f}'

    total = base_mult * lineup_mult
    return total, {
        'applied': True,
        'team_first_inning_run_rate': team_rate,
        'league_avg_first_inning_runs': league_avg_fi_runs,
        'regressed_rate': regressed_rate,
        'base_multiplier': base_mult,
        'lineup_multiplier': lineup_mult,
        'lineup_note': lineup_note,
    }


# --- Per-half-inning lambda + full-game orchestration ------------------------

def compute_lambda(batting_team_id, pitcher_id, pitcher_name, venue, lambda0, league_fip, league_avg_obp,
                    team_run_rates, lineup, season, date_str, weather=None):
    components = {}
    lam = lambda0

    season_stats = get_season_pitching_stats(pitcher_id, season, date_str) if pitcher_id else None
    first_inning_splits = get_first_inning_splits(pitcher_id, season, date_str) if pitcher_id else None

    mult_a, info_a = pitcher_skill_multiplier(season_stats, league_fip)
    lam *= mult_a
    components['pitcher_skill'] = {'multiplier': mult_a, **info_a}

    mult_b, info_b = first_inning_tendency_multiplier(pitcher_id, first_inning_splits, date_str)
    lam *= mult_b
    components['pitcher_first_inning_tendency'] = {'multiplier': mult_b, **info_b}

    mult_c, info_c = offense_multiplier(batting_team_id, team_run_rates, lambda0, lineup, league_avg_obp, season, date_str)
    lam *= mult_c
    components['opposing_offense'] = {'multiplier': mult_c, **info_c}

    mult_d, info_d = park_factor_multiplier(venue)
    lam *= mult_d
    components['park_factor'] = {'multiplier': mult_d, **info_d}

    mult_e, info_e = weather_multiplier(venue, weather)
    lam *= mult_e
    components['weather'] = {'multiplier': mult_e, **info_e}

    return lam, {
        'lambda0': lambda0,
        'final_lambda': lam,
        'pitcher_id': pitcher_id,
        'pitcher_name': pitcher_name,
        'batting_team_id': batting_team_id,
        'venue': venue,
        'components': components,
    }


def compute_game_nrfi(game, lambda0, league_fip, league_avg_obp, team_run_rates, season, date_str, weather=None):
    # Away team bats top of the 1st, facing the home starter.
    lambda_away, away_detail = compute_lambda(
        batting_team_id=game['awayTeamId'], pitcher_id=game['homePitcherId'], pitcher_name=game['homePitcherName'],
        venue=game['venue'], lambda0=lambda0, league_fip=league_fip, league_avg_obp=league_avg_obp,
        team_run_rates=team_run_rates, lineup=game.get('awayLineup'), season=season, date_str=date_str, weather=weather,
    )
    # Home team bats bottom of the 1st, facing the away starter.
    lambda_home, home_detail = compute_lambda(
        batting_team_id=game['homeTeamId'], pitcher_id=game['awayPitcherId'], pitcher_name=game['awayPitcherName'],
        venue=game['venue'], lambda0=lambda0, league_fip=league_fip, league_avg_obp=league_avg_obp,
        team_run_rates=team_run_rates, lineup=game.get('homeLineup'), season=season, date_str=date_str, weather=weather,
    )

    p_nrfi = math.exp(-(lambda_away + lambda_home))

    return {
        'gamePk': game.get('gamePk'),
        'matchup': f"{game.get('awayTeamName')} @ {game.get('homeTeamName')}",
        'venue': game.get('venue'),
        'p_nrfi': p_nrfi,
        'lambda_away': lambda_away,
        'lambda_home': lambda_home,
        'components': {
            'away_batting': away_detail,   # away hitters vs home pitcher
            'home_batting': home_detail,   # home hitters vs away pitcher
        },
    }


def build_today_predictions(date_str):
    season = int(date_str[:4])
    schedule = get_schedule(date_str)

    league_fip = get_league_average_fip(season, date_str)
    league_avg_obp = get_league_average_obp(season, date_str)
    print(f"League-average FIP ({season}): {league_fip:.3f}" if league_fip else "League-average FIP unavailable")
    print(f"League-average OBP ({season}): {league_avg_obp:.3f}" if league_avg_obp else "League-average OBP unavailable")

    rates = compute_season_nrfi_rates(season, date_str)
    team_run_rates = rates.get('teamFirstInningRunRates', {})
    lambda0 = rates.get('lambda0')
    if lambda0 is None:
        print('WARNING: could not calibrate lambda0 from season linescore data — falling back to 0.33 baseline.')
        lambda0 = 0.33

    predictions = []
    for game in schedule:
        weather = None
        stadium = STADIUMS.get(game['venue'])
        if stadium and stadium.get('outDirs') is not None:
            weather = get_weather(stadium['lat'], stadium['lon'])

        predictions.append(compute_game_nrfi(game, lambda0, league_fip, league_avg_obp, team_run_rates, season, date_str, weather=weather))

    return predictions


# --- Backtest harness ---------------------------------------------------------

def backtest(end_date_str=None, days=30):
    end_date = date.fromisoformat(end_date_str) if end_date_str else date.today()
    start_date = end_date - timedelta(days=days)
    season = end_date.year

    league_fip = get_league_average_fip(season, end_date.isoformat())
    league_avg_obp = get_league_average_obp(season, end_date.isoformat())
    rates = compute_season_nrfi_rates(season, end_date.isoformat())
    team_run_rates = rates.get('teamFirstInningRunRates', {})
    lambda0 = rates.get('lambda0') or 0.33

    predictions = []
    outcomes = []

    d = start_date
    while d <= end_date:
        date_str = d.isoformat()
        games = get_schedule(date_str)
        for game in games:
            if game['homePitcherId'] is None or game['awayPitcherId'] is None:
                continue
            linescore = get_linescore(game['gamePk'], date_str)
            actual = is_nrfi(linescore)
            if actual is None:
                continue  # not final / postponed / no linescore yet

            result = compute_game_nrfi(game, lambda0, league_fip, league_avg_obp, team_run_rates, season, date_str, weather=None)
            predictions.append(result['p_nrfi'])
            outcomes.append(1 if actual else 0)
        d += timedelta(days=1)

    n = len(predictions)
    if n == 0:
        print('No completed games with probable-pitcher data found in the backtest window.')
        return

    brier = sum((p - o) ** 2 for p, o in zip(predictions, outcomes)) / n
    print(f"\nBacktest: {n} games, {start_date.isoformat()} to {end_date.isoformat()}")
    print(f"Brier score: {brier:.4f}\n")
    print(f"{'Bucket':<10} {'N':>5} {'Predicted avg':>15} {'Actual NRFI %':>15}")

    flagged = []
    for lo in range(0, 100, 5):
        hi = lo + 5
        bucket = [(p, o) for p, o in zip(predictions, outcomes) if lo / 100 <= p < hi / 100]
        if not bucket:
            continue
        avg_pred = sum(p for p, _ in bucket) / len(bucket)
        actual_rate = sum(o for _, o in bucket) / len(bucket)
        print(f"{lo:>3}-{hi:<3}%  {len(bucket):>5} {avg_pred * 100:>14.1f}% {actual_rate * 100:>14.1f}%")
        if lo >= 60 and actual_rate <= 0.55:
            flagged.append((lo, hi, avg_pred, actual_rate))

    if flagged:
        print("\nCALIBRATION WARNING: model overconfident in the following 60%+ bucket(s):")
        for lo, hi, avg_pred, actual_rate in flagged:
            print(f"  {lo}-{hi}% bucket predicted {avg_pred * 100:.1f}% avg but only hit {actual_rate * 100:.1f}% actual (<=55%)")
    else:
        print("\nCalibration OK: no 60%+ bucket underperformed the 55% actual threshold.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Poisson NRFI probability model')
    sub = parser.add_subparsers(dest='command', required=True)

    today_p = sub.add_parser('today', help="Print NRFI probabilities for a date's slate")
    today_p.add_argument('date', nargs='?', default=date.today().isoformat())

    bt_p = sub.add_parser('backtest', help='Backtest calibration over the last N days of completed games')
    bt_p.add_argument('--days', type=int, default=30)
    bt_p.add_argument('--end-date', default=None)

    args = parser.parse_args()

    if args.command == 'today':
        print(json.dumps(build_today_predictions(args.date), indent=2))
    elif args.command == 'backtest':
        backtest(end_date_str=args.end_date, days=args.days)
