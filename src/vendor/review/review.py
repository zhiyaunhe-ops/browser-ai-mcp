#!/usr/bin/env python3
"""Read review history, validate evaluations and record follow-up observations."""
import argparse
import json
import os
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import telegram_review_cards as telegram
from review_domain import resolve_domain
from review_semantics import (
    HKT,
    EvaluationError,
    normalize_assessment,
    normalize_memory,
    normalize_observation,
    required_text,
    validate_revision,
)


SOURCES = ("browser", "telegram")


def state_file(browser_path, filename):
    local = browser_path.parent / filename
    legacy = Path.home() / "yonclaw-toolkit" / "runtime" / "data" / filename
    return legacy if not local.exists() and legacy.is_file() else local


def db_paths(telegram_db, browser_db, review_db):
    browser_path = Path(browser_db or Path(os.environ.get("BROWSER_AI_DATA_DIR") or
                        Path.home() / ".browser-ai") / "browser-ai.sqlite").expanduser()
    telegram_path = telegram_db or os.environ.get("TELEGRAM_REVIEW_DB") or state_file(browser_path, "tasks.sqlite3")
    review_path = review_db or os.environ.get("REVIEW_DB") or state_file(browser_path, "review.sqlite3")
    return Path(telegram_path).expanduser(), browser_path, Path(review_path).expanduser()


