"""Validate the actual HTTP adapter contract without consuming paid API calls."""

import base64
import json
from io import BytesIO

import httpx
from PIL import Image
import pytest

from app.services.aiyi_provider import AIProviderError, AIYIProvider, prepare_image
from app.services.aiyi_settings import AISettingsInput


def adapter(handler, **config):
    return AIYIProvider(AISettingsInput(api_key="test-only-key", **config), httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_real_adapter_sends_image_and_validates_structured_response(picture_bytes):
    expected = {"name": "蓝色上衣", "type": "shirt", "colors": ["navy"],
                "primary_color": "navy", "season": ["fall"], "material": "",
                "notes": "长袖", "confidence": 0.9, "bbox": [0.1, 0.1, 0.9, 0.9]}

    def handler(request):
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-only-key"
        body = json.loads(request.content)
        assert body["response_format"]["json_schema"]["strict"] is True
        source = body["messages"][0]["content"][1]["image_url"]["url"]
        raw = base64.b64decode(source.split(",", 1)[1])
        with Image.open(BytesIO(raw)) as image:
            assert image.format == "JPEG" and image.size == (180, 240)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"garments": [expected]})}}]})

    assert await adapter(handler).analyze(picture_bytes) == [expected]


@pytest.mark.asyncio
async def test_invalid_model_output_never_becomes_a_candidate(picture_bytes):
    for content in ["not json", '{"garments": [{"name":"broken"}]}', '{"garments":[]}']:
        provider = adapter(lambda request: httpx.Response(200, json={"choices": [{"message": {"content": content}}]}))
        with pytest.raises(AIProviderError) as error:
            await provider.analyze(picture_bytes)
        assert error.value.code in {"invalid_response", "no_garments"}


@pytest.mark.asyncio
async def test_tryon_person_first_multiple_files_and_decoded_result(picture_bytes):
    def handler(request):
        assert request.url.path == "/v1/images/edits"
        body = request.content
        assert body.count(b'name="image[]"') == 3
        assert body.index(b'filename="reference-1.jpg"') < body.index(b'filename="reference-2.jpg"')
        assert body.index(b'filename="reference-2.jpg"') < body.index(b'filename="reference-3.jpg"')
        assert b'Image 2: shirt (Blue shirt); Image 3: pants (Black pants)' in body
        assert b'name="input_fidelity"' in body
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(picture_bytes).decode()}]})

    output = await adapter(handler).try_on(picture_bytes, [
        {"image": picture_bytes, "type": "shirt", "name": "Blue shirt"},
        {"image": picture_bytes, "type": "pants", "name": "Black pants"},
    ])
    assert output == picture_bytes


@pytest.mark.asyncio
async def test_errors_are_actionable_and_do_not_echo_provider_secrets(picture_bytes):
    def handler(request):
        return httpx.Response(401, json={"error": {"message": "secret test-only-key request details"}})
    with pytest.raises(AIProviderError) as error:
        await adapter(handler).analyze(picture_bytes)
    assert error.value.code == "invalid_key"
    assert "test-only-key" not in str(error.value)


@pytest.mark.asyncio
async def test_url_only_image_response_is_rejected_without_followup_download(picture_bytes):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"data": [{"url": "https://untrusted.invalid/file"}]})
    with pytest.raises(AIProviderError, match="b64_json"):
        await adapter(handler).try_on(picture_bytes, [{"image": picture_bytes, "type": "shirt", "name": "test"}])
    assert len(calls) == 1


def test_image_preprocessing_resizes_without_distorting_or_upscaling(picture_bytes):
    with Image.open(BytesIO(prepare_image(picture_bytes, 120))) as image:
        assert image.size == (90, 120)
    with Image.open(BytesIO(prepare_image(picture_bytes))) as image:
        assert image.size == (180, 240)
