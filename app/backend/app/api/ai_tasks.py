"""Authenticated endpoints for local wardrobe recognition and virtual try-on."""

import json
import hashlib
import re
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update

from app.config import get_settings
from app.database import DbSession
from app.models.ai_task import AITask
from app.models.item import ClothingItem, ItemStatus
from app.schemas.ai_task import ConfirmRecognition
from app.services.aiyi_tasks import (
    TRY_ON_GROUPS,
    apply_catalog,
    confirm_recognition,
    create_job,
    ensure_capacity,
    find_job,
    owned_image_path,
    public_job,
    require_provider,
    require_video_provider,
    schedule_job,
    store_upload,
)
from app.services.image_service import ImageService
from app.services.rotation_media import RotationMediaError, validate_and_store_video
from app.utils.auth import CurrentUser, CurrentUserOptional
from app.utils.signed_urls import verify_signature
from app.utils.uploads import UploadTooLargeError, read_upload_within_limit


def local_only():
    if not get_settings().local_development:
        raise HTTPException(503, "AI 工作台目前仅在本地开发模式开放")


router = APIRouter(prefix="/ai", tags=["AI Workflows"], dependencies=[Depends(local_only)])


@router.post("/recognitions", status_code=202)
async def start_recognition(
    db: DbSession, current_user: CurrentUser, image: UploadFile = File(...),
    generate_product_images: bool = Form(False),
):
    require_provider(current_user.id, "recognition")
    if generate_product_images:
        require_provider(current_user.id, "image")
    await ensure_capacity(db, current_user.id)
    paths = await store_upload(current_user.id, image)
    return public_job(await create_job(db, current_user.id, "recognition", {
        "source": paths, "generate_product_images": generate_product_images,
    }))


@router.post("/try-ons", status_code=202)
async def start_try_on(
    db: DbSession, current_user: CurrentUser,
    item_ids: str = Form(...), person_image: UploadFile | None = File(None),
    model_id: UUID | None = Form(None),
    prompt: Annotated[str, Form(max_length=1000)] = "",
):
    require_provider(current_user.id)
    await ensure_capacity(db, current_user.id)
    if (person_image is None) == (model_id is None):
        raise HTTPException(422, "请上传人物照片或选择一位模特，二者只选一项")
    try:
        raw_ids = json.loads(item_ids)
        if not isinstance(raw_ids, list) or not 1 <= len(raw_ids) <= 5:
            raise ValueError
        ids = [UUID(value) for value in raw_ids]
        if len(set(ids)) != len(ids):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "请选择 1 至 5 件不同的衣物或包") from None
    items = list((await db.scalars(select(ClothingItem).where(
        ClothingItem.id.in_(ids), ClothingItem.user_id == current_user.id,
        ClothingItem.is_archived.is_(False), ClothingItem.status == ItemStatus.ready,
    ))).all())
    if len(items) != len(ids):
        raise HTTPException(404, "部分衣物不存在、尚未就绪或不属于当前用户")
    groups = [TRY_ON_GROUPS.get(item.type) for item in items]
    if None in groups:
        raise HTTPException(422, "当前试穿支持上衣、外套、下装、鞋和包，请取消其他分类")
    if len(set(groups)) != len(groups):
        raise HTTPException(422, "每次试穿同一分类最多选择一件")
    if model_id:
        model = await find_job(db, current_user.id, model_id)
        if model.kind != "model" or model.status != "completed":
            raise HTTPException(404, "此人物模特不可用")
        source = await ImageService().process_and_store(current_user.id,
            owned_image_path(current_user.id, model.result["image_path"]).read_bytes(), "model.jpg")
    else:
        source = await store_upload(current_user.id, person_image)
    # Preserve the selected files for retry even if an item is edited or deleted.
    garments = []
    service = ImageService()
    for item in sorted(items, key=lambda item: ids.index(item.id)):
        try:
            content = owned_image_path(current_user.id, item.image_path).read_bytes()
        except (OSError, ValueError):
            raise HTTPException(409, "部分衣物图片已不可用，请重新上传") from None
        paths = await service.process_and_store(current_user.id, content, "garment.jpg")
        garments.append({"image_path": paths["image_path"], "type": item.type, "name": item.name or item.type})
    return public_job(await create_job(db, current_user.id, "try_on", {
        "source": source, "garments": garments, "item_ids": [str(value) for value in ids], "prompt": prompt,
        "model_id": str(model_id) if model_id else None,
    }))


