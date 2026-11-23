import math
import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StringConstraints, model_validator

UID_PATTERN = r"^[0-9]+(?:\.[0-9]+)*$"
UID = Annotated[str, StringConstraints(max_length=64, pattern=UID_PATTERN)]
FrameNumber = Annotated[int, Field(ge=1, le=2147483647)]
Revision = Annotated[int, Field(ge=0, le=9007199254740990)]
Status = Literal["draft", "approved", "rejected", "skipped"]
Relation = Literal["separated", "overlap", "unknown"]
ViewSource = Literal["dicom_ap", "reviewer_confirmed_ap"]
PointName = Literal["c1_proximal", "c1_distal", "m2_tangent", "m2_proximal", "m2_distal"]


def valid_uid(value: str) -> bool:
    return len(value) <= 64 and re.fullmatch(UID_PATTERN, value) is not None


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ClaimWrite(InputModel):
    leaseId: Annotated[UUID, Field(strict=False)]


class Point(InputModel):
    x: Annotated[FiniteFloat, Field(ge=0)]
    y: Annotated[FiniteFloat, Field(ge=0)]


class Spacing(InputModel):
    row_mm: Annotated[FiniteFloat, Field(gt=0, le=1000)]
    col_mm: Annotated[FiniteFloat, Field(gt=0, le=1000)]
    source: Literal["DICOM Pixel Spacing (GEOMETRY)", "DICOM Pixel Spacing (FIDUCIAL)"]


class Frame(InputModel):
    studyUID: UID
    seriesUID: UID
    sopUID: UID
    frameNumber: FrameNumber
    rows: Annotated[int, Field(ge=2, le=65535)]
    columns: Annotated[int, Field(ge=2, le=65535)]
    view: Literal["ap", "non_ap", "unknown"]
    supportedModality: bool
    spacing: Spacing | None

    @property
    def key(self) -> tuple[str, str, str, int]:
        return self.studyUID, self.seriesUID, self.sopUID, self.frameNumber


class ReviewWrite(InputModel):
    baseRevision: Revision
    frame: Frame
    points: dict[PointName, Point | None]
    relation: Relation | None
    status: Status
    viewSource: ViewSource | None
    spacing: Spacing | None

    @model_validator(mode="after")
    def validate_landmarks(self):
        for point in self.points.values():
            if point is not None and (point.x > self.frame.columns - 1 or point.y > self.frame.rows - 1):
                raise ValueError("Landmark coordinates must lie inside the source image.")
        return self

    def normalized_points(self) -> dict:
        return {name: point.model_dump() for name, point in self.points.items() if point is not None}

    def valid_approval(self) -> bool:
        a, b, q, c, d = (
            self.points.get(name) for name in
            ("c1_proximal", "c1_distal", "m2_tangent", "m2_proximal", "m2_distal")
        )
        valid_tangent = bool(a and b and q and math.hypot(b.x - a.x, b.y - a.y) >= 1)
        valid_proxy = (c is None and d is None) or (c is not None and d is not None and c != d)
        return self.relation is not None and valid_tangent and valid_proxy