@contextmanager
def database(path, mode="ro"):
    con = sqlite3.connect(path.resolve().as_uri() + f"?mode={mode}", uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        with con:
            con.execute("BEGIN" if mode == "ro" else "BEGIN IMMEDIATE")
            yield con
    finally:
        con.close()


def table_exists(con, table):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def require_browser_log(con):
    count = con.execute("""SELECT count(*) FROM sqlite_master WHERE type='view'
        AND name IN ('browser_review_attempts_v1', 'browser_review_evidence_v1')""").fetchone()[0]
    if count != 2:
        raise ValueError("Open this database once with the updated Browser MCP to initialize its review log views.")


def telegram_attempts(path, problem_id):
    if not path.is_file():
        return
    with database(path) as con:
        if not table_exists(con, "telegram_review_channels"):
            return
        for row in con.execute("SELECT source FROM telegram_review_channels ORDER BY source"):
            result = telegram.history(con, row["source"], problem_id)
            for entry in result["problems"]:
                for attempt in entry["attempts"]:
                    yield dict(attempt, source="telegram", route=row["source"], attempt_id=attempt["approval_key"],
                               problem_id=entry["problem_id"], assessment=None, memory_origin="telegram")
            for attempt in result["unlinked"]:
                yield dict(attempt, source="telegram", route=row["source"], attempt_id=attempt["approval_key"],
                           problem_id=None, assessment=None, memory_origin=None)


def browser_timestamp(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc)


def attempt_order(attempt):
    created = datetime.fromisoformat(attempt["created_at"])
    if created.tzinfo is None:
        created = created.replace(tzinfo=HKT)
    return created, attempt["source"], attempt["attempt_id"]


def evidence_refs(con, run_id, assessment):
    references = dict.fromkeys(assessment["evidenceIds"])
    references.update(dict.fromkeys(assessment.get("toolChoice", {}).get("evidenceIds", [])))
    for criterion in assessment["criterionResults"]:
        references.update(dict.fromkeys(criterion["evidenceIds"]))
    evidence = []
    for ref in references:
        row = con.execute("""SELECT id,kind,execution_id,observed_at,sequence
            FROM browser_review_evidence_v1 WHERE run_id=? AND id=?""", (run_id, ref)).fetchone()
        if row:
            evidence.append(dict(row))
    return evidence


def followups(path, attempt_ids):
    if not attempt_ids or not path.is_file():
        return {}
    observations = {}
    with database(path) as con:
        if not table_exists(con, "review_observations"):
            return {}
        for row in con.execute("SELECT * FROM review_observations WHERE source='browser' ORDER BY day,rowid"):
            if row["attempt_id"] in attempt_ids:
                entry = dict(json.loads(row["details"]), recorded_at=row["recorded_at"])
                observations.setdefault(row["attempt_id"], {}).setdefault(row["day"], []).append(entry)
    return {key: [dict(revisions[-1], prior_revisions=revisions[:-1]) for revisions in days.values()]
            for key, days in observations.items()}


def browser_attempts(path, observations_path, problem_id, attempt_id):
    if not path.is_file():
        return
    attempts = []
    with database(path) as con:
        require_browser_log(con)
        has_domains = con.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name='browser_review_domains_v1'").fetchone()
        domain_join = "LEFT JOIN browser_review_domains_v1 USING(attempt_id)" if has_domains else ""
        domain_column = "domain_tag" if has_domains else "NULL"
        rows = con.execute(f"""SELECT attempt_id,run_id,submitted_at,title,criteria,handoff,assessment,preregistered_memory,
            {domain_column} AS product_domain FROM browser_review_attempts_v1 {domain_join}
            WHERE (? IS NULL OR attempt_id=?) ORDER BY submitted_at,attempt_id""", (attempt_id, attempt_id))
        for row in rows:
            review = json.loads(row["assessment"])
            memory = review.get("memory")
            if memory is None and row["preregistered_memory"] is not None:
                memory = json.loads(row["preregistered_memory"])
            origin = review.get("memoryOrigin")
            if origin is None and memory is not None:
                origin = "eval_submit" if review.get("memory") is not None else "run_begin"
            run_id = row["run_id"]
            key = memory["problem_id"] if memory else f"browser:{run_id}"
            if problem_id is not None and key != problem_id:
                continue
            handoff = json.loads(row["handoff"]) if row["handoff"] else {}
            assessment = {field: review[field] for field in
                          ("reviewerModel", "verdict", "criterionResults", "evidenceIds", "summary")}
            if "toolChoice" in review:
                assessment["toolChoice"] = review["toolChoice"]
                assessment["sessionRefs"] = review.get("sessionRefs", [])
            attempts.append({
                "source": "browser", "attempt_id": row["attempt_id"], "problem_id": key,
                "domain_tag": row["product_domain"] or review.get("domain_tag"),
                "created_at": browser_timestamp(row["submitted_at"]).isoformat(),
                "title": row["title"], "memory": memory, "memory_origin": origin,
                "decision": None, "assessment": assessment,
                "run": {"run_id": run_id, "review_key": review["reviewKey"], "criteria": json.loads(row["criteria"]),
                        "outcome": handoff.get("outcome"), "note": handoff.get("note")},
                "run_evidence": evidence_refs(con, run_id, assessment),
            })
    observations = followups(observations_path, {attempt["attempt_id"] for attempt in attempts})
    for attempt in attempts:
        yield dict(attempt, observations=observations.get(attempt["attempt_id"], []))


def improvement_tasks(path):
    result = {}
    if path.is_file():
        with database(path) as con:
            if table_exists(con, "items") and table_exists(con, "events"):
                for row in con.execute("""SELECT i.id,i.task_id,i.state,i.payload FROM items i
                        JOIN events e ON e.item_id=i.id AND e.action='item_added'
                        WHERE json_extract(e.data,'$.origin')='review_improve' ORDER BY e.seq"""):
                    payload = json.loads(row["payload"])
                    result.setdefault((payload["source"], payload["attempt_id"]), []).append({
                        "task_id": row["task_id"], "item_id": row["id"], "state": row["state"], **payload})
    return result


def read_history(problem_id=None, *, attempt_id=None, source=None, domain_tag=None, telegram_db=None, browser_db=None, review_db=None, task_db=None):
    """Read persisted provider history in the common problem/attempt/observations shape."""
    if source is not None and source not in SOURCES:
        raise ValueError("source must be browser or telegram")
    telegram_path, browser_path, observations_path = db_paths(telegram_db, browser_db, review_db)
    attempts = []
    if source in (None, "telegram"):
        attempts.extend(attempt for attempt in telegram_attempts(telegram_path, problem_id)
                        if attempt_id is None or attempt["attempt_id"] == attempt_id)
    if source in (None, "browser"):
        attempts.extend(browser_attempts(browser_path, observations_path, problem_id, attempt_id))
    problems, unlinked = {}, []
    improvements = improvement_tasks(Path(task_db or os.environ.get("YONCLAW_TASK_DB") or
                                          state_file(browser_path, "tasks.sqlite3")).expanduser())
    domain_tag = resolve_domain({"domain_tag": domain_tag})
    for attempt in sorted(attempts, key=attempt_order):
        memory = attempt.get("memory") or {}
        tag = resolve_domain({"domain_tag": attempt.get("domain_tag") or memory.get("domain_tag"),
                              "review_id": attempt["attempt_id"], "goal": attempt["title"] + " " + memory.get("context", "")})
        if domain_tag is not None and tag != domain_tag:
            continue
        attempt["domain_tag"] = tag
        attempt["improvements"] = improvements.get((attempt["source"], attempt["attempt_id"]), [])
        key = attempt["problem_id"]
        if key is None:
            unlinked.append(attempt)
        else:
            problems.setdefault(key, []).append(attempt)
    return {"problems": [{"problem_id": key, "attempts": entries} for key, entries in problems.items()],
            "unlinked": unlinked}


def record_followup(source, attempt_id, observation, *, telegram_db=None, browser_db=None, review_db=None):
    """Append an observation to an existing provider attempt."""
    if source not in SOURCES:
        raise ValueError("source must be browser or telegram")
    attempt_id = required_text({"attempt_id": attempt_id}, "attempt_id")
    if not isinstance(observation, dict):
        raise ValueError("observation must be an object")
    telegram_path, browser_path, observations_path = db_paths(telegram_db, browser_db, review_db)
    if source == "telegram":
        if not telegram_path.is_file():
            raise ValueError("Telegram review database is unavailable")
        with database(telegram_path, "rw") as con:
            row = con.execute("""SELECT c.source FROM telegram_product_review_cards c
                JOIN telegram_review_channels r USING (source) WHERE c.approval_key=?""", (attempt_id,)).fetchone()
            if row is None:
                raise ValueError(f"{attempt_id}: no card on a registered Telegram route")
            telegram.ensure_memory_schema(con)
            return telegram.record_observations(con, row["source"], [dict(observation, approval_key=attempt_id)])

    if not browser_path.is_file():
        raise ValueError("Browser review database is unavailable")
    with database(browser_path) as con:
        require_browser_log(con)
        row = con.execute("SELECT submitted_at FROM browser_review_attempts_v1 WHERE attempt_id=?",
                          (attempt_id,)).fetchone()
        if row is None:
            raise ValueError(f"{attempt_id}: no committed Browser assessment")
        submitted_at = browser_timestamp(row["submitted_at"])
    now = datetime.now(timezone.utc)
    observation = normalize_observation(observation, now)
    day = observation["day"]
    observed_at = observation.get("observed_at")
    submitted_day = submitted_at.astimezone(HKT).date().isoformat()
    measured = observation["eligible"] is not None or observation["affected"] is not None
    if (day < submitted_day or (measured and day == submitted_day and observed_at is None)
            or (observed_at is not None and datetime.fromisoformat(observed_at) < submitted_at)):
        raise ValueError("follow-up observations must cover time after the assessed attempt")
    positive_exposure = (observation["eligible"] or 0) > 0 or (observation["affected"] or 0) > 0
    if positive_exposure and not (observation["version"] or observation.get("exposure_evidence")):
        raise ValueError("positive exposure requires the observed version or exposure_evidence identifying the change")
    details = json.dumps(observation, ensure_ascii=False, sort_keys=True)
    observations_path.parent.mkdir(parents=True, exist_ok=True)
    with database(observations_path, "rwc") as con:
        con.execute("""CREATE TABLE IF NOT EXISTS review_observations (
            source TEXT NOT NULL, attempt_id TEXT NOT NULL, day TEXT NOT NULL, details TEXT NOT NULL,
            recorded_at TEXT NOT NULL, PRIMARY KEY (source, attempt_id, day, details))""")
        previous = con.execute("""SELECT details,recorded_at FROM review_observations
            WHERE source=? AND attempt_id=? AND day=? ORDER BY rowid DESC""", (source, attempt_id, day)).fetchall()
        replay = any(row["details"] == details for row in previous)
        if not replay:
            validate_revision(observation, previous, attempt_id)
            con.execute("INSERT INTO review_observations VALUES (?,?,?,?,?)",
                        (source, attempt_id, day, details, now.isoformat()))
    return {"source": source, "recorded": int(not replay), "replayed": int(replay)}


def read_input(required=True):
    raw = sys.stdin.read() if required or not sys.stdin.isatty() else ""
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("evaluate", help="validate and normalize an assessment from JSON stdin")
    commands.add_parser("normalize-memory", help="normalize prediction memory from JSON stdin")
    commands.add_parser("resolve-domain", help="resolve product-edition knowledge scope from the business context")
    commands.add_parser("resolve-domains", help="resolve a batch of previously recorded business contexts")
    history_parser = commands.add_parser("history", help="read persisted review attempts and observations")
    history_parser.add_argument("--problem-id")
    history_parser.add_argument("--attempt-id")
    history_parser.add_argument("--domain-tag")
    history_parser.add_argument("--source", choices=SOURCES)
    observe_parser = commands.add_parser("observe", help="record a follow-up observation from JSON stdin")
    for command in (history_parser, observe_parser):
        for provider in ("telegram", "browser", "review"):
            command.add_argument(f"--{provider}-db", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "evaluate":
            data = read_input()
            assessment = normalize_assessment(data.get("criteria"), data.get("assessment"))
            result = {"ok": True, "assessment": assessment}
        elif args.command == "normalize-memory":
            result = {"ok": True, "memory": normalize_memory(read_input())}
        elif args.command == "resolve-domain":
            result = {"ok": True, "domain_tag": resolve_domain(read_input())}
        elif args.command == "resolve-domains":
            items = read_input().get("items")
            if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
                raise ValueError("items must be an array of business contexts")
            result = {"ok": True, "domain_tags": [resolve_domain(item) for item in items]}
        else:
            paths = dict(telegram_db=args.telegram_db, browser_db=args.browser_db, review_db=args.review_db)
            if args.command == "history":
                data = read_input(required=False)
                filters = {field: getattr(args, field) or data.get(field)
                           for field in ("problem_id", "attempt_id", "source", "domain_tag")}
                for field, value in filters.items():
                    if value is not None:
                        filters[field] = required_text(filters, field)
                result = read_history(**filters, **paths)
            else:
                data = read_input()
                result = record_followup(data.get("source"), data.get("attempt_id"), data.get("observation"), **paths)
    except (OSError, ValueError, sqlite3.Error) as error:
        code = error.code if isinstance(error, EvaluationError) else (
            "EVAL_INVALID" if args.command in ("evaluate", "normalize-memory") else "REVIEW_ERROR")
        print(json.dumps({"ok": False, "code": code, "message": str(error)}, ensure_ascii=True))
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
