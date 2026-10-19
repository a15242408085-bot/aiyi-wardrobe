"""Durable AI workflow orchestration for the single-process local application.

Queued work, local video processing, and video tasks with saved remote IDs can
resume safely. Interrupted image generation requires an explicit retry because
the provider may have charged the request before the response was persisted.
"""

import asyncio
import hashlib
import logging
import math
import shutil
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image
from sqlalchemy import select, update

from app.config import get_settings
from app.database import async_session_maker
from app.models.ai_task import AITask
from app.models.item import ClothingItem, ItemStatus, TaggedBy, TaggingStatus
from app.schemas.ai_task import CandidateConfirmation, ConfirmRecognition
from app.services.aiyi_provider import AIProviderError, get_aiyi_provider
from app.services.aiyi_video_provider import get_video_provider
from app.services.image_service import ImageService
from app.services.rotation_media import (
    RotationMediaError, extract_rotation_frames, validate_and_store_video,
)
from app.utils.garment_vocabulary import TYPES, canonical_colors
from app.utils.signed_urls import sign_image_url
from app.utils.uploads import UploadTooLargeError, read_upload_within_limit

logger = logging.getLogger(__name__)
settings = get_settings()
_tasks: dict[UUID, asyncio.Task] = {}
_semaphore: asyncio.Semaphore | None = None
_stopping = False

TRY_ON_GROUPS = {
    **dict.fromkeys(("shirt", "t-shirt", "top", "sweater", "polo", "blouse", "tank-top"), "top"),
    **dict.fromkeys(("jacket", "coat", "hoodie", "blazer", "vest", "cardigan"), "outerwear"),
    **dict.fromkeys(("pants", "jeans", "shorts", "skirt"), "bottom"),
    **dict.fromkeys(("shoes", "sneakers", "boots", "sandals"), "shoes"),
    "bag": "bag",
}
CATALOG_GROUPS = dict(TRY_ON_GROUPS)
INTERRUPTED_MESSAGE = "服务重启时任务尚未完成。上一次生成可能已计费，请确认后手动重试。"


def owned_image_path(user_id: UUID, relative_path: str) -> Path:
    """Resolve only a single filename inside this user's media directory."""
    parts = Path(relative_path).parts
    if len(parts) != 2 or parts[0] != str(user_id) or parts[1] in {".", ".."}:
        raise ValueError("图片不属于当前用户")
    service = ImageService()
    path = service.get_image_path(relative_path)
    owner_root = (service.storage_path / str(user_id)).resolve()
    if not path.resolve().is_relative_to(owner_root):
        raise ValueError("图片路径无效")
    return path


async def store_upload(user_id: UUID, upload: UploadFile) -> dict[str, str]:
    try:
        content = await read_upload_within_limit(upload, settings.max_upload_size_mb)
    except UploadTooLargeError:
        raise HTTPException(413, "图片超过上传大小限制") from None
    service = ImageService()
    if not service.validate_image(content, upload.content_type or ""):
        raise HTTPException(400, "请选择有效的 JPEG、PNG、WebP 或 HEIC 图片")
    try:
        return await service.process_and_store(user_id, content, upload.filename or "upload.jpg")
    except Exception:
        raise HTTPException(400, "无法读取图片，请换一张清晰且尺寸合适的图片") from None


def public_job(job: AITask) -> dict:
    result = dict(job.result or {})
    if "candidates" in result:
        result["candidates"] = [
            {
                **{key: value for key, value in candidate.items() if key not in {"paths", "bbox"}},
                "image_url": sign_image_url(candidate["paths"]["image_path"]),
                "source_image_url": sign_image_url(job.inputs["source"]["image_path"]),
            }
            for candidate in result["candidates"]
        ]
    output_path = result.pop("image_path", None)
    if output_path:
        result["image_url"] = sign_image_url(output_path)
    # File paths and provider task IDs stay private; clients receive signed URLs.
    result.pop("paths", None)
    frame_paths = result.pop("frame_paths", None)
    if frame_paths:
        result["frame_urls"] = [sign_media_url(path) for path in frame_paths]
    video_path = result.pop("video_path", None) or job.inputs.get("video_path")
    if video_path:
        result["video_url"] = sign_media_url(video_path)
    if job.kind == "rotation":
        result.update({key: job.inputs[key] for key in ("origin", "name", "remove_green", "source_job_id") if key in job.inputs})
    source_path = job.inputs.get("source", {}).get("image_path")
    return {
        "id": str(job.id), "kind": job.kind, "status": job.status,
        "stage": job.stage, "progress": job.progress, "attempt": job.attempt,
        "source_image_url": sign_image_url(source_path) if source_path else None,
        "result": result, "error": job.error,
        "created_at": job.created_at, "updated_at": job.updated_at,
    }


