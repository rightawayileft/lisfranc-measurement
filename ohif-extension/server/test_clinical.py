import copy
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from . import store
from .app import API_PREFIX, app
from .config import settings
from .manage import set_study_active
from .model import ReviewWrite

TOKEN = "synthetic-test-token-used-only-in-process"
ORIGIN = "https://ohif.example.invalid"
HEADERS = {
    "x-lisfranc-proxy-token": TOKEN,
    "x-lisfranc-actor": "reviewer-one",
    "origin": ORIGIN,
}
SPACING = {"row_mm": 0.25, "col_mm": 0.5, "source": "DICOM Pixel Spacing (GEOMETRY)"}
POINTS = {
    "c1_proximal": {"x": 12, "y": 15},
    "c1_distal": {"x": 20, "y": 17},
    "m2_tangent": {"x": 25, "y": 19},
}


def uid():
    return f"2.25.{uuid4().int}"


def payload_for(study: str, **changes):
    return {
        "baseRevision": 0,
        "frame": {
            "studyUID": study, "seriesUID": uid(), "sopUID": uid(), "frameNumber": 1,
            "rows": 256, "columns": 256, "view": "ap", "supportedModality": True, "spacing": SPACING,
        },
        "points": POINTS,
        "relation": "separated",
        "status": "draft",
        "viewSource": "dicom_ap",
        "spacing": SPACING,
        **changes,
    }


def frame_path(frame):
    return f"{API_PREFIX}/studies/{frame['studyUID']}/frames/{frame['seriesUID']}/{frame['sopUID']}/{frame['frameNumber']}"


@pytest.fixture
def test_api(monkeypatch):
    def open_client(dsn="postgresql://unused@127.0.0.1/nonexistent"):
        monkeypatch.setenv("LISFRANC_DATABASE_URL", dsn)
        monkeypatch.setenv("LISFRANC_PROXY_TOKEN", TOKEN)
        monkeypatch.setenv("LISFRANC_APP_ORIGIN", ORIGIN)
        return TestClient(app)

    settings.cache_clear()
    yield open_client
    settings.cache_clear()


def test_authentication_and_exact_origin(test_api, monkeypatch):
    def no_database_access(*args):
        pytest.fail("An unauthenticated or wrong-origin request reached the database.")

    for name in ("list_studies", "read_study", "read_frame", "write_review"):
        monkeypatch.setattr(store, name, no_database_access)
    payload = payload_for(uid())
    study_path = f"{API_PREFIX}/studies/{payload['frame']['studyUID']}/reviews"
    frame = frame_path(payload["frame"])
    with test_api() as client:
        for url in (f"{API_PREFIX}/sign-in", f"{API_PREFIX}/studies", study_path, frame, f"{frame}/history",
                    f"{API_PREFIX}/studies/{payload['frame']['studyUID']}/claim"):
            response = client.get(url, headers={"x-lisfranc-actor": "fake-user"})
            assert response.status_code == 401
            assert response.headers["cache-control"] == "no-store"
        assert client.get(frame, headers={**HEADERS, "x-lisfranc-actor": "multiple, identities"}).status_code == 401
        response = client.put(frame, json=payload, headers={**HEADERS, "origin": ORIGIN + ".invalid"})
        assert response.status_code == 403
        response = client.put(frame, json=payload, headers={k: v for k, v in HEADERS.items() if k != "origin"})
        assert response.status_code == 403
        assert client.delete(
            f"{API_PREFIX}/studies/{payload['frame']['studyUID']}/claim",
            headers={**HEADERS, "origin": ORIGIN + ".invalid"},
        ).status_code == 403
        assert client.put(frame, json=payload, headers=HEADERS).json()["code"] == "claim_required"
        signed_in = client.get(f"{API_PREFIX}/sign-in", headers=HEADERS)
        assert signed_in.status_code == 200
        assert "Clinical sign-in complete" in signed_in.text
        assert HEADERS["x-lisfranc-actor"] not in signed_in.text


