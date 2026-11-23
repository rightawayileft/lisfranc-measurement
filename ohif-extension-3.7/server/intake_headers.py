"""Resolve approved local accession requests without loading DICOM pixels."""

import logging
import os
import stat
import warnings
from collections import defaultdict
from collections.abc import Collection, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from pydicom import dcmread
from pydicom.errors import InvalidDicomError
from pydicom.filereader import read_file_meta_info
from pydicom.uid import DeflatedExplicitVRLittleEndian

from .model import valid_uid

HEADER_TAGS = ("AccessionNumber", "StudyInstanceUID")


def regular_entry(path: Path, *, directory: bool) -> bool:
    metadata = path.lstat()
    # Windows junctions are reparse points even when is_symlink() is false.
    if getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
        return False
    return stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)


def local_files(root: Path) -> Iterator[Path]:
    def on_walk_error(error):
        raise OSError("Could not read a directory within the local DICOM source.") from None

    for directory, children, files in os.walk(root, followlinks=False, onerror=on_walk_error):
        folder = Path(directory)
        children[:] = [name for name in children if regular_entry(folder / name, directory=True)]
        for name in files:
            path = folder / name
            if regular_entry(path, directory=False) and path.resolve(strict=True).is_relative_to(root):
                yield path


@contextmanager
def private_dicom_read():
    # pydicom warnings and diagnostic logs can expose header values and paths.
    # Intake runs as a standalone operator command, not an API request.
    logger = logging.getLogger("pydicom")
    previous = logger.disabled
    logger.disabled = True
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            yield
    finally:
        logger.disabled = previous


def read_header(path: Path):
    try:
        meta = read_file_meta_info(path)
    except InvalidDicomError:
        return None
    if meta.get("TransferSyntaxUID") == DeflatedExplicitVRLittleEndian:
        # For this syntax pydicom inflates the entire dataset even when asked
        # to stop before PixelData. Ask the operator to use an authoritative map.
        raise ValueError("A DICOM file uses deflated encoding. Supply a trusted study map instead.")
    return dcmread(path, force=False, stop_before_pixels=True, specific_tags=HEADER_TAGS)


def resolve_accessions(directory: Path, accessions: Collection[str]) -> dict[str, set[str]]:
    if not regular_entry(directory, directory=True):
        raise ValueError("Choose a real local DICOM directory.")
    root = directory.resolve(strict=True)
    requested = set(accessions)
    matches: dict[str, set[str]] = defaultdict(set)
    with private_dicom_read():
        for path in local_files(root):
            try:
                header = read_header(path)
                if header is None:
                    continue
                accession = header.get("AccessionNumber")
                if not isinstance(accession, str):
                    if isinstance(accession, Sequence) and any(
                        isinstance(item, str) and item in requested for item in accession
                    ):
                        raise ValueError("A matching DICOM object has multiple accession values.")
                    continue
                if accession not in requested:
                    continue
                study_uid = header.get("StudyInstanceUID")
                if not isinstance(study_uid, str) or not valid_uid(study_uid):
                    raise ValueError("A matching DICOM object has a missing or invalid StudyInstanceUID.")
                matches[accession].add(str(study_uid))
            except (OSError, ValueError, EOFError, OverflowError, NotImplementedError, KeyError):
                raise ValueError("Could not resolve an input DICOM header. Use verified local headers or a trusted study map.") from None
    return dict(matches)
