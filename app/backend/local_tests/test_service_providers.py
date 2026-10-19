"""Capability isolation and real HTTP schemas; never uses real credentials."""
import base64
import json

import httpx
import pytest

from app.services.aiyi_provider import AIProviderError, AIYIProvider, GeminiProvider
from app.services.aiyi_settings import AIServiceInput, AISettingsInput
from app.services.aiyi_video_provider import WaveSpeedProvider, validate_media_url


def config(provider="gemini", **changes):
    return AIServiceInput(provider=provider,
        base_url="https://generativelanguage.googleapis.com/v1beta" if provider == "gemini" else "https://api.wavespeed.ai/api/v3",
        model=changes.pop("model", "gemini-3.1-flash-image" if provider == "gemini" else "bytedance/seedance-2.0/image-to-video"),
        api_key="unit-test-secret", **changes)


def test_service_keys_are_separate_and_legacy_image_key_is_retained(local_client, login_user):
    headers = login_user(local_client, "split@aiyichu.local")
    old = local_client.put("/api/v1/ai/settings", headers=headers, json={
        "provider":"openai", "base_url":"https://api.openai.com/v1", "vision_model":"gpt-4.1-mini",
        "image_model":"gpt-image-1.5", "api_key":"old-image-test-secret"})
    assert old.status_code == 200
    gemini = config().model_dump(exclude={"api_key"}) | {"api_key":"vision-test-secret"}
    reply = local_client.put("/api/v1/ai/services/recognition", headers=headers, json=gemini)
    assert reply.status_code == 200 and reply.json()["configured"]
    assert "secret" not in reply.text and "api_key" not in reply.json()
    state = local_client.get("/api/v1/ai/services", headers=headers).json()
    assert state["image"]["configured"] and state["image"]["model"] == "gpt-image-1.5"
    assert state["recognition"]["provider"] == "gemini"
    assert state["rotation"]["configured"] is False
    cleared = local_client.delete("/api/v1/ai/services/recognition/key", headers=headers)
    assert cleared.json()["configured"] is False
    state = local_client.get("/api/v1/ai/services", headers=headers).json()
    assert not state["recognition"]["configured"] and state["image"]["configured"]
    # A saved image credential must not silently follow a destination change.
    reply = local_client.put("/api/v1/ai/services/image", headers=headers, json={
        "provider":"openai_compatible", "base_url":"https://new.example/v1", "model":"image"})
    assert reply.json()["configured"] is False
    other = login_user(local_client, "other-split@aiyichu.local")
    assert not local_client.get("/api/v1/ai/services", headers=other).json()["image"]["configured"]
    assert local_client.get("/api/v1/ai/services").status_code == 401


def test_invalid_service_destination_and_model_path_are_rejected(local_client, login_user):
    headers = login_user(local_client, "service-validation@aiyichu.local")
    for overrides in ({"model":"../balance"}, {"model":"model?key=oops"},
                      {"base_url":"https://user:secret@host/v1"}):
        payload = config().model_dump(exclude={"api_key"}) | overrides
        reply = local_client.put("/api/v1/ai/services/recognition", headers=headers, json=payload)
        assert reply.status_code == 422
    payload = config("wavespeed").model_dump(exclude={"api_key"})
    assert local_client.put("/api/v1/ai/services/image", headers=headers, json=payload).status_code == 409


def test_explicit_new_key_repairs_corrupt_service_without_reusing_old_key(local_client, login_user):
    from pathlib import Path
    from app.config import get_settings

    headers = login_user(local_client, "repair-config@aiyichu.local")
    payload = config().model_dump(exclude={"api_key"})
    url = "/api/v1/ai/services/recognition"
    assert local_client.put(url, headers=headers, json=payload | {"api_key": "old-test-key"}).status_code == 200
    path = next(Path(get_settings().aiyi_config_path).glob("*-recognition.json"))
    for broken in ("{invalid json", json.dumps({"config": payload, "encrypted_api_key": "invalid"})):
        path.write_text(broken)
        assert local_client.put(url, headers=headers, json=payload).status_code == 409
        fixed = local_client.put(url, headers=headers, json=payload | {"api_key": "new-test-key"})
        assert fixed.status_code == 200 and fixed.json()["configured"]
        assert "new-test-key" not in fixed.text and "new-test-key" not in path.read_text()