async def find_job(db, user_id: UUID, task_id: UUID) -> AITask:
    job = await db.scalar(select(AITask).where(AITask.id == task_id, AITask.user_id == user_id))
    if job is None:
        raise HTTPException(404, "找不到此任务")
    return job


async def ensure_capacity(db, user_id: UUID) -> None:
    active = await db.scalars(select(AITask.id).where(
        AITask.user_id == user_id, AITask.status.in_(("queued", "running"))
    ).limit(2))
    if len(active.all()) >= 2:
        raise HTTPException(429, "已有两个任务正在处理，请稍后再试")


def sign_media_url(path: str) -> str:
    return sign_image_url(path).replace("/api/v1/images/", "/api/v1/ai/media/", 1)


def require_provider(user_id: UUID, capability: str = "image"):
    try:
        return get_aiyi_provider(user_id, capability=capability)
    except AIProviderError as error:
        raise HTTPException(503, str(error)) from None


def require_video_provider(user_id: UUID):
    try:
        return get_video_provider(user_id)
    except AIProviderError as error:
        raise HTTPException(503, str(error)) from None


async def create_job(db, user_id: UUID, kind: str, inputs: dict, result: dict | None = None) -> AITask:
    job = AITask(user_id=user_id, kind=kind, inputs=inputs, result=result or {})
    db.add(job)
    # The worker has a different session and must not race an uncommitted row.
    await db.commit()
    await db.refresh(job)
    schedule_job(job.id)
    return job


def schedule_job(task_id: UUID) -> None:
    if _stopping:
        return
    if task_id in _tasks:
        # A retry may arrive after the failure was committed but before its
        # coroutine finishes closing the DB session. Run it after that task exits.
        _tasks[task_id].add_done_callback(lambda _task: schedule_job(task_id))
        return
    task = asyncio.create_task(_run_job(task_id), name=f"aiyichu-job-{task_id}")
    _tasks[task_id] = task
    task.add_done_callback(lambda _task: _tasks.pop(task_id, None))


async def start_task_worker() -> None:
    global _semaphore, _stopping
    if not settings.local_development:
        return
    _stopping = False
    _semaphore = asyncio.Semaphore(2)
    async with async_session_maker() as db:
        interrupted = list((await db.scalars(select(AITask).where(
            AITask.status.in_(("running", "interrupted"))
        ))).all())
        for job in interrupted:
            # A persisted video ID can be polled without re-submitting a paid
            # generation. Imported/downloaded videos only need local processing.
            safe_rotation = job.kind == "rotation" and (
                job.inputs.get("remote_id") or job.inputs.get("video_path")
            )
            if safe_rotation:
                job.status, job.stage, job.error = "queued", "恢复转身处理", None
            elif job.status == "running":
                job.status, job.stage, job.error = "interrupted", "等待手动重试", INTERRUPTED_MESSAGE
        await db.flush()
        queued = list((await db.scalars(select(AITask.id).where(AITask.status == "queued"))).all())
        await db.commit()
    for task_id in queued:
        schedule_job(task_id)


async def stop_task_worker() -> None:
    global _stopping
    _stopping = True
    pending = list(_tasks.values())
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    _tasks.clear()
    # No provider calls are made during shutdown. Leave queued work resumable.
    if settings.local_development:
        async with async_session_maker() as db:
            await db.execute(update(AITask).where(AITask.status == "running").values(
                status="interrupted", stage="等待手动重试", error=INTERRUPTED_MESSAGE
            ))
            await db.commit()


