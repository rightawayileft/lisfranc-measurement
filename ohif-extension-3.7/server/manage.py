import argparse
from collections.abc import Iterable
from pathlib import Path

from .config import setting
from .model import valid_uid
from .store import connection, lock_study


def set_study_active(dsn: str, study_uid: str, *, active: bool) -> bool:
    if active:
        return bool(enroll_studies(dsn, [study_uid]))
    if not valid_uid(study_uid):
        raise ValueError("Provide a valid DICOM StudyInstanceUID.")
    with connection(dsn) as conn:
        lock_study(conn, study_uid, exclusive=True)
        result = conn.execute("""
            UPDATE lisfranc_clinical.studies SET active = false WHERE study_uid = %s
        """, (study_uid,))
        if result.rowcount:
            conn.execute("DELETE FROM lisfranc_clinical.study_claims WHERE study_uid = %s", (study_uid,))
        return result.rowcount > 0


def enroll_studies(dsn: str, study_uids: Iterable[str]) -> int:
    uids = sorted(set(study_uids))
    if not all(valid_uid(study_uid) for study_uid in uids):
        raise ValueError("Provide valid DICOM StudyInstanceUIDs.")
    with connection(dsn) as conn:
        for study_uid in uids:
            lock_study(conn, study_uid, exclusive=True)
            conn.execute("""
                INSERT INTO lisfranc_clinical.studies (study_uid) VALUES (%s)
                ON CONFLICT (study_uid) DO UPDATE SET active = true
            """, (study_uid,))
    return len(uids)


def main():
    parser = argparse.ArgumentParser(description="Manage a dedicated Lisfranc Clinical database.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="Create the Clinical schema and tables.")
    enroll = commands.add_parser("enroll", help="Enroll one reviewer-approved study.")
    enroll.add_argument("study_uid")
    deactivate = commands.add_parser("deactivate", help="Hide a study from clinical review and retain its history.")
    deactivate.add_argument("study_uid")
    args = parser.parse_args()
    dsn = setting("LISFRANC_DATABASE_URL")
    if args.command == "init":
        schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
        with connection(dsn, autocommit=True) as conn:
            conn.execute(schema)
        print("Clinical schema is ready.")
    else:
        if not valid_uid(args.study_uid):
            parser.error("Provide a valid DICOM StudyInstanceUID.")
        active = args.command == "enroll"
        if not set_study_active(dsn, args.study_uid, active=active):
            parser.error("Clinical study was never enrolled.")
        print("Clinical study enrolled." if active else
              "Clinical study deactivated. Existing reviews remain in the database.")


if __name__ == "__main__":
    main()
