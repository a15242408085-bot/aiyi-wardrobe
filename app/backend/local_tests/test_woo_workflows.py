"""Original WOO-inspired workflows; providers are injected, video processing is real."""

import asyncio
import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.services import aiyi_tasks
from app.services.aiyi_provider import AIProviderError
from app.services.image_service import ImageService
from app.services.rotation_media import _ffmpeg_executable


@pytest.fixture
def video_bytes(tmp_path):
    path = tmp_path / "turn.mp4"
    subprocess.run([
        _ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
        "color=c=0x00ff00:s=96x128:r=4:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(path),
    ], check=True, timeout=20)
    return path.read_bytes()


def wait_job(client, headers, task_id, predicate):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/ai/jobs/{task_id}", headers=headers)
        assert response.status_code == 200, response.text
        job = response.json()
        if predicate(job):
            return job
        time.sleep(0.02)
    raise AssertionError(job)


def finished(client, headers, task_id, status="completed"):
    job = wait_job(client, headers, task_id, lambda row: row["status"] in {status, "failed"})
    assert job["status"] == status, job
    return job


def upload_item(client, headers, picture):
    response = client.post("/api/v1/items", headers=headers,
        data={"name": "原始上衣", "type": "shirt", "skip_ai": "true"},
        files={"image": ("shirt.png", picture, "image/png")})
    assert response.status_code == 201, response.text
    return response.json()


def upload_model(client, headers, picture):
    response = client.post("/api/v1/ai/models", headers=headers, data={"name": "我的人物"},
        files={"image": ("person.png", picture, "image/png")})
    assert response.status_code == 201, response.text
    return response.json()


class ImagesProvider:
    def __init__(self, picture):
        self.picture = picture
        self.analyze_calls = 0
        self.product_calls = []
        self.try_calls = []
        self.fail_name = None
        self.block_name = None

    async def analyze(self, image):
        self.analyze_calls += 1
        return [
            {"name": name, "type": kind, "colors": ["navy"], "primary_color": "navy",
             "material": "棉", "season": ["spring"], "notes": "核对衣物细节", "bbox": [0.1, 0.1, 0.9, 0.9]}
            for name, kind in [("衬衫", "shirt"), ("同类T恤", "t-shirt"), ("裤子", "pants"), ("手提包", "bag")]
        ]

    async def product_image(self, source, candidate):
        assert source
        self.product_calls.append(candidate["name"])
        if candidate["name"] == self.block_name:
            await asyncio.Event().wait()
        if candidate["name"] == self.fail_name:
            raise AIProviderError("test_failure", "这件单品图生成失败，已保留原图")
        return self.picture

    async def try_on(self, source, garments, prompt=""):
        self.try_calls.append((source, garments, prompt))
        return self.picture


def test_recognition_generates_one_product_per_group_and_keeps_failure_fallback(monkeypatch, local_client, login_user, picture_bytes):
    provider = ImagesProvider(picture_bytes)
    provider.fail_name = "裤子"
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "products@local.test")
    response = local_client.post("/api/v1/ai/recognitions", headers=headers,
        data={"generate_product_images": "true"}, files={"image": ("look.png", picture_bytes, "image/png")})
    assert response.status_code == 202, response.text
    job = finished(local_client, headers, response.json()["id"], "awaiting_confirmation")
    candidates = job["result"]["candidates"]
    assert [candidate["name"] for candidate in candidates] == ["衬衫", "裤子", "手提包"]
    assert provider.product_calls == ["衬衫", "裤子", "手提包"]
    assert [candidate["image_kind"] for candidate in candidates] == ["generated", "crop", "generated"]
    assert candidates[1]["generation_error"] and candidates[1]["generation_status"] == "failed"
    assert all(local_client.get(candidate["source_image_url"]).status_code == 200 for candidate in candidates)
    assert local_client.get("/api/v1/items", headers=headers).json()["total"] == 0
    keys = {"candidate_id", "name", "type", "colors", "primary_color", "season", "material", "notes"}
    payload = {"candidates": [{k: v for k, v in candidate.items() if k in keys} for candidate in candidates]}
    assert local_client.post(f"/api/v1/ai/recognitions/{job['id']}/confirm", headers=headers, json=payload).status_code == 200
    assert local_client.get("/api/v1/items", headers=headers).json()["total"] == 3


def test_recognition_retry_keeps_completed_products_without_resubmission(monkeypatch, login_user, picture_bytes):
    provider = ImagesProvider(picture_bytes)
    provider.block_name = "裤子"
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    with TestClient(app) as client:
        headers = login_user(client, "partial-products@local.test")
        response = client.post("/api/v1/ai/recognitions", headers=headers,
            data={"generate_product_images": "true"}, files={"image": ("look.png", picture_bytes, "image/png")})
        task_id = response.json()["id"]
        wait_job(client, headers, task_id, lambda job: len(job["result"].get("candidates", [])) == 3
            and job["result"]["candidates"][0].get("generation_status") == "completed"
            and job["result"]["candidates"][1].get("generation_status") == "running")
    provider.block_name = None
    with TestClient(app) as client:
        assert client.get(f"/api/v1/ai/jobs/{task_id}", headers=headers).json()["status"] == "interrupted"
        assert client.post(f"/api/v1/ai/jobs/{task_id}/retry", headers=headers).status_code == 202
        job = finished(client, headers, task_id, "awaiting_confirmation")
        assert all(candidate["image_kind"] == "generated" for candidate in job["result"]["candidates"])
    assert provider.analyze_calls == 1
    assert provider.product_calls.count("衬衫") == 1
    assert provider.product_calls.count("裤子") == 2


