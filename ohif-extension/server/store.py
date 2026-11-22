from datetime import datetime

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .model import ReviewWrite


class MissingStudy(Exception):
    pass


class ReviewConflict(Exception):
    pass


class ClaimRequired(ReviewConflict):
    pass


class InvalidReview(Exception):
    pass


FRAME_MATCH = "study_uid = %s AND series_uid = %s AND sop_uid = %s AND frame_number = %s"
REVIEW_FIELDS = "record, revision, updated_at, updated_by"


def connection(dsn: str, **kwargs):
    return psycopg.connect(
        dsn,
        row_factory=dict_row,
        connect_timeout=5,
        options="-c statement_timeout=6000 -c lock_timeout=4000",
        **kwargs,
    )


def iso(datetime_value: datetime | None) -> str | None:
    return datetime_value.isoformat() if datetime_value else None


def serialize(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {
        **row["record"],
        "revision": row["revision"],
        "updatedAt": iso(row["updated_at"]),
        "updatedBy": row["updated_by"],
    }


def list_studies(dsn: str) -> list[dict]:
    with connection(dsn) as conn:
        rows = conn.execute("""
            SELECT s.study_uid, COUNT(r.study_uid) AS review_count,
                   COUNT(*) FILTER (WHERE r.status = 'approved') AS corrected_count,
                   MAX(r.updated_at) AS updated_at
            FROM lisfranc_clinical.studies s
            LEFT JOIN lisfranc_clinical.reviews r ON r.study_uid = s.study_uid
            WHERE s.active
            GROUP BY s.study_uid
            ORDER BY updated_at DESC NULLS LAST, s.study_uid
        """)
        return [
            {
                "studyUID": row["study_uid"],
                "correctedCount": row["corrected_count"],
                "reviewCount": row["review_count"],
                "updatedAt": iso(row["updated_at"]),
            }
            for row in rows
        ]


def lock_study(conn, study_uid: str, *, exclusive: bool = False) -> None:
    # Enrollment changes wait for in-flight requests; unrelated studies do not.
    sql = ("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))" if exclusive else
           "SELECT pg_advisory_xact_lock_shared(hashtextextended(%s, 0))")
    conn.execute(sql, ("lisfranc-clinical-study/" + study_uid,))


def require_study(conn, study_uid: str, *, exclusive: bool = False) -> None:
    lock_study(conn, study_uid, exclusive=exclusive)
    if not conn.execute(
        "SELECT 1 FROM lisfranc_clinical.studies WHERE study_uid = %s AND active", (study_uid,)
    ).fetchone():
        raise MissingStudy


def read_study(dsn: str, study_uid: str) -> list[dict]:
    with connection(dsn) as conn:
        require_study(conn, study_uid)
        rows = conn.execute(
            f"""SELECT {REVIEW_FIELDS} FROM lisfranc_clinical.reviews WHERE study_uid = %s
                ORDER BY series_uid, sop_uid, frame_number""",
            (study_uid,),
        )
        return [serialize(row) for row in rows]


def read_frame(dsn: str, key: tuple) -> dict | None:
    with connection(dsn) as conn:
        require_study(conn, key[0])
        row = conn.execute(
            f"SELECT {REVIEW_FIELDS} FROM lisfranc_clinical.reviews WHERE {FRAME_MATCH}", key
        ).fetchone()
        return serialize(row)


def read_history(dsn: str, key: tuple) -> list[dict]:
    with connection(dsn) as conn:
        require_study(conn, key[0])
        rows = conn.execute(f"""
            SELECT {REVIEW_FIELDS} FROM lisfranc_clinical.review_events WHERE {FRAME_MATCH}
            ORDER BY revision DESC
        """, key)
        return [serialize(row) for row in rows]


def active_claim(conn, study: str):
    return conn.execute("""
        SELECT holder, lease_id, expires_at
        FROM lisfranc_clinical.study_claims
        WHERE study_uid = %s AND expires_at > clock_timestamp()
    """, (study,)).fetchone()


def claim_response(claim: dict | None) -> dict | None:
    if claim is None:
        return None
    return {"holder": claim["holder"], "expiresAt": iso(claim["expires_at"])}


def read_claim(dsn: str, study: str) -> dict | None:
    with connection(dsn) as conn:
        require_study(conn, study)
        return claim_response(active_claim(conn, study))


def save_claim(dsn: str, study: str, actor: str, lease) -> dict:
    with connection(dsn) as conn:
        conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        require_study(conn, study, exclusive=True)
        existing = active_claim(conn, study)
        if existing and (existing["holder"] != actor or existing["lease_id"] != lease):
            raise ReviewConflict("Another review session already holds this study.")
        row = conn.execute("""
            INSERT INTO lisfranc_clinical.study_claims (study_uid, holder, lease_id, expires_at)
            VALUES (%s, %s, %s, clock_timestamp() + INTERVAL '120 seconds')
            ON CONFLICT (study_uid) DO UPDATE
            SET holder = EXCLUDED.holder, lease_id = EXCLUDED.lease_id, expires_at = EXCLUDED.expires_at
            RETURNING holder, expires_at
        """, (study, actor, lease)).fetchone()
        return claim_response(row)


def release_claim(dsn: str, study: str, actor: str, lease) -> None:
    with connection(dsn) as conn:
        conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        require_study(conn, study, exclusive=True)
        existing = active_claim(conn, study)
        if existing and (existing["holder"] != actor or existing["lease_id"] != lease):
            raise ReviewConflict("Only the session that claimed this study can release it.")
        conn.execute("""
            DELETE FROM lisfranc_clinical.study_claims
            WHERE study_uid = %s AND holder = %s AND lease_id = %s
        """, (study, actor, lease))


def next_record(payload: ReviewWrite, previous: dict | None) -> dict:
    frame = payload.frame.model_dump()
    points = payload.normalized_points()
    status = payload.status
    view_source = payload.viewSource
    spacing = frame["spacing"]
    if previous is not None:
        if frame["rows"] != previous["frame"]["rows"] or frame["columns"] != previous["frame"]["columns"]:
            raise ReviewConflict("Source image dimensions differ from the saved review.")
        same_landmarks = points == previous["points"] and payload.relation == previous["relation"]
        if previous["status"] in ("approved", "rejected"):
            if status != "draft" or not same_landmarks:
                raise ReviewConflict("Reopen the shared review before editing landmarks or changing its status.")
            return {**previous, "status": "draft"}
        spacing = previous["spacing"]
        if status == "skipped" and same_landmarks:
            return {**previous, "status": "skipped"}

    if not payload.frame.supportedModality:
        raise InvalidReview("Select a supported projection image.")
    if status == "skipped":
        if points or payload.relation is not None:
            raise InvalidReview("Save landmark edits separately before skipping.")
    else:
        expected = {"ap": "dicom_ap", "unknown": "reviewer_confirmed_ap"}.get(payload.frame.view)
        if expected is None or view_source != expected:
            raise InvalidReview("Confirm an AP/DP projection before editing or approving a review.")
    if status == "approved" and not payload.valid_approval():
        raise InvalidReview("Approval requires a valid tangent, a cortex relation, and distinct proxy corners if started.")

    return {
        "frame": frame,
        "points": points,
        "relation": payload.relation,
        "status": status,
        "viewSource": view_source,
        "spacing": spacing,
    }


def write_review(dsn: str, key: tuple, payload: ReviewWrite, actor: str, lease) -> dict:
    with connection(dsn) as conn:
        conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
        # Claim, review and deactivation writers all take the same lock first.
        require_study(conn, key[0], exclusive=True)
        claim = active_claim(conn, key[0])
        if not claim or claim["lease_id"] != lease or claim["holder"] != actor:
            raise ClaimRequired("Claim this study before saving a shared review.")
        previous = conn.execute(
            f"SELECT revision, record FROM lisfranc_clinical.reviews WHERE {FRAME_MATCH}", key
        ).fetchone()
        revision = previous["revision"] if previous else 0
        if payload.baseRevision != revision:
            raise ReviewConflict("This review was changed by another reviewer. Reload the shared review before editing.")
        record = next_record(payload, previous["record"] if previous else None)
        row = conn.execute(f"""
            INSERT INTO lisfranc_clinical.reviews
                (study_uid, series_uid, sop_uid, frame_number, revision, status, record, updated_by, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, clock_timestamp())
            ON CONFLICT (study_uid, series_uid, sop_uid, frame_number) DO UPDATE
            SET revision = EXCLUDED.revision, status = EXCLUDED.status, record = EXCLUDED.record,
                updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
            RETURNING {REVIEW_FIELDS}
        """, (*key, revision + 1, record["status"], Jsonb(record), actor)).fetchone()
        conn.execute("""
            INSERT INTO lisfranc_clinical.review_events
                (study_uid, series_uid, sop_uid, frame_number, revision, status, record, updated_by, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (*key, row["revision"], record["status"], Jsonb(record), actor, row["updated_at"]))
        return serialize(row)
