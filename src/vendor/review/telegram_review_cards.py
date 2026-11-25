"""Local Telegram review database compatibility functions from YonClaw Toolkit."""
import json
from datetime import datetime, timezone

from review_semantics import HKT, validate_revision
from review_semantics import normalize_observation as normalize_review_observation


def ensure_memory_schema(con):
    con.execute("""CREATE TABLE IF NOT EXISTS telegram_review_memory (
        approval_key TEXT PRIMARY KEY, details TEXT NOT NULL)""")
    con.execute("""CREATE TABLE IF NOT EXISTS telegram_review_observations (
        approval_key TEXT NOT NULL, day TEXT NOT NULL, details TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY (approval_key, day, details))""")


def publication_time(job):
    if job and job["phase"] == "published" and job["updated"] > 0:
        return datetime.fromtimestamp(job["updated"], timezone.utc)
    return None


def normalize_observation(data, now):
    return normalize_review_observation(data, now, identity_field="approval_key")


def record_observations(con, source, items):
    if not isinstance(items, list):
        raise ValueError("review JSON must contain an observations array")
    recorded = 0
    for item in items:
        now = datetime.now(timezone.utc)
        observation = normalize_observation(item, now)
        key, day = observation["approval_key"], observation["day"]
        job = con.execute("""SELECT e.phase,e.sha,e.updated
            FROM telegram_product_review_cards c JOIN telegram_review_memory m USING (approval_key)
            LEFT JOIN telegram_review_execution e USING (approval_key)
            WHERE c.source=? AND c.approval_key=?""", (source, key)).fetchone()
        if not job:
            raise ValueError(f"{key}: observations require a linked card on this Telegram route")
        details = json.dumps(observation, ensure_ascii=False, sort_keys=True)
        previous = con.execute("""SELECT details,recorded_at FROM telegram_review_observations
            WHERE approval_key=? AND day=? ORDER BY rowid DESC""", (key, day)).fetchall()
        if any(row["details"] == details for row in previous):
            continue
        validate_revision(observation, previous, key)
        eligible, affected = observation["eligible"], observation["affected"]
        if eligible is not None or affected is not None:
            published = publication_time(job)
            if published is None:
                raise ValueError(f"{key}: measured observations require confirmed publication")
            published_day = published.astimezone(HKT).date().isoformat()
            at = observation.get("observed_at")
            if (day < published_day or (day == published_day and at is None)
                    or (at is not None and datetime.fromisoformat(at) < published)):
                raise ValueError(f"{key}: measured observations must cover time after publication")
        if (eligible or 0) > 0 or (affected or 0) > 0:
            version = observation["version"]
            if not version or (version != job["sha"] and not observation.get("exposure_evidence")):
                raise ValueError(f"{key}: positive exposure requires the observed published SHA or a version with exposure_evidence")
        con.execute("INSERT INTO telegram_review_observations VALUES (?,?,?,?)",
                    (key, day, details, now.isoformat()))
        recorded += 1
    return {"source": source, "recorded": recorded, "replayed": len(items) - recorded}


def history(con, source, problem_id=None):
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    memory = {}
    if "telegram_review_memory" in tables:
        memory = {row["approval_key"]: json.loads(row["details"]) for row in con.execute("""
            SELECT m.* FROM telegram_review_memory m JOIN telegram_product_review_cards c USING (approval_key)
            WHERE c.source=?""", (source,))}
    observations = {}
    if "telegram_review_observations" in tables:
        for row in con.execute("""SELECT o.* FROM telegram_review_observations o
            JOIN telegram_product_review_cards c USING (approval_key)
            WHERE c.source=? ORDER BY o.day,o.rowid""", (source,)):
            entry = json.loads(row["details"])
            entry["recorded_at"] = row["recorded_at"]
            observations.setdefault(row["approval_key"], {}).setdefault(row["day"], []).append(entry)

    jobs = {}
    if "telegram_review_execution" in tables:
        jobs = {row["approval_key"]: row for row in con.execute("""
            SELECT e.* FROM telegram_review_execution e JOIN telegram_product_review_cards c USING (approval_key)
            WHERE c.source=?""", (source,))}
    problems, unlinked = {}, []
    for row in con.execute("""SELECT s.*,c.source,c.remote_session AS batch,c.created_hkt AS created_at,c.card_text
        FROM telegram_product_review_status s JOIN telegram_product_review_cards c USING (approval_key)
        WHERE c.source=? ORDER BY c.created_hkt,c.rowid""", (source,)):
        key = row["approval_key"]
        details, job = memory.get(key), jobs.get(key)
        if problem_id is not None and (details is None or details["problem_id"] != problem_id):
            continue
        if details is None and not (row["batch"] or job):
            continue
        attempt = dict(row)
        attempt["title"] = row["card_text"].split("\n\n", 1)[0]
        attempt["memory"] = details
        attempt["observations"] = [
            dict(revisions[-1], prior_revisions=revisions[:-1])
            for revisions in observations.get(key, {}).values()
        ]
        if job:
            published = publication_time(job)
            attempt["execution"] = {
                "spec": json.loads(job["spec"]), "phase": job["phase"], "detail": job["detail"], "sha": job["sha"],
                "published_at": published.isoformat() if published else None,
            }
        if details:
            problems.setdefault(details["problem_id"], []).append(attempt)
        else:
            unlinked.append(attempt)
    return {"source": source, "problems": [{"problem_id": key, "attempts": attempts}
                                           for key, attempts in problems.items()], "unlinked": unlinked}
