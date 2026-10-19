"""User-scoped local API settings. Credentials never enter task records/media."""

import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from app.config import get_settings

OFFICIAL_BASE = "https://api.openai.com/v1"


class AISettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    provider: Literal["openai", "openai_compatible"] = "openai"
    base_url: str = OFFICIAL_BASE
    vision_model: str = Field(default="gpt-4.1-mini", min_length=1, max_length=120)
    image_model: str = Field(default="gpt-image-1.5", min_length=1, max_length=120)
    quality: Literal["low", "medium", "high"] = "medium"
    api_key: SecretStr | None = None

    @field_validator("base_url")
    @classmethod
    def validate_base(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError:
            raise ValueError("API 地址格式不正确") from None
        if (not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or port == 0):
            raise ValueError("请填写不含密钥、用户名或查询参数的 API 基础地址")
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
            raise ValueError("远程 API 地址必须使用 HTTPS；本机服务可以使用 HTTP")
        if len(value) > 400 or any(ord(c) < 33 for c in value):
            raise ValueError("API 地址不正确")
        return value

    @field_validator("vision_model", "image_model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise ValueError("请填写模型标识，例如 gpt-image-1.5")
        return value

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        raw = value.get_secret_value().strip()
        if len(raw) > 1024 or any(ord(c) < 33 or ord(c) > 126 for c in raw):
            raise ValueError("API 密钥格式不正确")
        return SecretStr(raw) if raw else None

    @model_validator(mode="after")
    def official_destination(self):
        if self.provider == "openai" and self.base_url != OFFICIAL_BASE:
            raise ValueError("自定义 API 地址请选择 OpenAI 兼容服务")
        return self


class AISettingsPublic(BaseModel):
    configured: bool
    provider: str
    base_url: str
    vision_model: str
    image_model: str
    quality: str
    key_source: Literal["saved", "environment", "none"]


def _path(user_id: UUID) -> Path:
    settings = get_settings()
    root = Path(settings.aiyi_config_path) if settings.aiyi_config_path else (
        Path(settings.storage_path).parent / "aiyi-config"
    )
    return root / f"{UUID(str(user_id))}.json"


def _fernet() -> Fernet:
    digest = hashlib.sha256(("aiyichu-api-settings-v1:" + get_settings().secret_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _read(user_id: UUID) -> dict:
    path = _path(user_id)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, OSError):
        raise ValueError("本地 API 配置无法读取，请重新保存设置。") from None


def _environment() -> AISettingsInput:
    settings = get_settings()
    key = settings.aiyi_api_key
    if not key and settings.aiyi_base_url == OFFICIAL_BASE:
        raw = os.environ.get("OPENAI_API_KEY", "")
        key = SecretStr(raw) if raw else None
    return AISettingsInput(
        provider=settings.aiyi_provider, base_url=settings.aiyi_base_url,
        vision_model=settings.aiyi_vision_model, image_model=settings.aiyi_image_model,
        quality=settings.aiyi_quality, api_key=key,
    )


def read_api_settings(user_id: UUID) -> tuple[AISettingsInput, str]:
    env = _environment()
    saved = _read(user_id)
    config = AISettingsInput(**(saved.get("config") or env.model_dump(exclude={"api_key"})))
    encrypted = saved.get("encrypted_api_key")
    if encrypted:
        try:
            config.api_key = SecretStr(_fernet().decrypt(encrypted.encode()).decode())
        except (InvalidToken, ValueError, UnicodeError):
            raise ValueError("保存的 API 密钥无法解密，请重新填写密钥。") from None
        return config, "saved"
    # Never silently forward an environment credential to a different endpoint.
    if (not saved.get("key_disabled") and env.api_key
            and config.provider == env.provider and config.base_url == env.base_url):
        config.api_key = env.api_key
        return config, "environment"
    return config, "none"


def public_api_settings(user_id: UUID) -> AISettingsPublic:
    config, source = read_api_settings(user_id)
    return AISettingsPublic(
        **config.model_dump(exclude={"api_key"}),
        configured=bool(config.api_key), key_source=source,
    )


def _write(user_id: UUID, value: dict) -> None:
    path = _path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix=".settings-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save_api_settings(user_id: UUID, config: AISettingsInput) -> AISettingsPublic:
    old = _read(user_id)
    previous = old.get("config", _environment().model_dump(exclude={"api_key"}))
    same_endpoint = all(previous.get(k) == getattr(config, k) for k in ("provider", "base_url"))
    value = {"config": config.model_dump(exclude={"api_key"})}
    if config.api_key:
        value["encrypted_api_key"] = _fernet().encrypt(config.api_key.get_secret_value().encode()).decode()
    elif same_endpoint:
        value["encrypted_api_key"] = old.get("encrypted_api_key")
        value["key_disabled"] = old.get("key_disabled", False)
    else:
        value["key_disabled"] = True
    _write(user_id, value)
    return public_api_settings(user_id)


def clear_api_key(user_id: UUID) -> AISettingsPublic:
    old = _read(user_id)
    old.pop("encrypted_api_key", None)
    old["key_disabled"] = True
    _write(user_id, old)
    return public_api_settings(user_id)


# Separate destinations: a vision key must never be forwarded to the image or
# video provider. Legacy settings remain readable for existing installations.
Capability = Literal["recognition", "image", "rotation"]
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
WAVESPEED_BASE = "https://api.wavespeed.ai/api/v3"
DEEPSEEK_BASE = "https://api.deepseek.com"
DEEPSEEK_VISION_MODEL = "deepseek-flash"


class AIServiceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    provider: Literal["openai", "openai_compatible", "gemini", "wavespeed", "deepseek"]
    base_url: str
    model: str = Field(min_length=1, max_length=120)
    quality: Literal["low", "medium", "high"] = "medium"
    api_key: SecretStr | None = None

    @model_validator(mode="before")
    @classmethod
    def deepseek_defaults(cls, value):
        if isinstance(value, dict) and value.get("provider") == "deepseek":
            return {"base_url": DEEPSEEK_BASE, "model": DEEPSEEK_VISION_MODEL, **value}
        return value

    @field_validator("base_url")
    @classmethod
    def validate_base(cls, value):
        return AISettingsInput.validate_base(value)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value):
        value = AISettingsInput.validate_model(value)
        if any(part in {".", "..", ""} for part in value.split("/")) or any(c in value for c in "?#%\\"):
            raise ValueError("模型标识不正确")
        return value

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value):
        return AISettingsInput.validate_key(value)

    @model_validator(mode="after")
    def official_destination(self):
        if self.provider == "openai" and self.base_url != OFFICIAL_BASE:
            raise ValueError("自定义 API 地址请选择 OpenAI 兼容服务")
        if self.provider == "wavespeed" and self.base_url != WAVESPEED_BASE:
            raise ValueError("WaveSpeed 服务使用 https://api.wavespeed.ai/api/v3")
        if self.provider == "deepseek" and urlsplit(self.base_url).scheme != "https":
            raise ValueError("DeepSeek 服务及代理地址必须使用 HTTPS")
        return self


class AIServicePublic(BaseModel):
    configured: bool
    provider: str
    base_url: str
    model: str
    quality: str
    key_source: Literal["saved", "environment", "none"]


def _service_path(user_id: UUID, capability: Capability) -> Path:
    if capability not in {"recognition", "image", "rotation"}:
        raise ValueError("未知的 AI 服务")
    return _path(user_id).with_name(f"{UUID(str(user_id))}-{capability}.json")


def _service_defaults(user_id: UUID, capability: Capability) -> tuple[AIServiceInput, str]:
    if capability == "rotation":
        return AIServiceInput(provider="wavespeed", base_url=WAVESPEED_BASE,
                              model="bytedance/seedance-2.0/image-to-video"), "none"
    legacy, source = read_api_settings(user_id)
    return AIServiceInput(
        provider=legacy.provider, base_url=legacy.base_url,
        model=legacy.vision_model if capability == "recognition" else legacy.image_model,
        quality=legacy.quality, api_key=legacy.api_key,
    ), source


def read_service_settings(user_id: UUID, capability: Capability) -> tuple[AIServiceInput, str]:
    path = _service_path(user_id, capability)
    if not path.exists():
        return _service_defaults(user_id, capability)
    try:
        saved = json.loads(path.read_text())
        config = AIServiceInput(**saved["config"])
        encrypted = saved.get("encrypted_api_key")
        if encrypted:
            config.api_key = SecretStr(_fernet().decrypt(encrypted.encode()).decode())
        return config, "saved" if encrypted else "none"
    except (ValueError, KeyError, TypeError, AttributeError, InvalidToken, OSError):
        raise ValueError("本地服务配置无法读取或解密，请重新保存该服务配置。") from None


def public_service_settings(user_id: UUID, capability: Capability) -> AIServicePublic:
    config, source = read_service_settings(user_id, capability)
    return AIServicePublic(**config.model_dump(exclude={"api_key"}),
                           configured=bool(config.api_key), key_source=source)


def save_service_settings(user_id: UUID, capability: Capability, config: AIServiceInput) -> AIServicePublic:
    if config.provider == "deepseek" and capability != "recognition":
        raise ValueError("DeepSeek 仅用于衣物识别；图片生成和视频转身请选择对应服务")
    if (capability == "rotation") != (config.provider == "wavespeed"):
        raise ValueError("视频转身请选择 WaveSpeed；识别和图片生成请选择图片或多模态服务")
    path = _service_path(user_id, capability)
    # Blank retains only this capability's credential, at this exact destination.
    key = config.api_key
    if not key:
        previous, _ = read_service_settings(user_id, capability)
        if (config.provider, config.base_url) == (previous.provider, previous.base_url):
            key = previous.api_key
    value = {"config": config.model_dump(exclude={"api_key"})}
    if key:
        value["encrypted_api_key"] = _fernet().encrypt(key.get_secret_value().encode()).decode()
    _write_service_file(path, value)
    return public_service_settings(user_id, capability)


def _write_service_file(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".service-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def clear_service_key(user_id: UUID, capability: Capability) -> AIServicePublic:
    config, _ = read_service_settings(user_id, capability)
    _write_service_file(_service_path(user_id, capability),
                        {"config": config.model_dump(exclude={"api_key"})})
    return public_service_settings(user_id, capability)
