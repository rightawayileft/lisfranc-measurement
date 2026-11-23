import hmac
import re
from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse

from . import store
from .config import Settings, settings
from .model import ClaimWrite, FrameNumber, ReviewWrite, UID

API_PREFIX = "/api/lisfranc-clinical/v1"
ACTOR_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@:+-]{0,127}")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def no_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # Do not reflect request bodies, actor IDs, or DICOM references in errors.
    return JSONResponse({"detail": "Invalid clinical review request."}, status_code=422)


@app.exception_handler(psycopg.Error)
async def database_error(request, error):
    return JSONResponse({"detail": "The shared Clinical database is unavailable."}, status_code=503)


@app.exception_handler(store.MissingStudy)
async def unenrolled_study(request, error):
    return JSONResponse({"detail": "This study is not enrolled for shared Clinical review."}, status_code=404)


@app.exception_handler(store.ReviewConflict)
async def conflict(request, error):
    return JSONResponse({"detail": str(error)}, status_code=409)


@app.exception_handler(store.ClaimRequired)
async def claim_required(request, error):
    return JSONResponse({"detail": str(error), "code": "claim_required"}, status_code=409)


@app.exception_handler(store.InvalidReview)
async def invalid_review(request, error):
    return JSONResponse({"detail": str(error)}, status_code=422)


def proxy_identity(request: Request) -> tuple[Settings, str]:
    try:
        cfg = settings()
    except (OSError, ValueError):
        raise HTTPException(503, "Shared Clinical review is not configured.") from None
    tokens = request.headers.getlist("x-lisfranc-proxy-token")
    actors = request.headers.getlist("x-lisfranc-actor")
    if (len(tokens) != 1 or not hmac.compare_digest(tokens[0].encode("latin-1"), cfg.proxy_token)
            or len(actors) != 1 or ACTOR_PATTERN.fullmatch(actors[0]) is None):
        raise HTTPException(401, "Hospital reviewer sign-in is required.")
    if request.method in ("PUT", "DELETE") and request.headers.getlist("origin") != [cfg.origin]:
        raise HTTPException(403, "Review writes require the configured OHIF origin.")
    return cfg, actors[0]


Identity = Annotated[tuple[Settings, str], Depends(proxy_identity)]


def require_lease(request: Request) -> UUID:
    headers = request.headers.getlist("x-lisfranc-lease")
    if len(headers) == 1 and len(headers[0]) == 36:
        try:
            parsed = UUID(headers[0])
            if str(parsed) == headers[0].lower():
                return parsed
        except ValueError:
            pass
    raise store.ClaimRequired("Claim this study before saving a shared review.")


@app.get(f"{API_PREFIX}/sign-in", response_class=HTMLResponse)
def sign_in(identity: Identity):
    # A top-level sign-in page allows the reverse proxy's hospital sign-in
    # challenge even when a browser won't prompt from a background fetch.
    return """<!doctype html><html lang="en"><meta charset="utf-8">
<title>Clinical sign-in complete</title><h1>Clinical sign-in complete</h1>
<p>Return to OHIF.</p></html>"""


@app.get(f"{API_PREFIX}/studies")
def studies(identity: Identity):
    cfg, _ = identity
    return {"studies": store.list_studies(cfg.database_url)}


@app.get(f"{API_PREFIX}/studies/{{studyUID}}/reviews")
def study_reviews(studyUID: UID, identity: Identity):
    cfg, _ = identity
    return {"reviews": store.read_study(cfg.database_url, studyUID)}


FRAME_PATH = f"{API_PREFIX}/studies/{{studyUID}}/frames/{{seriesUID}}/{{sopUID}}/{{frameNumber}}"
CLAIM_PATH = f"{API_PREFIX}/studies/{{studyUID}}/claim"


@app.get(CLAIM_PATH)
def study_claim(studyUID: UID, identity: Identity):
    cfg, _ = identity
    return {"claim": store.read_claim(cfg.database_url, studyUID)}


@app.put(CLAIM_PATH)
def claim_study(studyUID: UID, payload: ClaimWrite, identity: Identity):
    cfg, actor = identity
    return {"claim": store.save_claim(cfg.database_url, studyUID, actor, payload.leaseId)}


@app.delete(CLAIM_PATH)
def release_study(studyUID: UID, request: Request, identity: Identity):
    cfg, actor = identity
    store.release_claim(cfg.database_url, studyUID, actor, require_lease(request))
    return {"claim": None}


@app.get(FRAME_PATH)
def frame_review(studyUID: UID, seriesUID: UID, sopUID: UID, frameNumber: FrameNumber, identity: Identity):
    cfg, _ = identity
    return {"review": store.read_frame(cfg.database_url, (studyUID, seriesUID, sopUID, frameNumber))}


@app.get(f"{FRAME_PATH}/history")
def frame_history(studyUID: UID, seriesUID: UID, sopUID: UID, frameNumber: FrameNumber, identity: Identity):
    cfg, _ = identity
    return {"history": store.read_history(cfg.database_url, (studyUID, seriesUID, sopUID, frameNumber))}


@app.put(FRAME_PATH)
def update_review(
    studyUID: UID, seriesUID: UID, sopUID: UID, frameNumber: FrameNumber,
    payload: ReviewWrite, request: Request, identity: Identity,
):
    cfg, actor = identity
    key = studyUID, seriesUID, sopUID, frameNumber
    if payload.frame.key != key:
        raise HTTPException(422, "Review frame does not match the request path.")
    return {"review": store.write_review(cfg.database_url, key, payload, actor, require_lease(request))}