async def _set_stage(task_id: UUID, stage: str, progress: int) -> None:
    async with async_session_maker() as db:
        await db.execute(update(AITask).where(AITask.id == task_id, AITask.status == "running").values(
            stage=stage, progress=progress
        ))
        await db.commit()


async def _run_job(task_id: UUID) -> None:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(2)
    async with _semaphore:
        async with async_session_maker() as db:
            claimed = await db.execute(update(AITask).where(
                AITask.id == task_id, AITask.status == "queued"
            ).values(status="running", stage="准备处理", progress=10, attempt=AITask.attempt + 1))
            await db.commit()
            if claimed.rowcount != 1:
                return
            job = await db.get(AITask, task_id)
        try:
            if job.kind == "recognition":
                result = await _run_recognition(job)
                new_status, stage = "awaiting_confirmation", "识别完成，请确认入库"
            elif job.kind == "rotation":
                result = await _run_rotation(job)
                new_status, stage = "completed", "61 帧转身处理完成"
            elif job.kind == "catalog":
                provider = get_aiyi_provider(job.user_id, capability="image")
                source = owned_image_path(job.user_id, job.inputs["source"]["image_path"]).read_bytes()
                await _set_stage(task_id, "生成干净的单品图", 30)
                output = await provider.product_image(source, job.inputs["candidate"])
                paths = await _store_generated(job.user_id, output)
                result = {"paths": paths, "image_path": paths["image_path"],
                          "item_id": job.inputs["item_id"], "applied": False}
                new_status, stage = "completed", "单品图已生成，请确认应用"
            elif job.kind == "try_on":
                provider = get_aiyi_provider(job.user_id, capability="image")
                source = owned_image_path(job.user_id, job.inputs["source"]["image_path"]).read_bytes()
                garments = []
                for garment in job.inputs["garments"]:
                    garments.append({
                        "image": owned_image_path(job.user_id, garment["image_path"]).read_bytes(),
                        "type": garment["type"], "name": garment["name"],
                    })
                await _set_stage(task_id, "AI 正在生成试穿效果", 30)
                output = await provider.try_on(source, garments, job.inputs.get("prompt", ""))
                await _set_stage(task_id, "保存试穿结果", 90)
                paths = await _store_generated(job.user_id, output)
                result = {"image_path": paths["image_path"], "item_ids": job.inputs["item_ids"]}
                if job.inputs.get("model_id"):
                    result["model_id"] = job.inputs["model_id"]
                new_status, stage = "completed", "试穿生成完成"
            else:
                raise ValueError("Unsupported task kind")
            async with async_session_maker() as db:
                await db.execute(update(AITask).where(AITask.id == task_id).values(
                    status=new_status, stage=stage, progress=100, result=result, error=None
                ))
                await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Arbitrary SDK/transport exception strings can contain request headers.
            # Only explicitly sanitised provider messages are exposed.
            message = str(error) if isinstance(error, (AIProviderError, RotationMediaError)) else "任务处理失败，请检查图片并重试"
            logger.warning("AI job %s failed (%s)", task_id, type(error).__name__)
            async with async_session_maker() as db:
                failure = {"status": "failed", "stage": "处理失败", "error": message}
                if (job.kind == "rotation" and isinstance(error, AIProviderError)
                        and error.code == "submission_unknown" and not job.inputs.get("remote_id")):
                    failure["inputs"] = {**job.inputs, "submission_unknown": True}
                await db.execute(update(AITask).where(AITask.id == task_id).values(**failure))
                await db.commit()


async def _store_generated(user_id: UUID, output: bytes) -> dict:
    service = ImageService()
    if not isinstance(output, bytes) or not service.validate_image(output, "image/png"):
        raise AIProviderError("invalid_image", "AI 没有返回可用的图片，请重试")
    return await service.process_and_store(user_id, output, "generated.png")


async def _persist_result(job: AITask, result: dict) -> None:
    async with async_session_maker() as db:
        await db.execute(update(AITask).where(AITask.id == job.id).values(result=result))
        await db.commit()
    job.result = result


async def _persist_inputs(job: AITask, updates: dict) -> None:
    async with async_session_maker() as db:
        current = await db.get(AITask, job.id)
        current.inputs = {**current.inputs, **updates}
        await db.commit()
        job.inputs = dict(current.inputs)


