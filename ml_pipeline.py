"""
CS/DS 3262 Final Project — TikTok Binge-Session Classifier
Feature extraction from TikTok personal data export + supervised ML pipeline.

Target: binary label "binge" per session (top-10% daily volume AND >= 2x user median)
Unit:   session (contiguous events separated by < 30-minute gaps)
"""

import json
import zipfile
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from pathlib import Path

from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.model_selection import StratifiedKFold, cross_validate
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import (
    accuracy_score, f1_score, precision_score, recall_score, roc_auc_score,
    make_scorer
)
import warnings
warnings.filterwarnings("ignore")

# ── 1. LOAD DATA ─────────────────────────────────────────────────────────────

ZIP_PATH = Path("TikTok_Data_1776821537.zip")

def load_export(zip_path: Path) -> dict:
    with zipfile.ZipFile(zip_path) as z:
        with z.open("user_data_tiktok.json") as f:
            return json.load(f)

data = load_export(ZIP_PATH)
act  = data["Your Activity"]
laf  = data["Likes and Favorites"]

# ── 2. PARSE EVENTS ──────────────────────────────────────────────────────────

DATE_FMT = "%Y-%m-%d %H:%M:%S"

def parse_date(s: str):
    try:
        return datetime.strptime(s.strip(), DATE_FMT)
    except Exception:
        return None

def collect_events() -> pd.DataFrame:
    rows = []

    def add(source: str, primitive: str, records: list, date_key="Date", extra=None):
        for r in records:
            ts = parse_date(r.get(date_key, "") or r.get("date", ""))
            if ts:
                row = {"ts": ts, "source": source, "primitive": primitive}
                if extra:
                    row.update({k: r.get(k) for k in extra if r.get(k)})
                rows.append(row)

    # Watch
    add("watch", "attention",
        act.get("Watch History", {}).get("VideoList", []))

    # Searches
    add("search", "intent",
        act.get("Searches", {}).get("SearchList", []),
        extra=["SearchTerm"])

    # Likes
    add("like", "preference",
        laf.get("Likes", {}).get("ItemFavoriteList", []),
        date_key="date")

    # Favorite videos
    add("favorite_video", "preference",
        laf.get("Favorite Videos", {}).get("FavoriteVideoList", []))

    # Favorite sounds
    add("favorite_sound", "preference",
        laf.get("Favorite Sounds", {}).get("FavoriteSoundList", []))

    # Shares
    add("share", "social",
        act.get("Share History", {}).get("ShareHistoryList", []),
        extra=["Method"])

    # Reposts
    add("repost", "social",
        act.get("Reposts", {}).get("RepostList", []))

    # Comments
    add("comment", "social",
        data.get("Comment", {}).get("Comments", {}).get("CommentsList", []),
        extra=["Comment"])

    df = pd.DataFrame(rows).sort_values("ts").reset_index(drop=True)
    return df

events = collect_events()
print(f"Total dated events: {len(events):,}")
print(events["primitive"].value_counts())

# ── 3. SESSION SEGMENTATION ───────────────────────────────────────────────────

SESSION_GAP = timedelta(minutes=30)