def test_model_library_and_saved_model_try_on_are_owned(monkeypatch, local_client, login_user, picture_bytes):
    headers = login_user(local_client, "model-owner@local.test")
    outsider = login_user(local_client, "model-other@local.test")
    # Uploading a model is a media operation and requires no provider configuration.
    model = upload_model(local_client, headers, picture_bytes)
    assert model["kind"] == "model" and model["result"]["name"] == "我的人物"
    assert local_client.get("/api/v1/ai/jobs?kind=model", headers=outsider).json()["jobs"] == []
    item = upload_item(local_client, headers, picture_bytes)
    provider = ImagesProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    payload = {"model_id": model["id"], "item_ids": json.dumps([item["id"]])}
    conflicting = local_client.post("/api/v1/ai/try-ons", headers=headers, data=payload,
        files={"person_image": ("p.png", picture_bytes, "image/png")})
    assert conflicting.status_code == 422
    response = local_client.post("/api/v1/ai/try-ons", headers=headers, data=payload)
    assert response.status_code == 202, response.text
    job = finished(local_client, headers, response.json()["id"])
    assert job["result"]["model_id"] == model["id"] and len(provider.try_calls) == 1


def test_catalog_requires_explicit_apply_preserves_original_and_rejects_stale_apply(monkeypatch, local_client, login_user, picture_bytes):
    provider = ImagesProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "catalog@local.test")
    outsider = login_user(local_client, "catalog-other@local.test")
    item = upload_item(local_client, headers, picture_bytes)
    jobs = []
    for _ in range(2):
        response = local_client.post("/api/v1/ai/catalog-images", headers=headers, data={"item_id": item["id"]})
        assert response.status_code == 202, response.text
        jobs.append(finished(local_client, headers, response.json()["id"]))
    assert local_client.get(f"/api/v1/items/{item['id']}", headers=headers).json()["image_path"] == item["image_path"]
    endpoint = f"/api/v1/ai/catalog-images/{jobs[0]['id']}/apply"
    assert local_client.post(endpoint, headers=outsider).status_code == 404
    applied = local_client.post(endpoint, headers=headers)
    assert applied.status_code == 200 and applied.json()["result"]["applied"]
    changed = local_client.get(f"/api/v1/items/{item['id']}", headers=headers).json()
    assert changed["image_path"] != item["image_path"] and changed["original_image_path"] == item["image_path"]
    assert local_client.post(endpoint, headers=headers).status_code == 200
    assert local_client.post(f"/api/v1/ai/catalog-images/{jobs[1]['id']}/apply", headers=headers).status_code == 409
    assert local_client.get(jobs[0]["source_image_url"]).status_code == 200


def test_catalog_concurrent_apply_cannot_overwrite_another_catalog(monkeypatch, local_client, login_user, picture_bytes):
    provider = ImagesProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "catalog-race@local.test")
    item = upload_item(local_client, headers, picture_bytes)
    jobs = []
    for _ in range(2):
        response = local_client.post("/api/v1/ai/catalog-images", headers=headers, data={"item_id": item["id"]})
        jobs.append(finished(local_client, headers, response.json()["id"]))

    def apply(job):
        return local_client.post(f"/api/v1/ai/catalog-images/{job['id']}/apply", headers=headers)

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(apply, jobs))
    assert sorted(response.status_code for response in responses) == [200, 409]
    applied = [local_client.get(f"/api/v1/ai/jobs/{job['id']}", headers=headers).json()["result"]["applied"] for job in jobs]
    assert applied.count(True) == 1


def test_catalog_detects_changed_image_bytes_even_when_path_is_unchanged(monkeypatch, local_client, login_user, picture_bytes):
    provider = ImagesProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "catalog-content@local.test")
    item = upload_item(local_client, headers, picture_bytes)
    response = local_client.post("/api/v1/ai/catalog-images", headers=headers, data={"item_id": item["id"]})
    job = finished(local_client, headers, response.json()["id"])
    original_path = ImageService().get_image_path(item["image_path"])
    Image.new("RGB", (40, 50), "red").save(original_path, "JPEG")
    result = local_client.post(f"/api/v1/ai/catalog-images/{job['id']}/apply", headers=headers)
    assert result.status_code == 409
    assert local_client.get(f"/api/v1/ai/jobs/{job['id']}", headers=headers).json()["result"]["applied"] is False


