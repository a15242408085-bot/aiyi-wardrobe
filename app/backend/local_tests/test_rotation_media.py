"""Real, local FFmpeg coverage: no generation provider or paid API is involved."""

import asyncio
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

from app.services import rotation_media as media


@pytest.fixture(autouse=True)
def isolated_local_database():
    # This service needs neither the database nor application startup. Override
    # the shared API fixture so media checks remain independently runnable.
    yield


@pytest.fixture
def media_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "settings", SimpleNamespace(storage_path=str(tmp_path)))
    return tmp_path


@pytest.fixture
def ffmpeg():
    try:
        return media._ffmpeg_executable()
    except media.RotationMediaError:
        pytest.skip("Install imageio-ffmpeg to run real video decoding tests")


def make_video(ffmpeg: str, path: Path, *, duration: str = "0.4", size: str = "96x64") -> bytes:
    process = subprocess.run([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", f"color=c=0x00ff00:s={size}:r=10:d={duration}",
        "-vf", "drawbox=x=32:y=16:w=32:h=32:color=red:t=fill",
        "-c:v", "mpeg4", "-q:v", "2", "-threads", "1", "-y", str(path),
    ], capture_output=True, timeout=30, check=False)
    assert process.returncode == 0, process.stderr.decode()
    return path.read_bytes()


def test_short_video_extracts_61_owned_transparent_frames(media_storage, ffmpeg, tmp_path):
    user_id = uuid4()
    raw = make_video(ffmpeg, tmp_path / "input.mp4")
    stored = asyncio.run(media.validate_and_store_video(user_id, raw))
    assert stored["width"] == 96
    assert stored["height"] == 64
    assert stored["duration"] == pytest.approx(0.4, abs=0.02)
    assert Path(stored["video_path"]).parts[0] == str(user_id)

    result = asyncio.run(media.extract_rotation_frames(user_id, stored["video_path"], True))
    assert result["frame_count"] == 61
    assert len(set(result["frame_paths"])) == 61
    assert result["video_path"] == stored["video_path"]
    assert len(list((media_storage / str(user_id)).glob("*.png"))) == 61
    for relative in result["frame_paths"]:
        assert len(Path(relative).parts) == 2
        assert Path(relative).parts[0] == str(user_id)
        with Image.open(media_storage / relative) as frame:
            assert frame.mode == "RGBA"
            assert frame.size == (96, 64)
            assert frame.getpixel((2, 2))[3] == 0
            assert frame.getpixel((48, 32))[3] == 255


def test_default_retains_green_and_one_frame_clip_repeats(media_storage, ffmpeg, tmp_path):
    user_id = uuid4()
    raw = make_video(ffmpeg, tmp_path / "input.mov", duration="0.1")
    stored = asyncio.run(media.validate_and_store_video(user_id, raw))
    result = asyncio.run(media.extract_rotation_frames(user_id, stored["video_path"]))
    assert result["frame_count"] == 61
    assert len(result["frame_paths"]) == 61
    with Image.open(media_storage / result["frame_paths"][0]) as first:
        assert first.getpixel((2, 2))[3] == 255
        pixels = first.tobytes()
    with Image.open(media_storage / result["frame_paths"][-1]) as last:
        assert last.tobytes() == pixels


def test_samples_cover_the_full_changing_video(media_storage, ffmpeg, tmp_path):
    source = tmp_path / "changing.mp4"
    process = subprocess.run([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
        "-i", "testsrc2=s=96x64:r=10:d=1", "-c:v", "mpeg4", "-q:v", "2",
        "-threads", "1", "-y", str(source),
    ], capture_output=True, timeout=30, check=False)
    assert process.returncode == 0, process.stderr.decode()
    reference = subprocess.run([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(source),
        "-map", "0:V:0", "-an", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1",
    ], capture_output=True, timeout=30, check=False)
    assert reference.returncode == 0, reference.stderr.decode()
    frame_bytes = 96 * 64 * 4
    originals = [
        reference.stdout[offset:offset + frame_bytes]
        for offset in range(0, len(reference.stdout), frame_bytes)
    ]
    assert len(originals) == 10
    user_id = uuid4()
    stored = asyncio.run(media.validate_and_store_video(user_id, source.read_bytes()))
    result = asyncio.run(media.extract_rotation_frames(user_id, stored["video_path"]))
    indices = []
    for relative in result["frame_paths"]:
        with Image.open(media_storage / relative) as frame:
            indices.append(originals.index(frame.tobytes()))
    assert indices == sorted(indices)
    assert indices[0] == 0 and indices[-1] == 9
    assert set(indices) == set(range(10))
    # Decode sampling may round to a neighboring source frame; it must still
    # track the uniformly spaced timestamps across the whole source clip.
    assert all(abs(index - min(9, round(sample / 60 * 10))) <= 1
               for sample, index in enumerate(indices))