@router.get("/jobs")
async def list_jobs(
    db: DbSession, current_user: CurrentUser,
    kind: Literal["recognition", "try_on", "catalog", "model", "rotation"] | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    filters = [AITask.user_id == current_user.id]
    if kind:
        filters.append(AITask.kind == kind)
    total = await db.scalar(select(func.count()).select_from(AITask).where(*filters))
    jobs = await db.scalars(select(AITask).where(*filters).order_by(
        AITask.created_at.desc(), AITask.id.desc()
    ).offset(offset).limit(limit))
    public = [public_job(job) for job in jobs]
    has_more = offset + len(public) < total
    return {
        "jobs": public, "total": total, "has_more": has_more,
        "next_offset": offset + len(public) if has_more else None,
    }


@router.get("/jobs/{task_id}")
async def get_job(task_id: UUID, db: DbSession, current_user: CurrentUser):
    return public_job(await find_job(db, current_user.id, task_id))


@router.post("/recognitions/{task_id}/confirm")
async def confirm(task_id: UUID, payload: ConfirmRecognition, db: DbSession, current_user: CurrentUser):
    job = await find_job(db, current_user.id, task_id)
    return public_job(await confirm_recognition(db, job, payload))


@router.post("/jobs/{task_id}/retry", status_code=202)
async def retry(task_id: UUID, db: DbSession, current_user: CurrentUser):
    job = await find_job(db, current_user.id, task_id)
    if job.status not in {"failed", "interrupted"}:
        raise HTTPException(409, "仅失败或中断的任务可以重试")
    if job.kind == "rotation":
        if job.inputs.get("submission_unknown") and not job.inputs.get("remote_id"):
            raise HTTPException(409,
                "这次视频请求的提交结果不明，为避免重复付费不能直接重试。请先在视频服务商后台核对任务；确认未提交后可新建转身任务。")
        if not job.inputs.get("video_path"):
            require_video_provider(current_user.id)
    elif job.kind == "recognition":
        if not job.result.get("candidates"):
            require_provider(current_user.id, "recognition")
        if job.inputs.get("generate_product_images"):
            require_provider(current_user.id, "image")
    else:
        require_provider(current_user.id, "image")
    await ensure_capacity(db, current_user.id)
    updated = await db.execute(update(AITask).where(
        AITask.id == job.id, AITask.user_id == current_user.id,
        AITask.status.in_(("failed", "interrupted")),
    ).values(status="queued", stage="等待重试", progress=0, error=None))
    if updated.rowcount != 1:
        raise HTTPException(409, "任务已在重试，请刷新")
    await db.commit()
    await db.refresh(job)
    schedule_job(job.id)
    return public_job(job)


@router.post("/catalog-images", status_code=202)
async def start_catalog(db: DbSession, current_user: CurrentUser, item_id: UUID = Form(...)):
    require_provider(current_user.id)
    await ensure_capacity(db, current_user.id)
    item = await db.scalar(select(ClothingItem).where(
        ClothingItem.id == item_id, ClothingItem.user_id == current_user.id,
        ClothingItem.is_archived.is_(False), ClothingItem.status == ItemStatus.ready,
    ))
    if item is None:
        raise HTTPException(404, "衣物不存在或尚未就绪")
    try:
        original = owned_image_path(current_user.id, item.image_path).read_bytes()
        source = await ImageService().process_and_store(current_user.id,
            original, "source.jpg")
    except (OSError, ValueError):
        raise HTTPException(409, "原衣物图片不可用，请重新上传") from None
    candidate = {"name": item.name or item.type, "type": item.type, "colors": item.colors,
                 "primary_color": item.primary_color, "material": item.material,
                 "notes": item.notes or item.ai_description or ""}
    return public_job(await create_job(db, current_user.id, "catalog", {
        "source": source, "item_id": str(item_id), "item_image_path": item.image_path,
        "item_image_sha256": hashlib.sha256(original).hexdigest(),
        "candidate": candidate,
    }))


@router.post("/catalog-images/{task_id}/apply")
async def apply_catalog_image(task_id: UUID, db: DbSession, current_user: CurrentUser):
    return public_job(await apply_catalog(db, await find_job(db, current_user.id, task_id)))


@router.post("/models", status_code=201)
async def create_model(
    db: DbSession, current_user: CurrentUser, image: UploadFile = File(...),
    name: Annotated[str, Form(min_length=1, max_length=100)] = "人物模特",
):
    source = await store_upload(current_user.id, image)
    name = name.strip() or "人物模特"
    job = AITask(user_id=current_user.id, kind="model", status="completed", stage="人物模特已保存",
                 progress=100, inputs={"source": source}, result={"name": name, "image_path": source["image_path"]})
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return public_job(job)


@router.post("/rotations/import", status_code=202)
async def import_rotation(
    db: DbSession, current_user: CurrentUser, video: UploadFile = File(...),
    name: Annotated[str, Form(min_length=1, max_length=100)] = "导入转身",
    remove_green: bool = Form(False),
):
    await ensure_capacity(db, current_user.id)
    if not (video.filename or "").lower().endswith((".mp4", ".mov")):
        raise HTTPException(400, "请上传 MP4 或 MOV 视频")
    try:
        raw = await read_upload_within_limit(video, 100)
        stored = await validate_and_store_video(current_user.id, raw)
    except UploadTooLargeError:
        raise HTTPException(413, "视频不能超过 100 MB") from None
    except RotationMediaError as error:
        raise HTTPException(400, str(error)) from None
    return public_job(await create_job(db, current_user.id, "rotation", {
        "video_path": stored["video_path"], "origin": "import", "name": name.strip() or "导入转身",
        "remove_green": remove_green,
    }))


@router.post("/rotations", status_code=202)
async def generate_rotation(
    db: DbSession, current_user: CurrentUser, source_job_id: UUID = Form(...),
    name: Annotated[str, Form(max_length=100)] = "", remove_green: bool = Form(False),
):
    require_video_provider(current_user.id)
    await ensure_capacity(db, current_user.id)
    source_job = await find_job(db, current_user.id, source_job_id)
    if source_job.kind not in {"model", "try_on"} or source_job.status != "completed":
        raise HTTPException(422, "请选择已保存的人物模特或已完成的试穿图")
    source = await ImageService().process_and_store(current_user.id,
        owned_image_path(current_user.id, source_job.result["image_path"]).read_bytes(), "source.jpg")
    return public_job(await create_job(db, current_user.id, "rotation", {
        "source": source, "source_job_id": str(source_job.id), "origin": "generated",
        "name": name.strip() or source_job.result.get("name") or "试穿转身",
        "remove_green": remove_green,
    }))


@router.get("/media/{user_id}/{filename}")
async def get_ai_media(
    user_id: UUID, filename: str, current_user: CurrentUserOptional,
    expires: str | None = None, sig: str | None = None,
):
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp|mp4|mov)", filename):
        raise HTTPException(400, "无效媒体路径")
    relative = f"{user_id}/{filename}"
    signed = bool(expires and sig and verify_signature(relative, expires, sig))
    if not signed and (current_user is None or current_user.id != user_id):
        raise HTTPException(401, "无权访问此媒体文件")
    path = owned_image_path(user_id, relative)
    if not path.is_file():
        raise HTTPException(404, "媒体文件不存在")
    suffix = path.suffix.lower()
    mime = {".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png",
            ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}[suffix]
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, max-age=3600, must-revalidate"})
