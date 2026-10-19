"""End-to-end local workflow tests use an injected provider, never paid APIs."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi.testclient import TestClient

from app.database import async_session_maker
from app.main import app
from app.models.ai_task import AITask
from app.models.item import ClothingItem, ItemStatus
from app.services import aiyi_tasks
from app.services.aiyi_provider import AIProviderError
from app.services.image_service import ImageService


class StubProvider:
    def __init__(self, image: bytes):
        self.image = image
        self.analyze_calls = 0
        self.try_on_calls = []
        self.fail_next = False

    async def analyze(self, image):
        assert image
        self.analyze_calls += 1
        if self.fail_next:
            self.fail_next = False
            raise AIProviderError("timeout", "测试服务请求超时，请手动重试")
        return [
            {"name": "蓝色上衣", "type": "shirt", "colors": ["navy"], "primary_color": "navy",
             "season": ["fall"], "material": "cotton", "notes": "长袖上衣", "bbox": [0.1, 0.1, 0.9, 0.6]},
            {"name": "蓝色长裤", "type": "pants", "colors": ["blue"], "primary_color": "blue",
             "season": ["spring"], "material": None, "notes": None, "bbox": None},
        ]

    async def try_on(self, person_image, garments, prompt=""):
        self.try_on_calls.append((person_image, garments, prompt))
        return self.image


def poll(client, headers, task_id, expected):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/ai/jobs/{task_id}", headers=headers)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in expected:
            return job
        assert job["status"] not in {"failed", "interrupted"}, job
        time.sleep(0.02)
    raise AssertionError(f"Task did not reach {expected}: {job}")


def recognize(client, headers, picture):
    response = client.post("/api/v1/ai/recognitions", headers=headers,
        files={"image": ("wardrobe.png", picture, "image/png")})
    assert response.status_code == 202, response.text
    return poll(client, headers, response.json()["id"], {"awaiting_confirmation"})


def confirmation(job):
    fields = {"candidate_id", "name", "type", "colors", "primary_color", "season", "material", "notes"}
    return {"candidates": [{key: value for key, value in row.items() if key in fields}
        for row in job["result"]["candidates"]]}


def test_recognition_confirm_try_on_real_storage_and_restart(monkeypatch, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    with TestClient(app) as client:
        alice = login_user(client, "alice-ai@local.test")
        bob = login_user(client, "bob-ai@local.test")
        job = recognize(client, alice, picture_bytes)
        candidates = job["result"]["candidates"]
        assert candidates[0]["image_kind"] == "crop"
        assert candidates[1]["image_kind"] == "source"
        assert candidates[1]["crop_warning"]
        assert candidates[0]["season"] == ["fall"]
        assert "paths" not in candidates[0]
        assert client.get("/api/v1/items", headers=alice).json()["total"] == 0
        assert client.get("/api/v1/ai/jobs", headers=bob).json()["jobs"] == []
        assert client.get(f"/api/v1/ai/jobs/{job['id']}", headers=bob).status_code == 404
        payload = confirmation(job)
        payload["candidates"][0]["name"] = "确认后的上衣"
        endpoint = f"/api/v1/ai/recognitions/{job['id']}/confirm"
        assert client.post(endpoint, headers=bob, json=payload).status_code == 404
        saved = client.post(endpoint, headers=alice, json=payload)
        assert saved.status_code == 200, saved.text
        item_ids = saved.json()["result"]["item_ids"]
        assert saved.json()["status"] == "completed"
        assert len(item_ids) == 2
        repeated = client.post(endpoint, headers=alice, json=payload)
        assert repeated.json()["result"]["item_ids"] == item_ids
        wardrobe = client.get("/api/v1/items", headers=alice).json()
        assert wardrobe["total"] == 2
        assert {row["name"] for row in wardrobe["items"]} == {"确认后的上衣", "蓝色长裤"}
        assert all(row["ai_processed"] and row["status"] == "ready" for row in wardrobe["items"])
        denied = client.post("/api/v1/ai/try-ons", headers=bob,
            data={"item_ids": json.dumps(item_ids)},
            files={"person_image": ("person.png", picture_bytes, "image/png")})
        assert denied.status_code == 404
        generated = client.post("/api/v1/ai/try-ons", headers=alice,
            data={"item_ids": json.dumps(item_ids), "prompt": "自然站立"},
            files={"person_image": ("person.png", picture_bytes, "image/png")})
        assert generated.status_code == 202, generated.text
        result_job = poll(client, alice, generated.json()["id"], {"completed"})
        assert result_job["result"]["item_ids"] == item_ids
        assert client.get(result_job["result"]["image_url"]).status_code == 200
        assert len(provider.try_on_calls) == 1
        _, garments, prompt = provider.try_on_calls[0]
        assert [garment["type"] for garment in garments] == ["shirt", "pants"]
        assert prompt == "自然站立" and all(garment["image"] for garment in garments)
        # Item deletion must not delete source/candidate media retained by a task.
        assert client.delete(f"/api/v1/items/{item_ids[1]}", headers=alice).status_code == 204
        assert client.get(job["source_image_url"]).status_code == 200
        assert client.get(candidates[1]["image_url"]).status_code == 200
    with TestClient(app) as restarted:
        restored = restarted.get(f"/api/v1/ai/jobs/{result_job['id']}", headers=alice)
        assert restored.status_code == 200
        assert restored.json()["status"] == "completed"
        assert restarted.get(restored.json()["result"]["image_url"]).status_code == 200
        assert len(provider.try_on_calls) == 1


def test_missing_configuration_does_not_enqueue(local_client, login_user, picture_bytes):
    headers = login_user(local_client, "unconfigured@local.test")
    response = local_client.post("/api/v1/ai/recognitions", headers=headers,
        files={"image": ("shirt.png", picture_bytes, "image/png")})
    assert response.status_code == 503, response.text
    assert "API" in response.json()["detail"]
    assert local_client.get("/api/v1/ai/jobs", headers=headers).json()["jobs"] == []


def test_failed_task_retry_and_invalid_confirm(monkeypatch, local_client, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    provider.fail_next = True
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "retry@local.test")
    response = local_client.post("/api/v1/ai/recognitions", headers=headers,
        files={"image": ("shirt.png", picture_bytes, "image/png")})
    failed = poll(local_client, headers, response.json()["id"], {"failed"})
    assert failed["error"] == "测试服务请求超时，请手动重试"
    assert failed["attempt"] == 1
    retry = local_client.post(f"/api/v1/ai/jobs/{failed['id']}/retry", headers=headers)
    assert retry.status_code == 202, retry.text
    recovered = poll(local_client, headers, failed["id"], {"awaiting_confirmation"})
    assert recovered["attempt"] == 2 and recovered["error"] is None
    assert provider.analyze_calls == 2
    assert local_client.post(f"/api/v1/ai/jobs/{failed['id']}/retry", headers=headers).status_code == 409
    bad_payload = confirmation(recovered)
    bad_payload["candidates"][0]["candidate_id"] = "not-from-this-task"
    assert local_client.post(f"/api/v1/ai/recognitions/{failed['id']}/confirm",
        headers=headers, json=bad_payload).status_code == 400
    assert local_client.get("/api/v1/items", headers=headers).json()["total"] == 0


def test_restart_resumes_queued_but_never_repeats_inflight_provider(monkeypatch, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    with TestClient(app) as client:
        headers = login_user(client, "recovery@local.test")
        user_id = UUID(client.get("/api/v1/users/me", headers=headers).json()["id"])

        async def insert_pending():
            source = await ImageService().process_and_store(user_id, picture_bytes, "source.png")
            async with async_session_maker() as db:
                queued = AITask(user_id=user_id, kind="recognition", status="queued", inputs={"source": source})
                running = AITask(user_id=user_id, kind="recognition", status="running", inputs={"source": source}, attempt=1)
                db.add_all([queued, running])
                await db.commit()
                return str(queued.id), str(running.id)

        queued_id, running_id = client.portal.call(insert_pending)
    with TestClient(app) as restarted:
        queued = poll(restarted, headers, queued_id, {"awaiting_confirmation"})
        running = restarted.get(f"/api/v1/ai/jobs/{running_id}", headers=headers).json()
        assert queued["attempt"] == 1
        assert running["status"] == "interrupted" and running["attempt"] == 1
        assert "计费" in running["error"]
        assert provider.analyze_calls == 1


def test_concurrent_confirmation_creates_each_item_only_once(monkeypatch, local_client, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "concurrent@local.test")
    job = recognize(local_client, headers, picture_bytes)
    payload = confirmation(job)

    def confirm():
        return local_client.post(f"/api/v1/ai/recognitions/{job['id']}/confirm", headers=headers, json=payload)

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: confirm(), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["result"]["item_ids"] == responses[1].json()["result"]["item_ids"]
    assert local_client.get("/api/v1/items", headers=headers).json()["total"] == 2


def test_try_on_validates_selected_groups_and_images_before_submission(monkeypatch, local_client, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "validation@local.test")
    job = recognize(local_client, headers, picture_bytes)
    payload = confirmation(job)
    payload["candidates"][1]["type"] = "sweater"
    saved = local_client.post(f"/api/v1/ai/recognitions/{job['id']}/confirm", headers=headers, json=payload).json()
    ids = saved["result"]["item_ids"]

    def try_on(selected, image=picture_bytes, mime="image/png"):
        return local_client.post("/api/v1/ai/try-ons", headers=headers,
            data={"item_ids": json.dumps(selected)}, files={"person_image": ("photo.png", image, mime)})

    assert try_on([]).status_code == 422
    assert try_on([ids[0], ids[0]]).status_code == 422
    duplicate_group = try_on(ids)
    assert duplicate_group.status_code == 422 and "分类" in duplicate_group.json()["detail"]
    assert try_on([ids[0]], b"not-an-image").status_code == 400
    local_client.patch(f"/api/v1/items/{ids[1]}", headers=headers, json={"type": "hat"})
    assert try_on([ids[1]]).status_code == 422
    assert provider.try_on_calls == []
    assert local_client.get("/api/v1/ai/jobs?kind=try_on", headers=headers).json()["jobs"] == []


def test_try_on_accepts_five_groups_including_bag_and_rejects_six_or_duplicate_group(monkeypatch, local_client, login_user, picture_bytes):
    provider = StubProvider(picture_bytes)
    monkeypatch.setattr(aiyi_tasks, "get_aiyi_provider", lambda user_id, capability="image": provider)
    headers = login_user(local_client, "five-items@local.test")
    user_id = UUID(local_client.get("/api/v1/users/me", headers=headers).json()["id"])

    async def seed_outfit():
        paths = await ImageService().process_and_store(user_id, picture_bytes, "fixture.png")
        items = [ClothingItem(user_id=user_id, type=kind, name=kind,
                             status=ItemStatus.ready, image_path=paths["image_path"])
                 for kind in ("shirt", "jacket", "pants", "shoes", "bag", "bag")]
        async with async_session_maker() as db:
            db.add_all(items)
            await db.commit()
        return [str(item.id) for item in items]

    ids = local_client.portal.call(seed_outfit)

    def try_on(selected):
        return local_client.post("/api/v1/ai/try-ons", headers=headers,
            data={"item_ids": json.dumps(selected)}, files={"person_image": ("person.png", picture_bytes, "image/png")})

    too_many = try_on(ids)
    assert too_many.status_code == 422 and "1 至 5" in too_many.json()["detail"]
    duplicate_bags = try_on(ids[4:])
    assert duplicate_bags.status_code == 422 and "分类" in duplicate_bags.json()["detail"]
    assert provider.try_on_calls == []
    response = try_on(ids[:5])
    assert response.status_code == 202, response.text
    completed = poll(local_client, headers, response.json()["id"], {"completed"})
    assert completed["result"]["item_ids"] == ids[:5]
    assert [garment["type"] for garment in provider.try_on_calls[0][1]] == ["shirt", "jacket", "pants", "shoes", "bag"]
    assert local_client.get(completed["result"]["image_url"]).status_code == 200


def test_history_pagination_keeps_old_jobs_accessible_and_user_scoped(local_client, login_user):
    alice = login_user(local_client, "history-alice@local.test")
    bob = login_user(local_client, "history-bob@local.test")
    alice_id = UUID(local_client.get("/api/v1/users/me", headers=alice).json()["id"])
    bob_id = UUID(local_client.get("/api/v1/users/me", headers=bob).json()["id"])

    async def populate():
        now = datetime.now(UTC)
        rows = [AITask(user_id=alice_id, kind="recognition", status="completed", inputs={},
                       created_at=now + timedelta(seconds=i)) for i in range(35)]
        async with async_session_maker() as db:
            db.add_all(rows)
            db.add(AITask(user_id=alice_id, kind="try_on", status="completed", inputs={}))
            db.add(AITask(user_id=bob_id, kind="recognition", status="completed", inputs={}))
            await db.commit()
        return [str(row.id) for row in reversed(rows)]

    expected = local_client.portal.call(populate)
    first = local_client.get("/api/v1/ai/jobs?kind=recognition", headers=alice).json()
    assert first["total"] == 35 and first["has_more"] and first["next_offset"] == 30
    second = local_client.get("/api/v1/ai/jobs?kind=recognition&offset=30", headers=alice).json()
    assert second["total"] == 35 and not second["has_more"] and second["next_offset"] is None
    assert [job["id"] for job in first["jobs"] + second["jobs"]] == expected
    assert local_client.get(f"/api/v1/ai/jobs/{expected[-1]}", headers=alice).status_code == 200
    assert local_client.get("/api/v1/ai/jobs", headers=bob).json()["total"] == 1
    assert local_client.get("/api/v1/ai/jobs?offset=-1", headers=alice).status_code == 422
