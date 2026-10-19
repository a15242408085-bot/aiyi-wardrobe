"""Bounded local MP4/MOV decoding and transparent PNG turntable sequences.

The input is always an owned local file. FFmpeg never follows remote manifests
or MOV data references; generated frames retain alpha independently of ImageService.
"""

import asyncio
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from uuid import UUID, uuid4

from PIL import Image, ImageChops

from app.config import get_settings

settings = get_settings()
MAX_VIDEO_BYTES = 100 * 1024 * 1024
MAX_DURATION_SECONDS = 30.0
MAX_DIMENSION = 4096
MAX_PIXELS = 8_000_000
FRAME_COUNT = 61
PROBE_TIMEOUT = 15
EXTRACT_TIMEOUT = 120
_VIDEO_BRANDS = {
    b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42",
    b"avc1", b"M4V ", b"qt  ", b"MSNV", b"dash", b"cmfc", b"cmfs",
}


class RotationMediaError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _ffmpeg_executable() -> str:
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        import imageio_ffmpeg

        executable = imageio_ffmpeg.get_ffmpeg_exe()
        if Path(executable).is_file() and os.access(executable, os.X_OK):
            return executable
    except (ImportError, RuntimeError, OSError):
        pass
    raise RotationMediaError(
        "ffmpeg_missing", "视频处理工具未安装，请安装 imageio-ffmpeg 或系统 FFmpeg 后重试"
    )


def _user_directory(user_id: UUID) -> Path:
    # UUID conversion prevents callers from supplying a path segment as an ID.
    owner = str(UUID(str(user_id)))
    storage = Path(settings.storage_path).resolve()
    directory = storage / owner
    directory.mkdir(parents=True, exist_ok=True)
    if directory.is_symlink() or directory.resolve().parent != storage:
        raise RotationMediaError("invalid_path", "视频存储路径无效")
    return directory


def _owned_video(user_id: UUID, video_path: str) -> Path:
    parts = Path(video_path).parts
    owner = str(UUID(str(user_id)))
    if len(parts) != 2 or parts[0] != owner or parts[1] in {".", ".."}:
        raise RotationMediaError("invalid_path", "视频不属于当前用户")
    directory = _user_directory(user_id)
    path = directory / parts[1]
    if path.is_symlink() or path.resolve().parent != directory or not path.is_file():
        raise RotationMediaError("invalid_path", "视频文件不存在或路径无效")
    return path


def _check_container(header: bytes, size: int) -> None:
    if not size or size > MAX_VIDEO_BYTES:
        raise RotationMediaError("video_size", "视频不能为空且不能超过 100 MB")
    if len(header) < 16 or header[4:8] != b"ftyp":
        raise RotationMediaError("invalid_video", "请选择有效的 MP4 或 MOV 视频")
    box_size = int.from_bytes(header[:4], "big")
    if box_size < 16 or box_size > size or box_size > len(header):
        raise RotationMediaError("invalid_video", "视频容器信息无效")
    brands = [header[8:12], *[header[i:i + 4] for i in range(16, box_size, 4)]]
    if not _VIDEO_BRANDS.intersection(brands):
        raise RotationMediaError("invalid_video", "暂时只支持 MP4 或 MOV 视频")


def _input_arguments(path: Path) -> list[str]:
    return [
        "-nostdin", "-hide_banner", "-loglevel", "info", "-threads", "2",
        "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0",
        "-use_absolute_path", "0", "-i", str(path),
    ]


def _run_ffmpeg(arguments: list[str], timeout: int) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [_ffmpeg_executable(), *arguments], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout,
            check=False, env={**os.environ, "LC_ALL": "C", "LANG": "C"},
        )
    except subprocess.TimeoutExpired:
        raise RotationMediaError("video_timeout", "视频处理超时，请使用更短或更小的视频") from None
    except OSError:
        raise RotationMediaError("ffmpeg_unavailable", "视频处理工具无法运行，请检查安装") from None


def _probe(path: Path) -> dict:
    size = path.stat().st_size
    with path.open("rb") as stream:
        _check_container(stream.read(4096), size)
    # No output is requested: inspect the demuxer header without allocating full
    # decoded images before the dimension limits have been checked.
    result = _run_ffmpeg(_input_arguments(path), PROBE_TIMEOUT)
    diagnostics = result.stderr.decode("utf-8", errors="replace")
    if "At least one output file must be specified" not in diagnostics:
        raise RotationMediaError("invalid_video", "无法读取视频，请重新导出为 MP4 或 MOV")
    duration_match = re.search(r"Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)", diagnostics)
    video_lines = [
        line for line in diagnostics.splitlines()
        if re.search(r"Stream #0:\d+.*Video:", line) and "attached pic" not in line
    ]
    dimensions = re.search(r"\b([1-9]\d{0,5})x([1-9]\d{0,5})\b", video_lines[0]) if video_lines else None
    if not duration_match or not dimensions:
        raise RotationMediaError("invalid_video", "视频必须包含可读取的画面和时长")
    hours, minutes, seconds = map(float, duration_match.groups())
    duration = hours * 3600 + minutes * 60 + seconds
    width, height = map(int, dimensions.groups())
    if not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION_SECONDS:
        raise RotationMediaError("video_duration", "视频时长须大于 0 且不超过 30 秒")
    if max(width, height) > MAX_DIMENSION or width * height > MAX_PIXELS:
        raise RotationMediaError("video_dimensions", "视频尺寸过大，请使用 4096 像素以内、总像素不超过 8 MP 的视频")
    # FFmpeg autorotates mobile video when decoding; describe that displayed size.
    rotation = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", diagnostics)
    if rotation and abs(float(rotation.group(1))) % 180 > 45:
        width, height = height, width
    return {"duration": duration, "width": width, "height": height}