@pytest.mark.asyncio
async def test_gemini_recognition_uses_native_auth_schema_and_validates_boxes(picture_bytes):
    garment = {"name":"蓝色上衣", "type":"shirt", "colors":["navy"], "primary_color":"navy",
        "season":["fall"], "material":"", "notes":"长袖", "confidence":0.8, "bbox":[0.1,0.1,0.9,0.9]}
    def handler(request):
        assert request.url.path.endswith("/models/gemini-3.5-flash:generateContent")
        assert request.headers["x-goog-api-key"] == "unit-test-secret"
        assert "authorization" not in request.headers and "key=" not in str(request.url)
        body = json.loads(request.content)
        assert body["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "image/jpeg"
        schema = body["generationConfig"]["responseJsonSchema"]
        assert "$defs" not in schema and "$ref" not in json.dumps(schema)
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        return httpx.Response(200, json={"candidates":[{"finishReason":"STOP", "content":{"parts":[
            {"text":"not part of result", "thought":True}, {"text":json.dumps({"garments":[garment]})}]}}]})
    provider = GeminiProvider(config(model="gemini-3.5-flash"), httpx.MockTransport(handler))
    assert await provider.analyze(picture_bytes) == [garment]
    garment["bbox"] = [10,10,900,900]
    with pytest.raises(AIProviderError, match="识别结果"):
        await provider.analyze(picture_bytes)


@pytest.mark.asyncio
async def test_gemini_tryon_and_catalog_have_distinct_inputs_and_aspects(picture_bytes):
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"candidates":[{"finishReason":"STOP", "content":{"parts":[
            {"inlineData":{"mimeType":"image/png", "data":base64.b64encode(picture_bytes).decode()}}]}}]})
    provider = GeminiProvider(config(), httpx.MockTransport(handler))
    assert await provider.try_on(picture_bytes,[{"image":picture_bytes,"type":"shirt","name":"Blue shirt"}]) == picture_bytes
    assert await provider.product_image(picture_bytes,{"type":"shirt","name":"Blue shirt"}) == picture_bytes
    assert len(captured[0]["contents"][0]["parts"]) == 3
    assert "Image 2: shirt" in captured[0]["contents"][0]["parts"][0]["text"]
    assert captured[0]["generationConfig"]["imageConfig"]["aspectRatio"] == "9:16"
    assert len(captured[1]["contents"][0]["parts"]) == 2
    assert captured[1]["generationConfig"]["imageConfig"]["aspectRatio"] == "1:1"


@pytest.mark.asyncio
async def test_catalog_openai_requests_only_one_square_image(picture_bytes):
    def handler(request):
        assert request.url.path == "/v1/images/edits"
        assert request.content.count(b'name="image[]"') == 1
        assert b"1024x1024" in request.content and b"catalog photograph" in request.content
        return httpx.Response(200,json={"data":[{"b64_json":base64.b64encode(picture_bytes).decode()}]})
    provider=AIYIProvider(AISettingsInput(api_key="unit-test-secret"), httpx.MockTransport(handler))
    assert await provider.product_image(picture_bytes,{"name":"shirt","type":"shirt"}) == picture_bytes


@pytest.mark.asyncio
async def test_video_persists_id_before_poll_and_resume_never_resubmits(picture_bytes):
    calls, persisted = [], []
    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == "Bearer unit-test-secret"
        if request.url.path.endswith("/media/upload/binary"):
            assert b'name="file"' in request.content
            return httpx.Response(200,json={"code":200,"data":{"download_url":"https://cdn.example/source.jpg"}})
        if request.method == "POST":
            body=json.loads(request.content)
            assert body["image"] == body["last_image"]
            assert body["duration"] == 4 and body["generate_audio"] is False
            return httpx.Response(200,json={"code":200,"data":{"id":"prediction-1"}})
        assert persisted == ["prediction-1"]
        return httpx.Response(200,json={"code":200,"data":{"status":"completed","outputs":["https://cdn.example/video.mp4"]}})
    class Provider(WaveSpeedProvider):
        async def _download_video(self,url):
            assert url == "https://cdn.example/video.mp4"
            return b"video-fixture"
    async def save_id(value):
        persisted.append(value)
    provider = Provider(config("wavespeed"),httpx.MockTransport(handler),poll_interval=0)
    assert await provider.generate(picture_bytes,on_submitted=save_id) == b"video-fixture"
    assert len(calls) == 3
    calls.clear()
    assert await provider.generate(picture_bytes,remote_id="prediction-1",on_submitted=save_id) == b"video-fixture"
    assert calls == [("GET","/api/v3/predictions/prediction-1/result")]


@pytest.mark.asyncio
async def test_video_download_has_no_credential_and_rejects_private_urls(monkeypatch):
    from app.services import aiyi_video_provider as module
    async def fake_validate(url):
        validate_media_url(url)
    monkeypatch.setattr(module,"validate_public_destination",fake_validate)
    def handler(request):
        assert "authorization" not in request.headers and "x-goog-api-key" not in request.headers
        return httpx.Response(200,headers={"content-type":"video/mp4"},content=b"video")
    provider = WaveSpeedProvider(config("wavespeed"),httpx.MockTransport(handler))
    assert await provider._download_video("https://cdn.example/output.mp4") == b"video"
    for url in ("http://cdn.example/x", "https://127.0.0.1/x", "https://169.254.169.254/x", "https://user:pass@cdn.example/x"):
        with pytest.raises(AIProviderError):
            await provider._download_video(url)
