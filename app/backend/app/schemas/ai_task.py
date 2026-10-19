"""Public inputs for confirming AI recognition; file paths stay server-owned."""

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.color import ColorList, ColorName
from app.utils.garment_vocabulary import TYPES


class CandidateConfirmation(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=100)
    type: str = Field(min_length=1, max_length=50)
    colors: ColorList = Field(default_factory=list, max_length=8)
    primary_color: ColorName | None = None
    season: list[str] = Field(default_factory=list, max_length=4)
    material: str | None = Field(default=None, max_length=50)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("请填写衣物名称")
        return value

    @field_validator("type")
    @classmethod
    def supported_type(cls, value: str) -> str:
        if value not in TYPES:
            raise ValueError("请选择支持的衣物分类")
        return value

    @field_validator("season")
    @classmethod
    def supported_seasons(cls, values: list[str]) -> list[str]:
        if any(value not in {"spring", "summer", "fall", "winter"} for value in values):
            raise ValueError("不支持的季节")
        return list(dict.fromkeys(values))


class ConfirmRecognition(BaseModel):
    candidates: list[CandidateConfirmation] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def unique_candidates(self):
        ids = [candidate.candidate_id for candidate in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("同一件候选衣物不能重复入库")
        return self
