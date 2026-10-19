"""DeepSeek recognition contract tests using only fabricated keys and local HTTP mocks."""

import base64
import json
from io import BytesIO
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from app.services import aiyi_provider as provider_module
from app.services.aiyi_provider import AIProviderError, DeepSeekProvider, recognition_schema
from app.services.aiyi_settings import AIServiceInput
from app.services.aiyi_video_provider import get_video_provider


GARMENT = {"name": "蓝色上衣", "type": "shirt", "colors": ["navy"],
           "primary_color": "navy", "season": ["fall"], "material": "",
           "notes": "长袖", "confidence": 0.9, "bbox": [0.1, 0.1, 0.9, 0.9]}


def adapter(handler, **overrides):
    return DeepSeekProvider(AIServiceInput(provider="deepseek", api_key="deepseek-unit-test-key",
                                         **overrides), httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_deepseek_recognition_sends_supported_image_json_and_thinking_contract(picture_bytes):
    def handler(request):
        assert str(request.url) == "https://api.deepseek.com/chat/completions"
        assert request.headers["authorization"] == "Bearer deepseek-unit-test-key"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-flash"
        assert body["response_format"] == {"type": "json_object"}
        assert body["thinking"] == {"type": "disabled"}
        assert body["max_tokens"] == 4000 and "max_completion_tokens" not in body
        prompt, image = body["messages"][0]["content"]
        assert "JSON" in prompt["text"] and '{"garments":[]}' in prompt["text"]
        assert json.dumps(recognition_schema(), ensure_ascii=False, separators=(",", ":")) in prompt["text"]
        assert image["type"] == "image_url" and image["image_url"]["detail"] == "high"
        with Image.open(BytesIO(base64.b64decode(image["image_url"]["url"].split(",", 1)[1]))) as decoded:
            assert decoded.format == "JPEG" and decoded.size == (180, 240)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"garments": [GARMENT]}), "reasoning_content": "not part of the result"}}]})

    assert await adapter(handler).analyze(picture_bytes) == [GARMENT]


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["length", "content_filter", "aborted", "insufficient_system_resource", "tool_calls", None])
async def test_deepseek_does_not_accept_unfinished_but_parseable_results(picture_bytes, reason):
    provider = adapter(lambda request: httpx.Response(200, json={"choices": [{
        "finish_reason": reason, "message": {"content": json.dumps({"garments": [GARMENT]})}}]}))
    with pytest.raises(AIProviderError) as error:
        await provider.analyze(picture_bytes)
    assert error.value.code in {"invalid_response", "refused"}


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", "not json", json.dumps({"garments": []}),
    json.dumps({"garments": [GARMENT | {"bbox": [0, 0, 100, 100]}]}),
    json.dumps({"garments": [GARMENT | {"type": "invented-category"}]}),
    json.dumps({"garments": [GARMENT | {"primary_color": "red"}]})])
async def test_deepseek_keeps_local_schema_and_empty_output_validation(picture_bytes, content):
    provider = adapter(lambda request: httpx.Response(200, json={"choices": [{
        "finish_reason": "stop", "message": {"content": content}}]}))
    with pytest.raises(AIProviderError) as error:
        await provider.analyze(picture_bytes)
    assert error.value.code in {"invalid_response", "no_garments"}


@pytest.mark.asyncio
async def test_deepseek_can_check_custom_https_proxy_but_never_generate_images(picture_bytes):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        assert str(request.url) == "https://proxy.example/deepseek/models"
        return httpx.Response(200, json={"data": [{"id": "deepseek-flash"}]})
    provider = adapter(handler, base_url="https://proxy.example/deepseek")
    checked = await provider.check()
    assert checked["model_listed"] is True and "image_model_listed" not in checked
    for operation in (provider.try_on(picture_bytes, []), provider.product_image(picture_bytes, GARMENT)):
        with pytest.raises(AIProviderError) as error:
            await operation
        assert error.value.code == "unsupported_capability"
    assert len(calls) == 1


def test_deepseek_factory_only_accepts_recognition_even_if_saved_file_is_incompatible(monkeypatch):
    config = AIServiceInput(provider="deepseek", api_key="factory-unit-test-key")
    monkeypatch.setattr(provider_module, "read_service_settings", lambda *_: (config, "saved"))
    assert isinstance(provider_module.get_aiyi_provider(uuid4(), "recognition"), DeepSeekProvider)
    with pytest.raises(AIProviderError, match="仅用于衣物识别"):
        provider_module.get_aiyi_provider(uuid4(), "image")
    from app.services import aiyi_video_provider as video_module
    monkeypatch.setattr(video_module, "read_service_settings", lambda *_: (config, "saved"))
    with pytest.raises(AIProviderError, match="WaveSpeed"):
        get_video_provider(uuid4())


def test_deepseek_settings_defaults_preserve_other_services_and_do_not_forward_keys(local_client, login_user):
    headers = login_user(local_client, "deepseek-settings@aiyichu.local")
    before = local_client.get("/api/v1/ai/services", headers=headers).json()
    url = "/api/v1/ai/services/recognition"
    result = local_client.put(url, headers=headers, json={"provider": "deepseek", "api_key": "settings-unit-test-key"})
    assert result.status_code == 200, result.text
    config = result.json()
    assert config["base_url"] == "https://api.deepseek.com" and config["model"] == "deepseek-flash"
    assert config["configured"] and "settings-unit-test-key" not in result.text
    state = local_client.get("/api/v1/ai/services", headers=headers).json()
    assert state["image"] == before["image"] and state["rotation"] == before["rotation"]
    for capability in ("image", "rotation"):
        rejected = local_client.put(f"/api/v1/ai/services/{capability}", headers=headers,
                                    json={"provider": "deepseek", "api_key": "do-not-save-test-key"})
        assert rejected.status_code == 409 and "仅用于衣物识别" in rejected.text
    retained = local_client.put(url, headers=headers, json={"provider": "deepseek", "api_key": ""})
    assert retained.json()["configured"]
    changed = local_client.put(url, headers=headers, json={"provider": "deepseek", "base_url": "https://proxy.example/v1"})
    assert changed.status_code == 200 and not changed.json()["configured"]
    rejected = local_client.put(url, headers=headers, json={"provider": "deepseek", "base_url": "http://localhost:8000"})
    assert rejected.status_code == 422
    other = login_user(local_client, "deepseek-other@aiyichu.local")
    assert local_client.get("/api/v1/ai/services", headers=other).json()["recognition"] == before["recognition"]