def assign_sessions(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy().sort_values("ts").reset_index(drop=True)
    session_ids = [0]
    for i in range(1, len(df)):
        gap = df.loc[i, "ts"] - df.loc[i-1, "ts"]
        session_ids.append(session_ids[-1] + (1 if gap > SESSION_GAP else 0))
    df["session_id"] = session_ids
    return df

events = assign_sessions(events)
print(f"Total sessions: {events['session_id'].nunique():,}")

# ── 4. FEATURE EXTRACTION ─────────────────────────────────────────────────────

def extract_session_features(grp: pd.DataFrame) -> dict:
    n         = len(grp)
    duration  = (grp["ts"].max() - grp["ts"].min()).total_seconds() / 60.0
    start     = grp["ts"].min()

    watch_share   = (grp["primitive"] == "attention").mean()
    search_share  = (grp["source"] == "search").mean()
    social_share  = (grp["primitive"] == "social").mean()
    pref_share    = (grp["primitive"] == "preference").mean()

    # Peak rate: events per minute (avoid div/0 for single-event sessions)
    peak_epm = n / max(duration, 1.0)

    # Search-to-watch cascade: watches that follow a search within the session
    sorted_prims = grp.sort_values("ts")["source"].tolist()
    cascade_count = 0
    last_search = False
    for src in sorted_prims:
        if src == "search":
            last_search = True
        elif src == "watch" and last_search:
            cascade_count += 1
            last_search = False

    return {
        "session_id":       grp["session_id"].iloc[0],
        "date":             start.date(),
        "event_count":      n,
        "duration_min":     duration,
        "peak_epm":         round(peak_epm, 4),
        "watch_share":      watch_share,
        "search_share":     search_share,
        "social_share":     social_share,
        "pref_share":       pref_share,
        "cascade_count":    cascade_count,
        "hour_of_day":      start.hour,
        "day_of_week":      start.weekday(),   # 0=Mon
        "has_search":       int(search_share > 0),
        "has_social":       int(social_share > 0),
    }

sessions = pd.DataFrame([
    extract_session_features(grp)
    for _, grp in events.groupby("session_id")
])

print(f"\nSession stats:\n{sessions[['event_count','duration_min']].describe().round(2)}")

# ── 5. BINGE LABEL ────────────────────────────────────────────────────────────

# Daily event totals
daily_counts = events.groupby(events["ts"].dt.date).size()
top10_threshold = daily_counts.quantile(0.90)
median_daily    = daily_counts.median()

print(f"\nDaily event counts — median: {median_daily:.0f}, 90th pct: {top10_threshold:.0f}")

binge_days = set(
    daily_counts[
        (daily_counts >= top10_threshold) &
        (daily_counts >= 2 * median_daily)
    ].index
)
print(f"Binge days: {len(binge_days)} / {len(daily_counts)} total days")

sessions["binge"] = sessions["date"].apply(lambda d: int(d in binge_days))
print(f"\nLabel distribution:\n{sessions['binge'].value_counts()}")
print(f"Binge rate: {sessions['binge'].mean():.1%}")

# ── 6. ML PIPELINE ───────────────────────────────────────────────────────────

FEATURE_COLS = [
    "event_count", "duration_min", "peak_epm",
    "watch_share", "search_share", "social_share", "pref_share",
    "cascade_count", "hour_of_day", "day_of_week",
    "has_search", "has_social",
]

X = sessions[FEATURE_COLS].values
y = sessions["binge"].values

def auc_scorer(clf, X, y):
    proba = clf.predict_proba(X)[:, 1]
    return roc_auc_score(y, proba)

scoring = {
    "accuracy":  make_scorer(accuracy_score),
    "f1":        make_scorer(f1_score, zero_division=0),
    "precision": make_scorer(precision_score, zero_division=0),
    "recall":    make_scorer(recall_score, zero_division=0),
    "roc_auc":   auc_scorer,
}

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)

models = {
    "Logistic Regression": Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
    ]),
    "Random Forest": Pipeline([
        ("clf", RandomForestClassifier(n_estimators=200, class_weight="balanced", random_state=42)),
    ]),
    "Gradient Boosted Trees": Pipeline([
        ("scaler", StandardScaler()),
        ("clf", GradientBoostingClassifier(n_estimators=200, learning_rate=0.05, random_state=42)),
    ]),
}

# ── 7. EVALUATE ──────────────────────────────────────────────────────────────

print("\n" + "="*70)
print(f"{'Model':<26} {'Acc':>6} {'F1':>6} {'Prec':>6} {'Rec':>6} {'AUC':>6}")
print("="*70)

results = {}
for name, model in models.items():
    cv_results = cross_validate(model, X, y, cv=cv, scoring=scoring, n_jobs=-1)
    results[name] = {k: cv_results[f"test_{k}"] for k in scoring}
    means = {k: v.mean() for k, v in results[name].items()}
    print(
        f"{name:<26} "
        f"{means['accuracy']:>6.3f} "
        f"{means['f1']:>6.3f} "
        f"{means['precision']:>6.3f} "
        f"{means['recall']:>6.3f} "
        f"{means['roc_auc']:>6.3f}"
    )

print("="*70)
print("(5-fold stratified CV means)")

# ── 8. FEATURE IMPORTANCE (Random Forest) ────────────────────────────────────

from sklearn.pipeline import Pipeline as SKPipeline

rf_model = models["Random Forest"]
rf_model.fit(X, y)
importances = rf_model.named_steps["clf"].feature_importances_
fi = pd.Series(importances, index=FEATURE_COLS).sort_values(ascending=False)
print("\nRandom Forest Feature Importances:")
print(fi.round(4).to_string())

# ── 9. DETAILED FOLD RESULTS ─────────────────────────────────────────────────

print("\n── Per-fold detail ──")
for name, folds in results.items():
    print(f"\n{name}:")
    for metric, vals in folds.items():
        print(f"  {metric:<12}: {' '.join(f'{v:.3f}' for v in vals)}  (mean={vals.mean():.3f}, std={vals.std():.3f})")
