"""WaveSpeed submission + resumable polling, without automatically resubmitting."""

import asyncio
import ipaddress
import re
import socket
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from app.services.aiyi_provider import AIProviderError, AIYIProvider, prepare_image
from app.services.aiyi_settings import AIServiceInput, AISettingsInput, read_service_settings

MAX_VIDEO_BYTES = 100 * 1024 * 1024


def validate_media_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.fragment or len(url) > 8192):
            raise ValueError
        if parsed.hostname.lower() == "localhost" or parsed.hostname.lower().endswith((".localhost", ".local")):
            raise ValueError
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            address = None
        if address and not address.is_global:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise AIProviderError("invalid_response", "视频服务返回的媒体地址不符合要求。") from None
    return url


async def validate_public_destination(url: str) -> None:
    host = urlsplit(validate_media_url(url)).hostname
    try:
        records = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not records or any(not ipaddress.ip_address(row[4][0]).is_global for row in records):
            raise ValueError
    except (OSError, ValueError):
        raise AIProviderError("invalid_response", "视频下载地址无法解析为可访问的公网地址。") from None


class WaveSpeedProvider(AIYIProvider):
    def __init__(self, config: AIServiceInput, transport: httpx.AsyncBaseTransport | None = None,
                 poll_interval: float = 4, poll_attempts: int = 450):
        self.service = config
        self.poll_interval = poll_interval
        self.poll_attempts = poll_attempts
        super().__init__(AISettingsInput(provider="openai_compatible", base_url=config.base_url,
            vision_model=config.model, image_model=config.model, api_key=config.api_key), transport)

    async def _wave(self, method: str, path: str, **kwargs):
        body = await self._request(method, path, timeout=60, **kwargs)
        if body.get("code", 200) != 200:
            raise AIProviderError("provider_error", "视频服务未接受请求，请检查密钥权限和服务商账户。")
        return body.get("data", body)

    async def check(self) -> dict:
        await self._wave("GET", "/balance")
        models = await self._wave("GET", "/models")
        if not isinstance(models, list):
            raise AIProviderError("invalid_response", "视频服务未返回有效的模型列表。")
        return {"status": "connected", "model_listed": any(
            x.get("model_id", x.get("id")) == self.service.model for x in models if isinstance(x, dict)),
            "message": "视频服务已连通；尚未发起付费视频生成。"}

    async def _download_video(self, url: str) -> bytes:
        await validate_public_destination(url)
        try:
            # The output host can be a storage CDN. Never forward provider auth.
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=20), follow_redirects=False,
                                         transport=self.transport) as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise AIProviderError("download", "视频下载未完成，可重试取回同一远端任务。")
                    media_type = response.headers.get("content-type", "").split(";")[0]
                    if media_type and not (media_type.startswith("video/") or media_type == "application/octet-stream"):
                        raise AIProviderError("invalid_response", "服务返回内容不是视频。")
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_VIDEO_BYTES:
                            raise AIProviderError("invalid_response", "生成视频超过 100 MB，请降低分辨率。")
                        chunks.append(chunk)
                    if not size:
                        raise AIProviderError("invalid_response", "服务返回了空视频。")
                    return b"".join(chunks)
        except httpx.RequestError:
            raise AIProviderError("download", "视频下载连接中断，可重试取回同一远端任务。") from None

    async def generate(self, image: bytes, remote_id: str | None = None,
                       on_submitted: Callable[[str], Awaitable[None]] | None = None) -> bytes:
        if not remote_id:
            # For small image inputs the documented legacy binary endpoint avoids
            # exposing localhost images and keeps credentials on the API host.
            normalized = await asyncio.to_thread(prepare_image, image)
            upload = await self._wave("POST", "/media/upload/binary",
                files={"file": ("rotation-source.jpg", normalized, "image/jpeg")})
            if not isinstance(upload, dict) or not isinstance(upload.get("download_url"), str):
                raise AIProviderError("invalid_response", "视频服务未返回上传图片地址。")
            source_url = validate_media_url(upload["download_url"])
            try:
                submission = await self._wave("POST", "/" + self.service.model, json={
                    "image": source_url, "last_image": source_url,
                    "prompt": (
                        "One continuous full-body wardrobe turntable shot. The person in the reference turns "
                        "slowly one complete 360-degree revolution and returns to the exact starting orientation. "
                        "Keep the camera fully fixed, the entire body and shoes visible, and the person centered. "
                        "Preserve the same facial identity, hairstyle, body proportions, garment shapes, colors, "
                        "prints, materials, lighting and background. Keep arms in the same relaxed position. "
                        "No walking, gestures, camera orbit, zoom, cuts, labels, extra people or audio. "
                        "Start and end on the supplied identical reference frame."
                    ),
                    "aspect_ratio": "9:16", "resolution": "480p", "duration": 4,
                    "enable_web_search": False, "generate_audio": False,
                })
            except AIProviderError as error:
                if error.code in {"connection", "timeout", "invalid_response", "provider_error"}:
                    raise AIProviderError("submission_unknown",
                        "视频请求已发送，但未能确认提交结果。请先核对服务商任务和账单，避免重复付费。") from None
                raise
            remote_id = submission.get("id") if isinstance(submission, dict) else None
            if not isinstance(remote_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", remote_id):
                raise AIProviderError("submission_unknown", "视频请求已发送但未收到有效任务编号，请先检查服务商记录，避免重复付费。")
            if on_submitted:
                await on_submitted(remote_id)
        if not isinstance(remote_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", remote_id):
            raise AIProviderError("invalid_request", "远端视频任务编号不正确。")
        for attempt in range(self.poll_attempts):
            result = await self._wave("GET", f"/predictions/{remote_id}/result")
            if not isinstance(result, dict):
                raise AIProviderError("invalid_response", "视频任务状态无法读取，请稍后恢复同一任务。")
            status = result.get("status")
            if status == "completed":
                outputs = result.get("outputs")
                if not isinstance(outputs, list) or not outputs or not isinstance(outputs[0], str):
                    raise AIProviderError("invalid_response", "视频任务完成但未返回有效视频地址。")
                return await self._download_video(outputs[0])
            if status in {"failed", "cancelled", "timeout", "deleted"}:
                raise AIProviderError("remote_failed", "视频服务报告任务失败或已取消，请先查看服务商任务记录。")
            if status not in {"created", "pending", "queued", "processing", "running"}:
                raise AIProviderError("invalid_response", "视频服务返回了未知状态，已保留任务编号。")
            if attempt + 1 < self.poll_attempts:
                await asyncio.sleep(min(self.poll_interval * (1 + attempt // 30), 15))
        raise AIProviderError("timeout", "视频仍在处理，已保留远端任务编号，稍后可继续查询。")


def get_video_provider(user_id: UUID) -> WaveSpeedProvider:
    try:
        config, _ = read_service_settings(user_id, "rotation")
        if config.provider != "wavespeed":
            raise ValueError("请配置 WaveSpeed 视频服务")
    except ValueError as error:
        raise AIProviderError("configuration_error", str(error)) from None
    if not config.api_key:
        raise AIProviderError("not_configured", "尚未配置视频服务密钥。可先导入自己的转身视频，或到设置填写视频接口。")
    return WaveSpeedProvider(config)