async def _run_recognition(job: AITask) -> dict:
    source = owned_image_path(job.user_id, job.inputs["source"]["image_path"]).read_bytes()
    wants_products = job.inputs.get("generate_product_images", False)
    candidates = job.result.get("candidates")
    if not candidates:
        provider = get_aiyi_provider(job.user_id, capability="recognition")
        await _set_stage(job.id, "识别衣物种类和颜色", 20)
        raw = await provider.analyze(source)
        if wants_products:
            by_group = {}
            for candidate in raw:
                group = CATALOG_GROUPS.get(candidate.get("type"))
                if group and group not in by_group:
                    by_group[group] = candidate
            raw = list(by_group.values())
        candidates = await _prepare_candidates(job, raw)
        for candidate in candidates:
            candidate["generation_status"] = "pending" if wants_products else "not_requested"
        await _persist_result(job, {"candidates": candidates})
    if wants_products:
        provider = get_aiyi_provider(job.user_id, capability="image")
        for index, candidate in enumerate(candidates):
            if candidate.get("generation_status") in {"completed", "failed"}:
                continue
            await _set_stage(job.id, f"生成单品图 {index + 1}/{len(candidates)}", 30 + int(60 * index / len(candidates)))
            candidate["generation_status"] = "running"
            await _persist_result(job, {"candidates": candidates})
            try:
                # Full source + target description lets the model reconstruct a
                # garment; the original crop remains available for comparison.
                output = await provider.product_image(source, candidate)
                paths = await _store_generated(job.user_id, output)
                candidate.update(paths=paths, image_kind="generated", generation_status="completed", generation_error=None)
                candidate["crop_warning"] = "这是 AI 生成的单品图，请对照原图核对颜色、图案和被遮挡细节。"
            except asyncio.CancelledError:
                raise
            except Exception as error:
                candidate["generation_status"] = "failed"
                candidate["generation_error"] = str(error) if isinstance(error, AIProviderError) else "单品图生成失败，已保留原图裁剪"
            await _persist_result(job, {"candidates": candidates})
    return {"candidates": candidates}


async def _run_rotation(job: AITask) -> dict:
    video_path = job.inputs.get("video_path")
    if not video_path:
        provider = get_video_provider(job.user_id)
        source = owned_image_path(job.user_id, job.inputs["source"]["image_path"]).read_bytes()

        async def submitted(remote_id: str):
            if not isinstance(remote_id, str) or not remote_id or len(remote_id) > 255:
                raise AIProviderError("invalid_task", "视频服务没有返回有效的任务编号")
            await _persist_inputs(job, {"remote_id": remote_id})
            await _set_stage(job.id, "云端转身视频生成中", 35)

        await _set_stage(job.id, "继续查询转身视频" if job.inputs.get("remote_id") else "提交转身视频", 20)
        video = await provider.generate(source, job.inputs.get("remote_id"), submitted)
        stored = await validate_and_store_video(job.user_id, video)
        video_path = stored["video_path"]
        await _persist_inputs(job, {"video_path": video_path})
    await _set_stage(job.id, "抽取 61 张转身图片", 75)
    result = await extract_rotation_frames(job.user_id, video_path, job.inputs.get("remove_green", False))
    return {**result, "origin": job.inputs["origin"], "name": job.inputs["name"],
            "remove_green": job.inputs.get("remove_green", False),
            **({"source_job_id": job.inputs["source_job_id"]} if job.inputs.get("source_job_id") else {})}