def test_strict_write_validation(test_api, monkeypatch):
    def no_database_access(*args):
        pytest.fail("Invalid input reached the database.")

    monkeypatch.setattr(store, "write_review", no_database_access)
    payload = payload_for(uid())
    target = frame_path(payload["frame"])
    wrong_identity = copy.deepcopy(payload)
    wrong_identity["frame"]["frameNumber"] = 2
    outside_image = copy.deepcopy(payload)
    outside_image["points"]["m2_tangent"]["x"] = 256
    bool_coordinate = copy.deepcopy(payload)
    bool_coordinate["points"]["c1_proximal"]["x"] = True
    with test_api() as client:
        for invalid in (wrong_identity, outside_image, bool_coordinate, {**payload, "updatedBy": "spoofed"}):
            response = client.put(target, json=invalid, headers=HEADERS)
            assert response.status_code == 422
            assert "spoofed" not in response.text


def test_projection_and_proxy_geometry():
    study = uid()
    approved = payload_for(study, status="approved")
    assert store.next_record(ReviewWrite.model_validate(approved), None)["status"] == "approved"
    # Asymmetric or duplicate proxy points may be saved in a draft, not approved.
    for proxy in (
        {"m2_proximal": {"x": 3, "y": 4}},
        {"m2_proximal": {"x": 3, "y": 4}, "m2_distal": {"x": 3, "y": 4}},
    ):
        points = {**POINTS, **proxy}
        with pytest.raises(store.InvalidReview):
            store.next_record(ReviewWrite.model_validate({**approved, "points": points}), None)
    lateral = {**approved, "frame": {**approved["frame"], "view": "non_ap"}}
    with pytest.raises(store.InvalidReview):
        store.next_record(ReviewWrite.model_validate(lateral), None)


