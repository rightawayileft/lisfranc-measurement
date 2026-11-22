"""Resolve accession numbers offline and enroll only their StudyInstanceUIDs."""

import argparse
from collections import defaultdict
from collections.abc import Collection, Iterator
import csv
from pathlib import Path
import sys

import psycopg

from .config import setting
from .manage import enroll_studies
from .model import valid_uid


class IntakeError(ValueError):
    """Input problem whose message is safe for an operator console."""


def csv_rows(path: Path, label: str, columns: set[str]) -> Iterator[tuple[int, dict[str, str]]]:
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader, [])
                if set(header) != columns or len(header) != len(columns):
                    names = ", ".join(sorted(columns))
                    raise IntakeError(f"{label} must have these CSV headers: {names}.")
                for row in reader:
                    if not row:
                        continue
                    if len(row) != len(header):
                        raise IntakeError(f"{label} row {reader.line_num} has the wrong number of columns.")
                    yield reader.line_num, dict(zip(header, row, strict=True))
            except csv.Error:
                raise IntakeError(f"{label} is not valid CSV near row {reader.line_num}.") from None
    except (OSError, UnicodeError):
        raise IntakeError(f"Could not read {label} as UTF-8 CSV.") from None


def exact_accession(value: str, label: str, line: int) -> str:
    if not value.strip() or not value.isprintable():
        raise IntakeError(f"{label} row {line} has an empty or invalid accession field.")
    return value


def read_requests(path: Path) -> dict[str, list[int]]:
    requested: dict[str, list[int]] = defaultdict(list)
    for line, fields in csv_rows(path, "Accession list", {"accession_number"}):
        accession = exact_accession(fields["accession_number"], "Accession list", line)
        requested[accession].append(line)
    if not requested:
        raise IntakeError("The accession list does not contain any data rows.")
    return dict(requested)


def read_study_map(path: Path, requested: Collection[str]) -> dict[str, set[str]]:
    matches: dict[str, set[str]] = defaultdict(set)
    for line, fields in csv_rows(path, "Study map", {"accession_number", "study_instance_uid"}):
        accession = exact_accession(fields["accession_number"], "Study map", line)
        uid = fields["study_instance_uid"]
        if not valid_uid(uid):
            raise IntakeError(f"Study map row {line} has an invalid StudyInstanceUID.")
        if accession in requested:
            matches[accession].add(uid)
    return dict(matches)


def resolve_requests(requested: dict[str, list[int]], matches: dict[str, set[str]]) -> set[str]:
    missing = []
    ambiguous = []
    study_uids = set()
    for accession, rows in requested.items():
        studies = matches.get(accession, set())
        if not studies:
            missing.extend(rows)
        elif len(studies) > 1:
            ambiguous.extend(rows)
        else:
            study_uids.update(studies)
    if missing or ambiguous:
        problems = []
        if missing:
            problems.append(f"Missing study match at accession list row(s): {row_summary(missing)}.")
        if ambiguous:
            problems.append(f"Multiple study matches at accession list row(s): {row_summary(ambiguous)}.")
        raise IntakeError(" ".join(problems))
    return study_uids


def row_summary(rows: list[int]) -> str:
    limit = 30
    indices = ", ".join(str(line) for line in sorted(rows)[:limit])
    return indices if len(rows) <= limit else f"{indices} and {len(rows) - limit} more"


def read_dicom_headers(directory: Path, requested: Collection[str]) -> dict[str, set[str]]:
    try:
        from .intake_headers import resolve_accessions
        return resolve_accessions(directory, requested)
    except (ImportError, OSError, ValueError):
        raise IntakeError("Could not resolve the local DICOM header directory.") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Enroll studies from local accession lists. Defaults to dry-run.")
    parser.add_argument("accessions", type=Path, help="CSV with one accession_number column")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--study-map", type=Path, help="trusted accession_number,study_instance_uid CSV")
    source.add_argument("--dicom-directory", type=Path, help="read accession and study UID from local DICOM headers")
    parser.add_argument("--apply", action="store_true", help="enroll all resolved study UIDs in the configured database")
    args = parser.parse_args(argv)

    try:
        requested = read_requests(args.accessions)
        matches = (read_study_map(args.study_map, requested) if args.study_map else
                   read_dicom_headers(args.dicom_directory, requested))
        study_uids = resolve_requests(requested, matches)
    except IntakeError as failure:
        print(f"{failure} No studies enrolled.", file=sys.stderr)
        return 2

    rows = sum(len(lines) for lines in requested.values())
    summary = f"{rows} CSV rows, {len(requested)} distinct accessions, {len(study_uids)} distinct studies."
    if not args.apply:
        print(f"Dry run matched {summary} No database changes.")
        return 0

    try:
        dsn = setting("LISFRANC_DATABASE_URL")
        enroll_studies(dsn, study_uids)
    except (OSError, ValueError, psycopg.Error):
        print("Could not confirm enrollment. Verify the database configuration and retry the batch.", file=sys.stderr)
        return 1
    print(f"Applied enrollment for {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
