"""Local workspace API configuration; never returns API keys."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.config import get_settings
from app.models.user import User
from app.services.aiyi_provider import AIProviderError, AIYIProvider, get_aiyi_provider
from app.services.aiyi_settings import (
    AISettingsInput, AISettingsPublic, clear_api_key,
    public_api_settings, read_api_settings, save_api_settings,
    AIServiceInput, AIServicePublic, Capability, clear_service_key,
    public_service_settings, save_service_settings,
)
from app.utils.auth import get_current_user


def local_only():
    if not get_settings().local_development:
        raise HTTPException(404, "Not found")


router = APIRouter(prefix="/ai/settings", tags=["Aiyichu AI settings"], dependencies=[Depends(local_only)])
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=AISettingsPublic)
async def read_settings(user: CurrentUser):
    try:
        return public_api_settings(user.id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.put("", response_model=AISettingsPublic)
async def update_settings(data: AISettingsInput, user: CurrentUser):
    try:
        return save_api_settings(user.id, data)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.delete("/key", response_model=AISettingsPublic)
async def remove_key(user: CurrentUser):
    try:
        return clear_api_key(user.id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/check")
async def check_settings(user: CurrentUser):
    try:
        config, _ = read_api_settings(user.id)
        return await AIYIProvider(config).check()
    except AIProviderError as exc:
        raise HTTPException(503, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


services_router = APIRouter(prefix="/ai/services", tags=["Aiyichu AI services"], dependencies=[Depends(local_only)])


@services_router.get("")
async def read_services(user: CurrentUser):
    try:
        return {name: public_service_settings(user.id, name) for name in ("recognition", "image", "rotation")}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@services_router.put("/{capability}", response_model=AIServicePublic)
async def update_service(capability: Capability, data: AIServiceInput, user: CurrentUser):
    try:
        return save_service_settings(user.id, capability, data)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@services_router.delete("/{capability}/key", response_model=AIServicePublic)
async def remove_service_key(capability: Capability, user: CurrentUser):
    try:
        return clear_service_key(user.id, capability)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@services_router.post("/{capability}/check")
async def check_service(capability: Capability, user: CurrentUser):
    try:
        if capability == "rotation":
            from app.services.aiyi_video_provider import get_video_provider
            return await get_video_provider(user.id).check()
        result = await get_aiyi_provider(user.id, capability).check()
        if "model_listed" not in result:
            result["model_listed"] = result.get("vision_model_listed" if capability == "recognition" else "image_model_listed")
        return result
    except AIProviderError as exc:
        raise HTTPException(503, str(exc)) from None
