"""Run a fresh localhost-only clinical database and synthetic OHIF browser test."""

import argparse
import base64
import binascii
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time

import fasteners
import pgserver
import pgserver.postgres_server as pgmodule
import psycopg


EXT = Path(__file__).resolve().parents[1]
ROUTES = {"/", "/localbasic", "/viewer", "/viewer/dicomlocal"}
STUDY = "2.25.250981981353660330135830176371284000400"
LEGACY_MULTIFRAME_STUDY = "2.25.250981981353660330135830176371284000300"
CALIBRATED_STUDY = "2.25.250981981353660330135830176371284000100"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def start_disposable_pg(run):
    runtime = run / "runtime"
    runtime.mkdir()
    pgmodule.PostgresServer.runtime_path = runtime
    pgmodule.PostgresServer.lock_path = runtime / ".lockfile"
    pgmodule.PostgresServer._lock = fasteners.InterProcessLock(str(runtime / ".lockfile"))
    if os.name == "nt":
        for name in ("initdb", "pg_ctl"):
            original = getattr(pgmodule, name)

            def hidden(*args, _original=original, **kwargs):
                kwargs["creationflags"] = FLAGS
                kwargs.setdefault("timeout", 25)
                return _original(*args, **kwargs)

            setattr(pgmodule, name, hidden)
    return pgserver.get_server(str(run / "pgdata"), cleanup_mode="stop")


def run_checked(command, env=None, timeout=25):
    completed = subprocess.run(
        command, cwd=EXT, env=env, creationflags=FLAGS, timeout=timeout,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
    )
    print(completed.stdout, end="", flush=True)
    completed.check_returncode()


def synthetic_proxy(app, dist, token, accounts, prefix):
    from starlette.responses import FileResponse, Response

    def authenticate(headers):
        auth = [value for name, value in headers if name == b"authorization"]
        if len(auth) != 1 or not auth[0].startswith(b"Basic "):
            return None
        try:
            credentials = base64.b64decode(auth[0][len(b"Basic "):], validate=True).decode("ascii")
        except (UnicodeError, binascii.Error):
            return None
        actor, separator, password = credentials.partition(":")
        expected = accounts.get(actor)
        return actor if separator and expected and secrets.compare_digest(password, expected) else None

    async def serve(scope, receive, send):
        if scope["type"] != "http":
            return await app(scope, receive, send)
        path = scope["path"]
        if path.startswith(prefix + "/"):
            actor = authenticate(scope["headers"])
            if actor is None:
                return await Response(status_code=401, headers={
                    "WWW-Authenticate": 'Basic realm="Synthetic Lisfranc Clinical"',
                    "Cache-Control": "no-store",
                })(scope, receive, send)
            scope = {
                **scope,
                "headers": [
                    (name, value)
                    for name, value in scope["headers"]
                    if name not in (b"authorization", b"cookie", b"x-lisfranc-actor", b"x-lisfranc-proxy-token")
                ] + [
                    (b"x-lisfranc-actor", actor.encode("ascii")),
                    (b"x-lisfranc-proxy-token", token.encode("ascii")),
                ],
            }
            return await app(scope, receive, send)
        if scope["method"] not in ("GET", "HEAD"):
            return await Response(status_code=405)(scope, receive, send)
        target = dist / "index.html" if path in ROUTES else (dist / path.lstrip("/")).resolve()
        if not target.is_relative_to(dist) or not target.is_file():
            return await Response(status_code=404)(scope, receive, send)
        headers = {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cache-Control": "no-store",
        }
        media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return await FileResponse(target, media_type=media_type, headers=headers)(scope, receive, send)

    return serve


def verify_api(pg):
    with psycopg.connect(pg.get_uri(), autocommit=True) as connection:
        connection.execute("CREATE DATABASE lisfranc_test_api")
    python_test_env = {
        **os.environ,
        "LISFRANC_TEST_DATABASE_URL": pg.get_uri(database="lisfranc_test_api"),
    }
    run_checked(
        [sys.executable, "-B", "-m", "pytest", "server", "-q", "-p", "no:cacheprovider"],
        env=python_test_env, timeout=50,
    )