def test_import_rotation_extracts_61_real_frames_and_protects_media(local_client, login_user, video_bytes):
    headers = login_user(local_client, "video-owner@local.test")
    outsider = login_user(local_client, "video-other@local.test")
    response = local_client.post("/api/v1/ai/rotations/import", headers=headers,
        data={"name": "本地转身", "remove_green": "true"},
        files={"video": ("turn.mp4", video_bytes, "video/mp4")})
    assert response.status_code == 202, response.text
    job = finished(local_client, headers, response.json()["id"])
    result = job["result"]
    assert result["frame_count"] == len(result["frame_urls"]) == 61
    assert result["origin"] == "import" and result["name"] == "本地转身"
    frame = local_client.get(result["frame_urls"][0])
    with Image.open(BytesIO(frame.content)) as image:
        assert image.mode == "RGBA" and image.getpixel((10, 10))[3] < 10
    video = local_client.get(result["video_url"])
    assert video.status_code == 200 and video.headers["content-type"] == "video/mp4"
    private_path = result["video_url"].split("?")[0]
    assert local_client.get(private_path, headers=outsider).status_code == 401
    assert local_client.get(private_path, headers=headers).status_code == 200
    assert local_client.get(f"/api/v1/ai/jobs/{job['id']}", headers=outsider).status_code == 404
    invalid = local_client.post("/api/v1/ai/rotations/import", headers=headers,
        files={"video": ("bad.mp4", b"not a video", "video/mp4")})
    assert invalid.status_code == 400


class VideoProvider:
    def __init__(self, video, mode):
        self.video, self.mode = video, mode
        self.calls = []
        self.submissions = 0

    async def generate(self, image, remote_id, on_submitted):
        assert image
        self.calls.append(remote_id)
        if not remote_id:
            self.submissions += 1
            await on_submitted("saved-remote-task")
            if self.mode == "interrupt":
                await asyncio.Event().wait()
            raise AIProviderError("timeout", "远端仍在生成，请重试查询原任务")
        return self.video


def test_remote_rotation_retry_polls_persisted_id_without_new_submission(monkeypatch, local_client, login_user, picture_bytes, video_bytes):
    provider = VideoProvider(video_bytes, "fail")
    monkeypatch.setattr(aiyi_tasks, "get_video_provider", lambda user_id: provider)
    headers = login_user(local_client, "remote-retry@local.test")
    model = upload_model(local_client, headers, picture_bytes)
    response = local_client.post("/api/v1/ai/rotations", headers=headers, data={"source_job_id": model["id"]})
    assert response.status_code == 202, response.text
    task_id = response.json()["id"]
    wait_job(local_client, headers, task_id, lambda job: job["status"] == "failed")
    assert local_client.post(f"/api/v1/ai/jobs/{task_id}/retry", headers=headers).status_code == 202
    job = finished(local_client, headers, task_id)
    assert job["result"]["frame_count"] == 61 and job["result"]["source_job_id"] == model["id"]
    assert job["result"]["remove_green"] is False
    assert provider.calls == [None, "saved-remote-task"] and provider.submissions == 1
    assert "saved-remote-task" not in json.dumps(job)


def test_remote_rotation_restart_automatically_resumes_saved_remote_task(monkeypatch, login_user, picture_bytes, video_bytes):
    provider = VideoProvider(video_bytes, "interrupt")
    monkeypatch.setattr(aiyi_tasks, "get_video_provider", lambda user_id: provider)
    with TestClient(app) as client:
        headers = login_user(client, "remote-restart@local.test")
        model = upload_model(client, headers, picture_bytes)
        response = client.post("/api/v1/ai/rotations", headers=headers, data={"source_job_id": model["id"]})
        task_id = response.json()["id"]
        wait_job(client, headers, task_id, lambda job: job["stage"] == "云端转身视频生成中")
    with TestClient(app) as client:
        job = finished(client, headers, task_id)
        assert job["result"]["frame_count"] == 61
    assert provider.calls == [None, "saved-remote-task"] and provider.submissions == 1


def test_unknown_video_submission_is_persisted_and_cannot_be_retried(monkeypatch, login_user, picture_bytes):
    class AmbiguousProvider:
        calls = 0

        async def generate(self, image, remote_id, on_submitted):
            self.calls += 1
            raise AIProviderError("submission_unknown", "请先核对服务商任务和账单，避免重复付费")

    provider = AmbiguousProvider()
    monkeypatch.setattr(aiyi_tasks, "get_video_provider", lambda user_id: provider)
    with TestClient(app) as client:
        headers = login_user(client, "unknown-submit@local.test")
        model = upload_model(client, headers, picture_bytes)
        response = client.post("/api/v1/ai/rotations", headers=headers, data={"source_job_id": model["id"]})
        task_id = response.json()["id"]
        wait_job(client, headers, task_id, lambda job: job["status"] == "failed")
        blocked = client.post(f"/api/v1/ai/jobs/{task_id}/retry", headers=headers)
        assert blocked.status_code == 409 and "不能直接重试" in blocked.json()["detail"]
    with TestClient(app) as client:
        assert client.get(f"/api/v1/ai/jobs/{task_id}", headers=headers).json()["status"] == "failed"
        assert client.post(f"/api/v1/ai/jobs/{task_id}/retry", headers=headers).status_code == 409
    assert provider.calls == 1