def test_shared_postgres_versions_audit_and_frame_isolation(test_api):
    dsn = os.environ.get("LISFRANC_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("LISFRANC_TEST_DATABASE_URL requires a disposable local PostgreSQL database.")
    parsed = urlsplit(dsn)
    assert parsed.scheme == "postgresql" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
    assert parsed.path.startswith("/lisfranc_test"), "Use a dedicated disposable test database."
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    study = uid()
    payload = payload_for(study)
    image_url = frame_path(payload["frame"])
    claim_url = f"{API_PREFIX}/studies/{study}/claim"
    with store.connection(dsn, autocommit=True) as conn:
        conn.execute(schema)
    assert set_study_active(dsn, study, active=True)

    with test_api(dsn) as client:
        response = client.get(f"{API_PREFIX}/studies/{uid()}/reviews", headers=HEADERS)
        assert response.status_code == 404
        assert client.get(image_url, headers=HEADERS).json() == {"review": None}

        actors = tuple(f"reviewer-{index}" for index in range(1, 6))
        leases = {actor: str(uuid4()) for actor in actors}

        def start_claim(actor):
            return client.put(claim_url, json={"leaseId": leases[actor]},
                              headers={**HEADERS, "x-lisfranc-actor": actor})

        with ThreadPoolExecutor(max_workers=5) as pool:
            claim_replies = list(pool.map(start_claim, actors))
        assert sorted(reply.status_code for reply in claim_replies) == [200, 409, 409, 409, 409]
        claim = next(reply.json()["claim"] for reply in claim_replies if reply.is_success)
        holder = claim["holder"]
        reader = next(actor for actor in actors if actor != holder)
        holder_headers = {**HEADERS, "x-lisfranc-actor": holder, "x-lisfranc-lease": leases[holder]}
        reader_headers = {**HEADERS, "x-lisfranc-actor": reader, "x-lisfranc-lease": leases[reader]}
        assert client.get(claim_url, headers=reader_headers).json() == {"claim": claim}
        assert "leaseId" not in claim
        assert client.put(claim_url, json={"leaseId": str(uuid4())}, headers=holder_headers).status_code == 409
        assert client.delete(claim_url, headers=reader_headers).status_code == 409
        assert client.put(image_url, json=payload, headers=reader_headers).json()["code"] == "claim_required"
        assert start_claim(holder).status_code == 200

        def write(_):
            return client.put(image_url, json=payload, headers=holder_headers)

        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(write, range(2)))
        assert sorted(reply.status_code for reply in replies) == [200, 409]
        winner = next(reply.json()["review"] for reply in replies if reply.is_success)
        assert winner["updatedBy"] == holder
        assert client.get(image_url, headers=reader_headers).json()["review"] == winner
        assert client.delete(claim_url, headers=holder_headers).json() == {"claim": None}
        assert client.delete(claim_url, headers=holder_headers).json() == {"claim": None}
        assert start_claim(reader).status_code == 200
        approve_payload = {**payload, "status": "approved", "baseRevision": 1}
        approval = client.put(image_url, json=approve_payload, headers=reader_headers).json()["review"]
        assert approval["revision"] == 2
        assert approval["updatedBy"] == reader
        expected_study = next(study_row for study_row in client.get(f"{API_PREFIX}/studies", headers=HEADERS).json()["studies"]
                              if study_row["studyUID"] == study)
        assert expected_study["correctedCount"] == 1
        assert expected_study["reviewCount"] == 1
        study_reviews = client.get(f"{API_PREFIX}/studies/{study}/reviews", headers=HEADERS).json()["reviews"]
        assert study_reviews == [approval]
        second = {**payload["frame"], "frameNumber": 2}
        assert client.get(frame_path(second), headers=HEADERS).json() == {"review": None}

        edited = {**POINTS, "m2_tangent": {"x": 26, "y": 19}}
        attempt = {**payload, "baseRevision": 2, "points": edited}
        failed = client.put(image_url, json=attempt, headers=reader_headers)
        assert failed.status_code == 409 and "Reopen" in failed.json()["detail"]
        with store.connection(dsn) as conn:
            conn.execute("""
                UPDATE lisfranc_clinical.study_claims SET expires_at = clock_timestamp() - INTERVAL '1 second'
                WHERE study_uid = %s
            """, (study,))
        assert client.get(claim_url, headers=reader_headers).json() == {"claim": None}
        assert client.put(image_url, json=attempt, headers=reader_headers).json()["code"] == "claim_required"
        assert start_claim(holder).status_code == 200
        reopen = {**payload, "baseRevision": 2, "frame": {**payload["frame"], "spacing": None}, "spacing": None}
        reopened = client.put(image_url, json=reopen, headers=holder_headers).json()["review"]
        assert reopened["revision"] == 3
        assert reopened["spacing"] == SPACING
        history = client.get(f"{image_url}/history", headers=reader_headers).json()["history"]
        assert history == [reopened, approval, winner]
        assert client.get(f"{frame_path(second)}/history", headers=reader_headers).json() == {"history": []}
        studies = client.get(f"{API_PREFIX}/studies", headers=HEADERS).json()["studies"]
        assert next(row for row in studies if row["studyUID"] == study)["correctedCount"] == 0
        assert set_study_active(dsn, study, active=False)
        studies = client.get(f"{API_PREFIX}/studies", headers=HEADERS).json()["studies"]
        assert all(row["studyUID"] != study for row in studies)
        assert client.get(f"{API_PREFIX}/studies/{study}/reviews", headers=HEADERS).status_code == 404
        assert client.get(image_url, headers=HEADERS).status_code == 404
        assert client.put(image_url, json={**payload, "baseRevision": 3}, headers=holder_headers).status_code == 404
        assert set_study_active(dsn, study, active=True)
        assert client.get(image_url, headers=HEADERS).json()["review"] == reopened
        assert client.get(claim_url, headers=HEADERS).json() == {"claim": None}

    with store.connection(dsn) as conn:
        events = conn.execute("""
            SELECT revision, status, updated_by, record
            FROM lisfranc_clinical.review_events WHERE study_uid = %s ORDER BY revision
        """, (study,)).fetchall()
        assert [(item["revision"], item["status"]) for item in events] == [(1, "draft"), (2, "approved"), (3, "draft")]
        assert events[1]["updated_by"] == reader
        assert events[1]["record"]["points"] == POINTS
