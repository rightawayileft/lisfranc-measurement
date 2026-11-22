"""Synthetic inputs only. Enrollment tests never read a production DSN."""

from server import intake


def csv_file(tmp_path, name, rows):
    path = tmp_path / name
    path.write_text(rows, encoding="utf-8")
    return str(path)


def no_connection(*args):
    raise AssertionError("This command must not access any database.")


def test_dry_run_matches_exact_values_and_consolidates_duplicates(tmp_path, monkeypatch, capsys):
    accessions = csv_file(tmp_path, "list.csv", "\ufeffaccession_number\n00010\n00010\n10\na-45\n")
    study_map = csv_file(tmp_path, "map.csv",
                         "\ufeffstudy_instance_uid,accession_number\n2.25.100,00010\n"
                         "2.25.100,00010\n2.25.200,10\n2.25.200,a-45\n")
    monkeypatch.setattr(intake, "setting", no_connection)
    monkeypatch.setattr(intake, "enroll_studies", no_connection)
    assert intake.main([accessions, "--study-map", study_map]) == 0
    output = capsys.readouterr()
    assert output.err == ""
    assert "4 CSV rows, 3 distinct accessions, 2 distinct studies" in output.out
    assert "No database changes." in output.out
    assert "00010" not in output.out and "2.25." not in output.out


def test_unresolved_apply_reports_rows_without_writing_partial_batch(tmp_path, monkeypatch, capsys):
    accessions = csv_file(tmp_path, "list.csv",
                          "accession_number\n00010\nA-45\n00010\nmatched\n")
    study_map = csv_file(tmp_path, "map.csv",
                         "accession_number,study_instance_uid\n00010,2.25.100\n"
                         "00010,2.25.101\na-45,2.25.102\nmatched,2.25.200\n")
    monkeypatch.setattr(intake, "setting", no_connection)
    monkeypatch.setattr(intake, "enroll_studies", no_connection)
    assert intake.main([accessions, "--study-map", study_map, "--apply"]) == 2
    output = capsys.readouterr()
    assert output.out == ""
    assert "Missing study match at accession list row(s): 3." in output.err
    assert "Multiple study matches at accession list row(s): 2, 4." in output.err
    assert "00010" not in output.err and "A-45" not in output.err and "2.25." not in output.err


def test_apply_enrolls_all_distinct_study_uids_in_one_call(tmp_path, monkeypatch, capsys):
    accessions = csv_file(tmp_path, "list.csv", "accession_number\n123\n00123\noriginal\nalias\noriginal\n")
    study_map = csv_file(tmp_path, "map.csv",
                         "accession_number,study_instance_uid\n123,2.25.100\n00123,2.25.200\n"
                         "original,2.25.300\nalias,2.25.300\n")
    calls = []
    monkeypatch.setattr(intake, "setting", lambda name: "fixture-only")
    monkeypatch.setattr(intake, "enroll_studies", lambda dsn, uids: calls.append((dsn, uids)))
    assert intake.main([accessions, "--study-map", study_map, "--apply"]) == 0
    assert calls == [("fixture-only", {"2.25.100", "2.25.200", "2.25.300"})]
    output = capsys.readouterr()
    assert "Applied enrollment for 5 CSV rows, 4 distinct accessions, 3 distinct studies." in output.out
    assert output.err == ""


def test_invalid_map_or_input_is_redacted_and_does_not_write(tmp_path, monkeypatch, capsys):
    accessions = csv_file(tmp_path, "list.csv", "accession_number\nfixture-accession\n")
    study_map = csv_file(tmp_path, "map.csv",
                         "accession_number,study_instance_uid\nfixture-accession,invalid-fixture-uid\n")
    monkeypatch.setattr(intake, "setting", no_connection)
    monkeypatch.setattr(intake, "enroll_studies", no_connection)
    assert intake.main([accessions, "--study-map", study_map, "--apply"]) == 2
    output = capsys.readouterr()
    assert "row 2 has an invalid StudyInstanceUID" in output.err
    assert "fixture-accession" not in output.err and "invalid-fixture-uid" not in output.err
    malformed = csv_file(tmp_path, "malformed.csv", "accession_number\n\"fixture-accession\"extra\n")
    assert intake.main([malformed, "--study-map", study_map]) == 2
    output = capsys.readouterr()
    assert "not valid CSV near row 2" in output.err and "fixture-accession" not in output.err


def test_local_header_source_passes_only_requested_accessions(tmp_path, monkeypatch, capsys):
    accessions = csv_file(tmp_path, "list.csv", "accession_number\n00010\n")
    calls = []

    def fake_headers(directory, requested):
        calls.append((directory, set(requested)))
        return {"00010": {"2.25.100"}}

    monkeypatch.setattr(intake, "read_dicom_headers", fake_headers)
    monkeypatch.setattr(intake, "setting", no_connection)
    assert intake.main([accessions, "--dicom-directory", str(tmp_path)]) == 0
    assert calls == [(tmp_path, {"00010"})]
    output = capsys.readouterr()
    assert "1 CSV rows, 1 distinct accessions, 1 distinct studies" in output.out
