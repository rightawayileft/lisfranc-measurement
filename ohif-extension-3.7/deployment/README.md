# Shared Clinical deployment

The Clinical panel talks to an on-premises PostgreSQL service through the same HTTPS origin as OHIF. Demo keeps its own browser-local reviews and uses generated projection schematics.

Each enrolled frame has one shared review. Approval places it in Corrected for every reviewer. Reopening moves it back to To review. A reviewer takes a temporary study claim before editing or changing status. Other reviewers may view and inspect the history during the claim. It renews while editing and expires if the browser stops renewing. Version checks also reject stale edits. Each accepted save records the authenticated reviewer, revision, timestamp and measurement snapshot. The current frame's **History** is read-only. DICOM pixels remain with the existing OHIF data source.

## Hospital setup

1. Route `/api/lisfranc-clinical/v1/` on the site's private HTTPS OHIF origin. Keep the server's existing network access restrictions. Every named Clinical account can see and edit every enrolled study. Enroll only studies the reviewer group is approved to review.
2. Use a dedicated PostgreSQL 16 database and a restricted runtime role. The included Compose file keeps PostgreSQL on its private container network and binds the API to host loopback. Use Docker Engine 28 or later for this binding, or explicitly verify isolation on an older deployment. An existing managed database can use the same schema and grants with its own runtime DSN. [Docker port publishing behavior](https://docs.docker.com/engine/network/port-publishing/)
3. Configure the [Nginx example](nginx-clinical.conf.example) inside the existing HTTPS server block. The example uses named reviewer accounts because the host currently has no identity API. Nginx verifies the password and forwards its own `$remote_user` as the reviewer. The proxy replaces any incoming actor and proxy token headers. Keep the high-entropy token in the protected include, shared only between Nginx and the API. [Nginx basic authentication documentation](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)
4. Build the OHIF extension against the site's source revision and configuration. An optional `window.config.lisfrancClinicalStudyPath` can point to the verified same-origin OHIF DICOMweb viewer path, such as `/ohif/viewer/dicomweb`, so reviewers can open studies from Shared Corrected. The path must match the site's data source.

Use the host's `htpasswd` tool to create one named credential per reviewer. The first command creates the file. Omit `-c` when adding subsequent reviewers or rotating one password. Restrict the file to the operator and the Nginx service account. Test the config before reloading Nginx.

```sh
htpasswd -B -c /etc/nginx/private/lisfranc-reviewers.htpasswd reviewer-one
htpasswd -B /etc/nginx/private/lisfranc-reviewers.htpasswd reviewer-two
nginx -t
```

In OHIF, **Sign in to Clinical** opens the protected account prompt. After successful sign-in, return to OHIF and choose **Open Clinical reviews**. The Demo tab does not contact the Clinical API when opened without first opening Clinical reviews. Browser Basic Auth credentials remain in that browser session, so use a distinct workstation profile or close the session on a shared workstation.

## Docker startup in a separate staging environment

Run these from this `deployment` directory. Use secret files outside the source directory and export the following settings in the operator shell.

| Variable | Value |
| --- | --- |
| `LISFRANC_APP_ORIGIN` | Exact public OHIF origin, for example `https://ohif.example.org`, with no path or trailing slash |
| `LISFRANC_PG_ADMIN_PASSWORD_FILE` | Absolute path to a file containing the dedicated PostgreSQL admin password |
| `LISFRANC_RUNTIME_DSN_FILE` | Absolute path to a file containing the restricted `lisfranc_app` DSN for database `lisfranc` on Compose host `postgres` |
| `LISFRANC_PROXY_SECRET_FILE` | Absolute path to the proxy token, preferably 32 random bytes encoded as 64 hex characters. Use the same value in the private proxy include |

Compose mounts the secrets as files. Ensure the two API secret files can be read by the container's runtime UID 65532, without granting broad access on the host. [Docker Compose secrets documentation](https://docs.docker.com/compose/how-tos/use-secrets/)

```sh
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres -d lisfranc -v ON_ERROR_STOP=1 < ../server/schema.sql
docker compose exec postgres psql -U postgres -d lisfranc
```

Create the service role at the `psql` prompt, then set its password with the interactive password command.

```sql
CREATE ROLE lisfranc_app LOGIN;
\password lisfranc_app
\q
```

```sh
docker compose exec -T postgres psql -U postgres -d lisfranc -v ON_ERROR_STOP=1 < grants.sql
docker compose up -d --build api
```

Use the restricted role in the API DSN. It can see enrollment, manage temporary claims, update shared reviews, and read and append review events. It cannot enroll studies or edit prior events. [PostgreSQL grants documentation](https://www.postgresql.org/docs/16/sql-grant.html)

## Enrollment and handoff

Add the studies to the existing OHIF source through the site's intake workflow. After ingestion, enroll the same batch through the offline adapter. It accepts a UTF-8 CSV with one `accession_number` column. Use either a trusted mapping exported from the intake (`accession_number,study_instance_uid`) or a local directory of the newly added DICOMs. Identifiers are matched exactly, including leading zeros. The default dry run reports counts and any unresolved row numbers. Missing or ambiguous rows block the whole batch. The adapter reads only the DICOM headers and writes only the enrolled study UIDs to the review database.

```sh
# Run from the package root using a local admin DSN.
python -m server.intake accessions.csv --study-map accession_to_study.csv
python -m server.intake accessions.csv --study-map accession_to_study.csv --apply
python -m server.intake accessions.csv --dicom-directory /path/to/added-dicoms
```

For the private Compose database, an operator can run the same command in a one-off container. Mount the admin DSN and CSVs read-only, limited to this command. The admin DSN connects to host `postgres` on the private network. Omit `--apply` for the first run, then repeat it with `--apply` once all rows resolve.

```sh
docker compose run --rm --no-deps \
  --volume /private/lisfranc/admin-dsn:/run/secrets/intake_admin_dsn:ro \
  --volume /private/lisfranc/batch:/intake:ro \
  -e LISFRANC_DATABASE_URL_FILE=/run/secrets/intake_admin_dsn \
  api python -m server.intake /intake/accessions.csv --study-map /intake/accession_to_study.csv
```

The per-study admin commands `python -m server.manage enroll STUDY_UID` and `python -m server.manage deactivate STUDY_UID` use the same admin DSN. Deactivation removes a study from the shared queue and retains its history.

Beware of opening the same UID through different DICOM sources. The current API trusts selected frame metadata from the authorized reviewer's OHIF client. It checks that identifiers and geometry are internally consistent and that the study is enrolled. It does not query the archive to verify the submitted frame or calibration.

Before clinical use, verify with synthetic studies at the site that anonymous Clinical access is denied, authorized reviewers see the same Corrected folder, the history attributes saves to the correct reviewers, and another browser cannot edit a claimed study. Confirm database backup and restore before relying on the shared queue. Existing local Clinical reviews from older builds stay in their old browser profile. Review and reconcile them separately before any import.

Rollback by restoring the earlier OHIF bundle and removing the proxy route. Preserve the database volume and its revision history. It is independent of the original archive and the standalone Demo.