def _validate_and_store_video(user_id: UUID, raw: bytes) -> dict:
    if not isinstance(raw, bytes):
        raise RotationMediaError("invalid_video", "视频内容无效")
    _check_container(raw[:4096], len(raw))
    _ffmpeg_executable()
    directory = _user_directory(user_id)
    filename = f"rotation_{uuid4().hex}.mp4"
    path = directory / filename
    try:
        # Exclusive creation avoids overwriting an existing file or symlink.
        with path.open("xb") as stream:
            stream.write(raw)
        metadata = _probe(path)
        return {"video_path": f"{user_id}/{filename}", **metadata}
    except BaseException:
        path.unlink(missing_ok=True)
        raise


async def validate_and_store_video(user_id: UUID, raw: bytes) -> dict:
    """Validate bounded MP4/MOV bytes and persist one file owned by this user."""
    return await asyncio.to_thread(_validate_and_store_video, user_id, raw)


def _remove_green(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    red, green, blue, alpha = image.split()
    dominance = ImageChops.subtract(green, ImageChops.lighter(red, blue))
    # Original soft chroma threshold: neutral colors remain opaque; strongly
    # dominant green becomes transparent, with a gradual edge in between.
    keep = dominance.point(lambda value: round(255 * (1 - min(1, max(0, (value - 25) / 60)))))
    image.putalpha(ImageChops.multiply(alpha, keep))
    return image


def _extract_rotation_frames(user_id: UUID, video_path: str, remove_green: bool) -> dict:
    path = _owned_video(user_id, video_path)
    metadata = _probe(path)
    duration = metadata["duration"]
    final_time = max(duration - 1 / 600, duration / 2)
    rate = (FRAME_COUNT - 1) / final_time
    prefix = f"rotation_{uuid4().hex}"
    output_pattern = path.parent / f"{prefix}_%03d.png"
    frames = [path.parent / f"{prefix}_{index:03d}.png" for index in range(FRAME_COUNT)]
    # Clone only the last decoded frame past EOF. This keeps 61 uniformly spaced
    # samples even for a short, low-frame-rate clip, without inventing new views.
    filters = f"tpad=stop_mode=clone:stop_duration=1,fps={rate:.12f}:start_time=0:round=near,format=rgba"
    try:
        result = _run_ffmpeg([
            *_input_arguments(path), "-map", "0:V:0", "-an", "-sn", "-dn",
            "-vf", filters, "-frames:v", str(FRAME_COUNT), "-threads", "2",
            "-filter_threads", "1", "-start_number", "0", "-f", "image2",
            "-n", str(output_pattern),
        ], EXTRACT_TIMEOUT)
        if result.returncode != 0 or not all(frame.is_file() for frame in frames):
            raise RotationMediaError("video_decode", "视频无法完整解码，请重新导出视频后重试")
        frame_size = None
        for frame in frames:
            with Image.open(frame) as image:
                if max(image.size) > MAX_DIMENSION or image.width * image.height > MAX_PIXELS:
                    raise RotationMediaError("video_dimensions", "视频解码后的尺寸超过限制")
                if frame_size is None:
                    frame_size = image.size
                elif image.size != frame_size:
                    raise RotationMediaError("video_dimensions", "视频中的画面尺寸发生变化，请重新导出")
                if remove_green:
                    output = _remove_green(image)
                    output.save(frame, format="PNG")
        return {
            "video_path": video_path,
            "frame_paths": [f"{user_id}/{frame.name}" for frame in frames],
            "frame_count": FRAME_COUNT, "duration": duration,
            "width": frame_size[0], "height": frame_size[1],
        }
    except BaseException:
        for frame in frames:
            frame.unlink(missing_ok=True)
        raise


async def extract_rotation_frames(
    user_id: UUID, video_path: str, remove_green: bool = False
) -> dict:
    """Extract 61 owned RGBA PNGs, optionally keying out a green background."""
    return await asyncio.to_thread(_extract_rotation_frames, user_id, video_path, remove_green)