def smoke(pg, dist, browser, run):
    import uvicorn

    assert dist.is_dir() and (dist / "index.html").is_file(), dist
    with psycopg.connect(pg.get_uri(), autocommit=True) as connection:
        connection.execute("CREATE DATABASE lisfranc")
        connection.execute("CREATE ROLE lisfranc_app LOGIN")
    admin_dsn = pg.get_uri(database="lisfranc")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        origin = f"http://127.0.0.1:{sock.getsockname()[1]}"
        secret = secrets.token_urlsafe(48)
        alice = secrets.token_urlsafe(24)
        bob = secrets.token_urlsafe(24)
        fixture_env = {
            "LISFRANC_DATABASE_URL": admin_dsn,
            "LISFRANC_PROXY_TOKEN": secret,
            "LISFRANC_APP_ORIGIN": origin,
        }
        for name in fixture_env:
            os.environ.pop(f"{name}_FILE", None)
        os.environ.update(fixture_env)
        sys.path.insert(0, str(EXT))
        run_checked([sys.executable, "-B", "-m", "server.manage", "init"])
        accessions = run / "accessions.csv"
        accessions.write_text("accession_number\nSYNTHETIC-0001\nSYNTHETIC-0002\nSYNTHETIC-0003\n", encoding="utf-8")
        mapping = run / "study-map.csv"
        mapping.write_text(
            f"accession_number,study_instance_uid\nSYNTHETIC-0001,{STUDY}\n"
            f"SYNTHETIC-0002,{CALIBRATED_STUDY}\nSYNTHETIC-0003,{LEGACY_MULTIFRAME_STUDY}\n",
            encoding="utf-8",
        )
        intake = [sys.executable, "-B", "-m", "server.intake", str(accessions), "--study-map", str(mapping)]
        run_checked(intake)
        with psycopg.connect(admin_dsn) as connection:
            assert connection.execute("SELECT COUNT(*) FROM lisfranc_clinical.studies").fetchone()[0] == 0
        run_checked([*intake, "--apply"])
        with psycopg.connect(admin_dsn) as connection:
            assert connection.execute(
                "SELECT study_uid FROM lisfranc_clinical.studies ORDER BY study_uid"
            ).fetchall() == [(CALIBRATED_STUDY,), (LEGACY_MULTIFRAME_STUDY,), (STUDY,)]
            connection.execute((EXT / "deployment/grants.sql").read_text(encoding="utf-8"))
        runtime_dsn = psycopg.conninfo.make_conninfo(admin_dsn, user="lisfranc_app")
        with psycopg.connect(runtime_dsn) as connection:
            privileges = connection.execute("""
                SELECT current_user,
                       has_table_privilege(current_user, 'lisfranc_clinical.review_events', 'UPDATE'),
                       has_table_privilege(current_user, 'lisfranc_clinical.review_events', 'DELETE'),
                       has_table_privilege(current_user, 'lisfranc_clinical.studies', 'INSERT')
            """).fetchone()
            assert privileges == ("lisfranc_app", False, False, False), privileges
        os.environ["LISFRANC_DATABASE_URL"] = runtime_dsn
        from server.app import app, API_PREFIX

        accounts = {"fixture-alice": alice, "fixture-bob": bob}
        gateway = synthetic_proxy(app, dist, secret, accounts, API_PREFIX)
        http = uvicorn.Server(uvicorn.Config(gateway, host="127.0.0.1", access_log=False, log_level="warning"))
        thread = threading.Thread(target=http.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 15
            while not http.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not http.started:
                raise RuntimeError("Synthetic OHIF test gateway did not start")
            # The browser runner receives only fixture Basic credentials. The secret
            # trusted proxy credential and database DSN stay in the Python side.
            child_env = {key: value for key, value in os.environ.items() if key not in {
                "LISFRANC_PROXY_TOKEN", "LISFRANC_DATABASE_URL", "LISFRANC_APP_ORIGIN"
            }}
            child_env.update({
                "LISFRANC_TEST_PASSWORD_A": alice,
                "LISFRANC_TEST_PASSWORD_B": bob,
            })
            if browser:
                child_env["LISFRANC_BROWSER_EXECUTABLE"] = str(browser)
            run_checked(
                ["node", str(EXT / "tests/shared-workspaces-smoke.mjs"), origin + "/"],
                env=child_env, timeout=140,
            )
            with psycopg.connect(admin_dsn) as connection:
                events = connection.execute(
                    """SELECT revision, status, updated_by FROM lisfranc_clinical.review_events
                    WHERE study_uid = %s ORDER BY revision""",
                    (STUDY,),
                ).fetchall()
                assert events == [
                    (1, "draft", "fixture-alice"),
                    (2, "draft", "fixture-alice"),
                    (3, "draft", "fixture-alice"),
                    (4, "draft", "fixture-alice"),
                    (5, "approved", "fixture-alice"),
                    (6, "draft", "fixture-bob"),
                ], events
                metric_events = connection.execute(
                    """SELECT revision, status, updated_by FROM lisfranc_clinical.review_events
                    WHERE study_uid = %s ORDER BY revision""",
                    (CALIBRATED_STUDY,),
                ).fetchall()
                assert metric_events == [(revision, "draft", "fixture-alice") for revision in range(1, 7)], metric_events
                assert connection.execute("SELECT COUNT(*) FROM lisfranc_clinical.studies").fetchone()[0] == 3
                assert connection.execute(
                    "SELECT COUNT(*) FROM lisfranc_clinical.review_events WHERE study_uid = %s",
                    (LEGACY_MULTIFRAME_STUDY,),
                ).fetchone()[0] == 0
                print("PASS append-only database audit named both synthetic reviewers with contiguous revisions.", flush=True)
        finally:
            http.should_exit = True
            thread.join(20)
            if thread.is_alive():
                raise RuntimeError("Synthetic gateway did not stop")


def main():
    options = argparse.ArgumentParser(description=__doc__)
    mode = options.add_mutually_exclusive_group()
    mode.add_argument("--postgres-only", action="store_true")
    mode.add_argument("--api-only", action="store_true")
    options.add_argument("--dist", type=Path, help="Pinned OHIF viewer production build")
    options.add_argument("--work-dir", type=Path, required=True, help="Parent directory for the disposable cluster and logs")
    options.add_argument("--browser", type=Path)
    args = options.parse_args()
    if args.dist is None and not (args.postgres_only or args.api_only):
        options.error("--dist is required for browser verification")
    if os.name != "nt" and os.geteuid() == 0:
        options.error("Run the disposable fixture as an unprivileged user")
    work_dir = args.work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="lisfranc-shared-fixture-", dir=work_dir)).resolve()
    assert run.is_relative_to(work_dir)
    server = start_disposable_pg(run)
    try:
        with psycopg.connect(server.get_uri()) as connection:
            listener = connection.execute("SHOW listen_addresses").fetchone()[0]
            assert listener in ("127.0.0.1", ""), listener
            version = connection.execute("SHOW server_version").fetchone()[0]
            print(f"PostgreSQL {version}, local isolated fixture ready", flush=True)
        if not args.postgres_only:
            verify_api(server)
            if not args.api_only:
                smoke(server, args.dist.resolve(), args.browser, run)
    finally:
        server.cleanup()
        assert not (run / "pgdata/postmaster.pid").exists(), "Temporary PostgreSQL server still running"
        print("Synthetic database stopped.", flush=True)


if __name__ == "__main__":
    main()
