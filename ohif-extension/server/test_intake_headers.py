import logging

import pytest
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import DeflatedExplicitVRLittleEndian, DigitalXRayImageStorageForPresentation, ExplicitVRLittleEndian

from . import intake_headers


def write_dicom(file, accession, uid=None, syntax=ExplicitVRLittleEndian):
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = syntax
    meta.MediaStorageSOPClassUID = DigitalXRayImageStorageForPresentation
    meta.MediaStorageSOPInstanceUID = "2.25.30"
    ds = FileDataset(str(file), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.AccessionNumber = accession
    if uid is not None:
        ds.StudyInstanceUID = uid
    ds.BitsAllocated = 8
    ds.PixelData = b"\x00\x01\x02\x03"
    ds.save_as(file, enforce_file_format=True)


def test_resolves_only_exact_requested_accessions_from_dicom_headers(tmp_path, monkeypatch):
    requested = "000052"
    path = tmp_path / "radiographs"
    path.mkdir()
    write_dicom(path / "header.dcm", requested, "2.25.40")
    write_dicom(path / "no-extension", requested, "2.25.40")
    write_dicom(path / "other.dcm", "52", "2.25.41")
    write_dicom(path / "competing.dcm", requested, "2.25.42")
    (path / "notes.txt").write_text("Do not force non-DICOM input.", encoding="utf-8")
    actual_dcmread = intake_headers.dcmread
    checked = []

    def inspect_dcmread(filename, **kwargs):
        assert kwargs == {
            "force": False, "stop_before_pixels": True,
            "specific_tags": ("AccessionNumber", "StudyInstanceUID"),
        }
        result = actual_dcmread(filename, **kwargs)
        assert "PixelData" not in result
        checked.append(filename.name)
        return result

    monkeypatch.setattr(intake_headers, "dcmread", inspect_dcmread)
    assert intake_headers.resolve_accessions(tmp_path, {requested, "missing"}) == {
        requested: {"2.25.40", "2.25.42"},
    }
    assert set(checked) == {"header.dcm", "no-extension", "other.dcm", "competing.dcm"}


def test_missing_study_uid_fails_without_disclosing_accession_or_path(tmp_path, caplog):
    requested = "SYNTH-NOT-LOGGED"
    destination = tmp_path / "private-filename.dcm"
    write_dicom(destination, requested)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(ValueError, match="Could not resolve an input DICOM header") as raised:
            intake_headers.resolve_accessions(tmp_path, {requested})
    redacted = str(raised.value) + caplog.text
    assert requested not in redacted
    assert destination.name not in redacted


def test_deflated_dicom_is_rejected_before_dataset_read(tmp_path, monkeypatch):
    write_dicom(tmp_path / "deflated.dcm", "SYNTH-DEF", "2.25.40", DeflatedExplicitVRLittleEndian)

    def forbidden_reader(*args, **kwargs):
        pytest.fail("Deflated DICOM must be rejected before whole-file inflation.")

    monkeypatch.setattr(intake_headers, "dcmread", forbidden_reader)
    with pytest.raises(ValueError, match="trusted study map"):
        intake_headers.resolve_accessions(tmp_path, {"SYNTH-DEF"})


def test_linked_dicom_is_ignored(tmp_path):
    inside = tmp_path / "inside"
    inside.mkdir()
    outside = tmp_path / "outside.dcm"
    write_dicom(outside, "SYNTH-OUTSIDE", "2.25.91")
    try:
        (inside / "link.dcm").symlink_to(outside)
    except OSError:
        pytest.skip("The test host does not permit symlink creation.")
    assert intake_headers.resolve_accessions(inside, {"SYNTH-OUTSIDE"}) == {}