@pytest.mark.parametrize("raw", [b"", b"not a video", b"#EXTM3U\nhttps://example.com/video.ts\n"])
def test_invalid_inputs_are_rejected_without_persisting(media_storage, raw):
    user_id = uuid4()
    with pytest.raises(media.RotationMediaError):
        asyncio.run(media.validate_and_store_video(user_id, raw))
    assert not (media_storage / str(user_id)).exists()


def test_limits_and_bad_container_clean_up(media_storage, ffmpeg, tmp_path, monkeypatch):
    user_id = uuid4()
    raw = make_video(ffmpeg, tmp_path / "input.mp4")
    monkeypatch.setattr(media, "MAX_VIDEO_BYTES", len(raw) - 1)
    with pytest.raises(media.RotationMediaError, match="100 MB"):
        asyncio.run(media.validate_and_store_video(user_id, raw))
    monkeypatch.setattr(media, "MAX_VIDEO_BYTES", 100 * 1024 * 1024)
    monkeypatch.setattr(media, "MAX_DURATION_SECONDS", 0.2)
    with pytest.raises(media.RotationMediaError, match="30 秒"):
        asyncio.run(media.validate_and_store_video(user_id, raw))
    monkeypatch.setattr(media, "MAX_DURATION_SECONDS", 30)
    monkeypatch.setattr(media, "MAX_DIMENSION", 80)
    with pytest.raises(media.RotationMediaError, match="尺寸过大"):
        asyncio.run(media.validate_and_store_video(user_id, raw))
    monkeypatch.setattr(media, "MAX_DIMENSION", 4096)
    monkeypatch.setattr(media, "MAX_PIXELS", 4096)
    with pytest.raises(media.RotationMediaError, match="尺寸过大"):
        asyncio.run(media.validate_and_store_video(user_id, raw))
    # A syntactically valid ftyp box without a movie header is not accepted.
    malformed = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    with pytest.raises(media.RotationMediaError):
        asyncio.run(media.validate_and_store_video(user_id, malformed))
    assert not list((media_storage / str(user_id)).iterdir())


def test_owner_and_symlink_escape_are_rejected(media_storage, ffmpeg, tmp_path):
    owner, other = uuid4(), uuid4()
    raw = make_video(ffmpeg, tmp_path / "input.mp4")
    stored = asyncio.run(media.validate_and_store_video(owner, raw))
    for video_path in (stored["video_path"], f"{other}/../input.mp4", "/tmp/input.mp4"):
        with pytest.raises(media.RotationMediaError):
            asyncio.run(media.extract_rotation_frames(other, video_path))
    (media_storage / str(other)).mkdir(exist_ok=True)
    symlink = media_storage / str(other) / "escape.mp4"
    symlink.symlink_to(media_storage / stored["video_path"])
    with pytest.raises(media.RotationMediaError):
        asyncio.run(media.extract_rotation_frames(other, f"{other}/escape.mp4"))


def test_decode_failure_cleans_partial_sequence(media_storage, ffmpeg, tmp_path, monkeypatch):
    user_id = uuid4()
    raw = make_video(ffmpeg, tmp_path / "input.mp4")
    stored = asyncio.run(media.validate_and_store_video(user_id, raw))
    original_run = media._run_ffmpeg

    def fail_extract(arguments, timeout):
        if "-frames:v" not in arguments:
            return original_run(arguments, timeout)
        Image.new("RGBA", (96, 64)).save(Path(arguments[-1].replace("%03d", "000")))
        return subprocess.CompletedProcess(arguments, 1, stderr=b"bad frame")

    monkeypatch.setattr(media, "_run_ffmpeg", fail_extract)
    with pytest.raises(media.RotationMediaError, match="完整解码"):
        asyncio.run(media.extract_rotation_frames(user_id, stored["video_path"]))
    assert not list((media_storage / str(user_id)).glob("*.png"))
    assert (media_storage / stored["video_path"]).is_file()


def test_subprocess_timeout_and_protocol_restriction(monkeypatch):
    monkeypatch.setattr(media, "_ffmpeg_executable", lambda: "ffmpeg")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("ffmpeg", 1)

    monkeypatch.setattr(media.subprocess, "run", timeout)
    with pytest.raises(media.RotationMediaError, match="处理超时"):
        media._run_ffmpeg([], 1)
    arguments = media._input_arguments(Path("/tmp/local.mp4"))
    assert arguments[arguments.index("-protocol_whitelist") + 1] == "file,pipe"
    assert arguments[arguments.index("-f") + 1] == "mov"
    assert arguments[arguments.index("-enable_drefs") + 1] == "0"
    assert arguments[arguments.index("-use_absolute_path") + 1] == "0"


def test_missing_decoder_has_clear_error(monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda _: None)
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", SimpleNamespace(
        get_ffmpeg_exe=lambda: "/does/not/exist/ffmpeg"
    ))
    with pytest.raises(media.RotationMediaError, match="视频处理工具未安装"):
        media._ffmpeg_executable()
