# Shared Clinical review service

Run the private FastAPI service from the extension root with `uvicorn server.app:app --no-access-log`. See the hospital deployment instructions for the same-origin reverse proxy, database account, and secrets.

The trusted proxy supplies the authenticated reviewer name in `X-Lisfranc-Actor` and a server-only secret in `X-Lisfranc-Proxy-Token`. The deployment example verifies named reviewer accounts over private HTTPS. The API requires the configured browser `Origin` for writes. All reviewers authorized by that proxy share the enrolled study cohort.

For schema and enrollment operations, set `LISFRANC_DATABASE_URL` or its `_FILE` counterpart to the **admin** connection for the dedicated database:

```sh
python -m server.manage init
python -m server.manage enroll <StudyInstanceUID>
python -m server.manage deactivate <StudyInstanceUID>
```

Deactivation hides the study and blocks new clinical access. Its saved reviews and history remain in the database. Running `enroll` again reactivates the same records. Use `python -m server.intake --help` for offline accession CSV matching and batch enrollment.

## API

The endpoints share the prefix `/api/lisfranc-clinical/v1`:

| Request | Success response |
| --- | --- |
| `GET /sign-in` | Sign-in confirmation page, used when the proxy requires an interactive browser sign-in |
| `GET /studies` | `{studies: [{studyUID, reviewCount, correctedCount, updatedAt}]}` |
| `GET /studies/{studyUID}/reviews` | `{reviews: [...]}` |
| `GET /studies/{studyUID}/claim` | `{claim: {holder, expiresAt}}` or `{claim: null}` |
| `PUT /studies/{studyUID}/claim` | `{claim: {holder, expiresAt}}` for the submitted `{leaseId}` |
| `DELETE /studies/{studyUID}/claim` | `{claim: null}` on release by the holder |
| `GET /studies/{studyUID}/frames/{seriesUID}/{sopUID}/{frameNumber}` | `{review: {...}}` or `{review: null}` |
| `PUT /studies/{studyUID}/frames/{seriesUID}/{sopUID}/{frameNumber}` | `{review: {...}}` |
| `GET /studies/{studyUID}/frames/{seriesUID}/{sopUID}/{frameNumber}/history` | `{history: [...]}`, newest revision first |

A reviewer claims a study before editing. The client generates a new UUID for each session and sends it as `X-Lisfranc-Lease` with each frame write and claim release. A claim expires after 120 seconds unless renewed by the same reviewer and session. Claim and review writes are serialized within each study. Read-only access remains available to other reviewers.

The frontend supplies the current base revision, frame identity and dimensions, source-pixel point coordinates, view evidence, relation, spacing provenance, and status. The server checks approval geometry and stores the first saved calibration with the review. Each accepted revision and its authenticated actor are recorded together in a single transaction. A stale or locked write returns HTTP 409. Approval places a frame in Corrected. Reopening removes it from that folder.

The database stores DICOM references, annotation metadata, and audit history. It does not ingest DICOM pixels. Coordinates, spacing, and projection labels come from the OHIF viewport and reviewer. The API validates the submitted structure and enrollment but does not independently query the PACS.

## Tests

Run `python -m pytest server/test_clinical.py` from the extension root. To include transactional tests, set `LISFRANC_TEST_DATABASE_URL` to a disposable local PostgreSQL database whose name starts with `lisfranc_test`. Tests create their own synthetic identifiers.