async def _prepare_candidates(job: AITask, candidates: list[dict]) -> list[dict]:
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 8:
        raise AIProviderError("no_garments", "未识别出可入库的衣物，请换一张清晰的衣物照片")
    service = ImageService()
    original_paths = job.inputs["source"]
    with Image.open(owned_image_path(job.user_id, original_paths["image_path"])) as original:
        image = original.convert("RGB")
    prepared = []
    for raw in candidates:
        kind = raw.get("type", "top")
        if kind not in TYPES:
            kind = "top"
        name = str(raw.get("name") or "待确认衣物").strip()[:100] or "待确认衣物"
        colors = canonical_colors([str(value)[:50] for value in (raw.get("colors") or [])[:8]])
        primary_color = str(raw.get("primary_color") or (colors[0] if colors else ""))[:50] or None
        season = [value for value in (raw.get("season") or []) if value in {
            "spring", "summer", "fall", "winter"
        }]
        candidate = CandidateConfirmation(
            candidate_id=str(uuid4()), name=name, type=kind, colors=colors,
            primary_color=primary_color, season=list(dict.fromkeys(season))[:4],
            material=str(raw["material"])[:50] if raw.get("material") else None,
            notes=str(raw["notes"])[:2000] if raw.get("notes") else None,
        ).model_dump()
        bbox = raw.get("bbox")
        finite_box = (
            isinstance(bbox, (list, tuple)) and len(bbox) == 4
            and all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) for value in bbox)
        )
        # Keep the model's unexpanded box for internal diagnosis; public_job hides it.
        candidate["bbox"] = list(bbox) if finite_box else None
        valid_box = (
            finite_box and all(0 <= value <= 1 for value in bbox)
            and bbox[2] - bbox[0] >= 0.03 and bbox[3] - bbox[1] >= 0.03
        )
        if valid_box:
            width, height = image.size
            # Tight model boxes can clip collars, cuffs, hems or bag/shoe edges.
            # Expand relative to the source size and round outward, without padding
            # beyond the photo or inventing pixels outside its actual boundaries.
            margin = 0.025
            crop = image.crop((
                max(0, math.floor((bbox[0] - margin) * width)),
                max(0, math.floor((bbox[1] - margin) * height)),
                min(width, math.ceil((bbox[2] + margin) * width)),
                min(height, math.ceil((bbox[3] + margin) * height)),
            ))
            buffer = BytesIO()
            crop.save(buffer, format="JPEG", quality=95)
            candidate["paths"] = await service.process_and_store(job.user_id, buffer.getvalue(), "crop.jpg")
            candidate["image_kind"] = "crop"
            candidate["crop_warning"] = "这是原图裁剪，可能包含人物或背景，请确认衣物范围。"
        else:
            candidate["paths"] = dict(original_paths)
            candidate["image_kind"] = "source"
            candidate["crop_warning"] = "AI 没有提供可靠的衣物范围，暂保留整张原图；确认前请检查。"
        prepared.append(candidate)
    return prepared


async def confirm_recognition(db, job: AITask, payload: ConfirmRecognition) -> AITask:
    if job.kind != "recognition":
        raise HTTPException(400, "此任务不是衣物识别")
    if job.status == "completed":
        return job
    if job.status != "awaiting_confirmation":
        raise HTTPException(409, "识别尚未完成，暂不能确认入库")
    candidates = {candidate["candidate_id"]: candidate for candidate in job.result.get("candidates", [])}
    if any(candidate.candidate_id not in candidates for candidate in payload.candidates):
        raise HTTPException(400, "候选衣物不属于此识别任务")
    # The conditional write locks this task before any item is inserted. Repeated
    # confirmation is safe even when two browser requests arrive simultaneously.
    claimed = await db.execute(update(AITask).where(
        AITask.id == job.id, AITask.user_id == job.user_id, AITask.status == "awaiting_confirmation"
    ).values(status="completed", stage="衣物已入库"))
    if claimed.rowcount != 1:
        await db.refresh(job)
        if job.status == "completed":
            return job
        raise HTTPException(409, "任务状态已变化，请刷新")
    item_ids = []
    saved_candidates = []
    now = datetime.now(UTC)
    image_service = ImageService()
    for candidate in payload.candidates:
        existing = candidates[candidate.candidate_id]
        # A garment is independently deletable. Do not give it ownership of the
        # task's source/candidate files, which other candidates still reference.
        paths = await image_service.process_and_store(
            job.user_id,
            owned_image_path(job.user_id, existing["paths"]["image_path"]).read_bytes(),
            "garment.jpg",
        )
        original_path = f"{job.user_id}/{uuid4().hex}_original.jpg"
        shutil.copyfile(
            owned_image_path(job.user_id, job.inputs["source"]["image_path"]),
            owned_image_path(job.user_id, original_path),
        )
        item_id = uuid4()
        data = candidate.model_dump()
        tags = {key: data[key] for key in ("colors", "primary_color", "season", "material")}
        item = ClothingItem(
            id=item_id, user_id=job.user_id,
            image_path=paths["image_path"], thumbnail_path=paths.get("thumbnail_path"),
            medium_path=paths.get("medium_path"), image_hash=paths.get("image_hash"),
            original_image_path=original_path,
            name=candidate.name, type=candidate.type, colors=candidate.colors,
            primary_color=candidate.primary_color, season=candidate.season,
            material=candidate.material, notes=candidate.notes, tags=tags,
            ai_description=existing.get("notes"), ai_processed=True,
            status=ItemStatus.ready, tagging_status=TaggingStatus.tagged,
            tagged_by=TaggedBy.auto, tagged_at=now, ai_completed_at=now,
            ai_raw_response={"source": "aiyichu_recognition", "task_id": str(job.id)},
            upload_key=f"ai-{job.id.hex}-{candidate.candidate_id[:8]}",
        )
        db.add(item)
        item_ids.append(str(item_id))
        saved_candidates.append({**existing, **data})
    job.result = {**job.result, "candidates": saved_candidates, "item_ids": item_ids}
    job.status, job.stage, job.progress = "completed", "衣物已入库", 100
    await db.commit()
    await db.refresh(job)
    return job


