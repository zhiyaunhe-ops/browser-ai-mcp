"""Common review and observation rules for Toolkit providers."""
import json
from datetime import date, datetime, timedelta, timezone
from review_domain import resolve_domain


MEMORY_FIELDS = ("problem_id", "context", "rationale", "prediction", "metric", "evidence")
HKT = timezone(timedelta(hours=8))


def required_text(data, field):
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be nonempty text")
    return value.strip()


def normalize_memory(data):
    if not isinstance(data, dict):
        raise ValueError("memory must be an object")
    memory = {field: required_text(data, field) for field in MEMORY_FIELDS}
    if "model" in data:
        memory["model"] = required_text(data, "model")
    tag = resolve_domain({"domain_tag": data.get("domain_tag"), "goal": memory["context"]})
    if tag:
        memory["domain_tag"] = tag
    return memory


def normalize_observation(data, now, identity_field=None):
    if not isinstance(data, dict):
        raise ValueError("observation must be an object")
    fields = ("day", "evidence", "finding")
    if identity_field is not None:
        fields = (identity_field, *fields)
    observation = {field: required_text(data, field) for field in fields}
    observation["day"] = date.fromisoformat(observation["day"]).isoformat()
    if observation["day"] > now.astimezone(HKT).date().isoformat():
        raise ValueError("observation day cannot be in the future")
    for field in ("eligible", "affected"):
        value = data.get(field)
        if field not in data or (value is not None and (type(value) is not int or value < 0)):
            raise ValueError(f"observation {field} must be a nonnegative integer or null")
        observation[field] = value
    eligible, affected = observation["eligible"], observation["affected"]
    if eligible is not None and affected is not None and affected > eligible:
        raise ValueError("observation affected cannot exceed eligible")
    finding = observation["finding"]
    if eligible is None or affected is None:
        allowed = ("unknown",)
    elif eligible == 0:
        allowed = ("no_sample",)
    else:
        allowed = ("observed", "improved", "unchanged", "regressed")
    if finding not in allowed:
        raise ValueError(f"observation finding must be one of {', '.join(allowed)} for these counts")
    if "baseline" in data or finding in ("improved", "unchanged", "regressed"):
        baseline = data.get("baseline")
        if not isinstance(baseline, dict):
            raise ValueError("comparison requires a baseline object")
        baseline_eligible, baseline_affected = baseline.get("eligible"), baseline.get("affected")
        if (type(baseline_eligible) is not int or baseline_eligible <= 0 or
                type(baseline_affected) is not int or not 0 <= baseline_affected <= baseline_eligible):
            raise ValueError("baseline needs positive eligibility and a valid affected count")
        observation["baseline"] = {
            "eligible": baseline_eligible, "affected": baseline_affected, "evidence": required_text(baseline, "evidence"),
        }
        if finding in ("improved", "unchanged", "regressed"):
            difference = affected * baseline_eligible - baseline_affected * eligible
            expected = "improved" if difference < 0 else "regressed" if difference > 0 else "unchanged"
            if finding != expected:
                raise ValueError(f"observed and baseline affected rates imply {expected}")
    if "version" not in data:
        raise ValueError("observation version is required; use null when unknown")
    observation["version"] = None if data["version"] is None else required_text(data, "version")
    for field in ("exposure_evidence", "supersedes"):
        if field in data:
            observation[field] = required_text(data, field)
    if data.get("observed_at") is not None:
        at = datetime.fromisoformat(required_text(data, "observed_at").replace("Z", "+00:00"))
        if at.tzinfo is None or at.astimezone(HKT).date().isoformat() != observation["day"]:
            raise ValueError("observation observed_at must include an offset and fall on its HKT day")
        if at > now:
            raise ValueError("observation observed_at cannot be in the future")
        observation["observed_at"] = at.astimezone(timezone.utc).isoformat()
    return observation


def validate_revision(observation, previous, key):
    day = observation["day"]
    supersedes = observation.get("supersedes")
    if supersedes is not None and (not previous or supersedes != previous[0]["recorded_at"]):
        raise ValueError(f"{key}: supersedes must match the current observation's recorded_at for {day}")
    if previous:
        latest = json.loads(previous[0]["details"])
        latest.pop("supersedes", None)
        new_evidence = {field: value for field, value in observation.items() if field != "supersedes"}
        if new_evidence == latest:
            raise ValueError(f"{key}: a correction must change the observation for {day}")
        allows_late_samples = latest["finding"] == "unknown" or (
            latest["finding"] == "no_sample" and observation["finding"] != "unknown")
        if not supersedes and not allows_late_samples:
            raise ValueError(f"{key}: a conclusive observation already exists for {day}")


class EvaluationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def text_list(data, field, limit, optional=False):
    values = data.get(field, [] if optional else None)
    if (not isinstance(values, list) or len(values) > limit
            or any(not isinstance(value, str) or not value.strip() for value in values)):
        raise ValueError(f"{field} must contain at most {limit} nonempty strings")
    return values


def normalize_assessment(criteria, assessment):
    """Validate review semantics independently of evidence storage and routing."""
    if not isinstance(criteria, list) or not isinstance(assessment, dict):
        raise ValueError("evaluation requires criteria and an assessment object")
    if any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip()
           for row in criteria):
        raise EvaluationError("EVAL_CRITERIA", "Declared criteria must have nonempty IDs.")
    expected = {row["id"] for row in criteria}
    if len(expected) != len(criteria):
        raise EvaluationError("EVAL_CRITERIA", "Declared criteria must have unique IDs.")
    verdict = assessment.get("verdict")
    if verdict not in ("pass", "fail", "insufficient_evidence"):
        raise ValueError("verdict must be pass, fail or insufficient_evidence")
    results = assessment.get("criterionResults")
    if not isinstance(results, list) or len(results) != len(expected) or len(results) > 30:
        raise EvaluationError("EVAL_CRITERIA", "Report each declared criterion exactly once.")
    evidence = list(dict.fromkeys(text_list(assessment, "evidenceIds", 100)))
    references = set(evidence)
    normalized_results = []
    for row in results:
        if not isinstance(row, dict) or not isinstance(row.get("criterionId"), str) or row["criterionId"] not in expected:
            raise EvaluationError("EVAL_CRITERIA", "Report each declared criterion exactly once.")
        criterion_id = row["criterionId"]
        expected.remove(criterion_id)
        criterion_verdict = row.get("verdict")
        if criterion_verdict not in ("met", "unmet", "insufficient_evidence"):
            raise EvaluationError("EVAL_CRITERIA", "Invalid criterion verdict.")
        citations = list(dict.fromkeys(text_list(row, "evidenceIds", 100)))
        if criterion_verdict != "insufficient_evidence" and not citations:
            raise EvaluationError("EVAL_EVIDENCE", "Cite evidence for each met or unmet criterion.")
        references.update(citations)
        normalized_results.append({"criterionId": criterion_id, "verdict": criterion_verdict,
                                   "reason": required_text(row, "reason"), "evidenceIds": citations})
    if verdict != "insufficient_evidence" and not references:
        raise EvaluationError("EVAL_EVIDENCE", "Cite evidence from the run for a conclusive review.")
    if verdict == "pass" and any(row["verdict"] != "met" for row in normalized_results):
        raise EvaluationError("EVAL_CRITERIA", "A passing review requires all declared criteria to be met.")
    summary = assessment.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("summary must be an object")
    normalized = {
        "reviewerModel": required_text(assessment, "reviewerModel"), "verdict": verdict,
        "criterionResults": normalized_results, "evidenceIds": evidence,
        "summary": {
            "result": required_text(summary, "result"),
            "lessons": [note.strip() for note in text_list(summary, "lessons", 30, optional=True)],
            "limitations": [note.strip() for note in text_list(summary, "limitations", 30, optional=True)],
        },
    }
    if "toolChoice" in assessment:
        route = assessment["toolChoice"]
        if not isinstance(route, dict) or route.get("status") not in ("reasonable", "improvable", "insufficient_evidence"):
            raise EvaluationError("EVAL_TOOL_CHOICE", "Invalid tool choice status.")
        choice = {"status": route["status"], "reason": required_text(route, "reason"),
                  "evidenceIds": list(dict.fromkeys(text_list(route, "evidenceIds", 100)))}
        if route["status"] == "improvable" or "alternative" in route:
            choice["alternative"] = required_text(route, "alternative")
        normalized["toolChoice"] = choice
    if "memory" in assessment:
        normalized["memory"] = normalize_memory(assessment["memory"])
    memory_tag = normalized.get("memory", {}).get("domain_tag")
    tag = resolve_domain({"domain_tag": assessment.get("domain_tag") or memory_tag,
                          "goal": normalized.get("memory", {}).get("context")})
    if tag and memory_tag and tag != memory_tag:
        raise ValueError("assessment and memory domain_tag must agree")
    if tag:
        normalized["domain_tag"] = tag
    return normalized