async def apply_catalog(db, job: AITask) -> AITask:
    if job.kind != "catalog" or job.status != "completed":
        raise HTTPException(409, "单品图尚未生成完成")
    if job.result.get("applied"):
        return job
    item = await db.scalar(select(ClothingItem).where(
        ClothingItem.id == UUID(job.inputs["item_id"]), ClothingItem.user_id == job.user_id,
        ClothingItem.is_archived.is_(False),
    ))
    if item is None:
        raise HTTPException(404, "原衣物已不存在，无法应用单品图")
    if item.image_path != job.inputs["item_image_path"]:
        await db.refresh(job)
        if job.result.get("applied"):
            return job
        raise HTTPException(409, "这件衣物的图片已更新，请重新生成单品图后应用")
    claimed = await db.execute(update(AITask).where(
        AITask.id == job.id, AITask.user_id == job.user_id,
        AITask.status == "completed", AITask.stage != "已应用到衣橱",
    ).values(stage="已应用到衣橱"))
    if claimed.rowcount != 1:
        await db.refresh(job)
        return job
    expected_hash = job.inputs.get("item_image_sha256")
    if expected_hash:
        try:
            current_hash = hashlib.sha256(owned_image_path(job.user_id, item.image_path).read_bytes()).hexdigest()
        except OSError:
            raise HTTPException(409, "原衣物图片不可用，请重新上传") from None
        if current_hash != expected_hash:
            raise HTTPException(409, "这件衣物的图片内容已更新，请重新生成单品图后应用")
    service = ImageService()
    paths = await service.process_and_store(job.user_id,
        owned_image_path(job.user_id, job.result["image_path"]).read_bytes(), "catalog.jpg")
    # The previous full image remains owned by the clothing item, and the task's
    # generated image remains independent of future clothing-item deletion.
    changed = await db.execute(update(ClothingItem).where(
        ClothingItem.id == item.id, ClothingItem.user_id == job.user_id,
        ClothingItem.image_path == job.inputs["item_image_path"],
        ClothingItem.is_archived.is_(False),
    ).values(
        original_image_path=item.original_image_path or item.image_path,
        image_path=paths["image_path"], thumbnail_path=paths["thumbnail_path"],
        medium_path=paths["medium_path"], image_hash=paths.get("image_hash"),
        ai_raw_response={**(item.ai_raw_response or {}), "catalog_task_id": str(job.id)},
    ))
    if changed.rowcount != 1:
        service.delete_images({key: paths[key] for key in ("image_path", "thumbnail_path", "medium_path")})
        raise HTTPException(409, "这件衣物的图片已更新，请重新生成单品图后应用")
    job.result = {**job.result, "applied": True}
    job.stage = "已应用到衣橱"
    await db.commit()
    await db.refresh(job)
    return job
