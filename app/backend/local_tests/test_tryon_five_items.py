"""Five-garment HTTP contracts, exercised entirely through MockTransport."""

import base64
import json
from email import policy
from email.parser import BytesParser
from io import BytesIO

import httpx
import pytest
from PIL import Image

from app.services.aiyi_provider import AIProviderError, AIYIProvider, GeminiProvider
from app.services.aiyi_settings import AIServiceInput, AISettingsInput


@pytest.fixture(autouse=True)
def isolated_local_database():
    # These provider contracts do not need a database or application startup.
    yield


@pytest.fixture
def outfit_inputs():
    colors = [
        (120, 50, 180),  # Person: visibly different from every garment reference.
        (210, 30, 30),
        (20, 70, 210),
        (20, 160, 70),
        (230, 140, 20),
        (30, 30, 30),
    ]
    pictures = []
    for color in colors:
        output = BytesIO()
        Image.new("RGB", (80, 120), color).save(output, format="PNG")
        pictures.append(output.getvalue())
    kinds = ["shirt", "jacket", "pants", "shoes", "bag"]
    garments = [
        {"image": picture, "type": kind, "name": f"reference {kind}"}
        for picture, kind in zip(pictures[1:], kinds, strict=True)
    ]
    return pictures[0], garments, colors


def make_provider(kind, handler):
    transport = httpx.MockTransport(handler)
    if kind == "openai":
        return AIYIProvider(AISettingsInput(api_key="test-only-key"), transport)
    return GeminiProvider(AIServiceInput(
        provider="gemini", base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-3.1-flash-image", api_key="test-only-key",
    ), transport)


def assert_ordered_images(images, colors):
    assert len(images) == 6  # One person followed by all five garments.
    for encoded, expected_color in zip(images, colors, strict=True):
        with Image.open(BytesIO(encoded)) as image:
            assert image.format == "JPEG"
            actual_color = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
            assert all(abs(actual - expected) <= 5 for actual, expected in zip(
                actual_color, expected_color, strict=True
            ))


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["openai", "gemini"])
async def test_five_garments_include_bag_with_person_first(kind, outfit_inputs):
    person, garments, colors = outfit_inputs
    calls = []
    response_image = base64.b64encode(person).decode()

    def handler(request):
        calls.append(request)
        if kind == "openai":
            assert request.url.path == "/v1/images/edits"
            multipart = BytesParser(policy=policy.default).parsebytes(
                b"Content-Type: " + request.headers["content-type"].encode()
                + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.content
            )
            parts = list(multipart.iter_parts())
            image_parts = [part for part in parts
                           if part.get_param("name", header="content-disposition") == "image[]"]
            assert all(part.get_content_type() == "image/jpeg" for part in image_parts)
            images = [part.get_payload(decode=True) for part in image_parts]
            prompt = next(part.get_payload(decode=True).decode() for part in parts
                          if part.get_param("name", header="content-disposition") == "prompt")
            response = {"data": [{"b64_json": response_image}]}
        else:
            assert request.url.path.endswith("/models/gemini-3.1-flash-image:generateContent")
            body = json.loads(request.content)
            parts = body["contents"][0]["parts"]
            prompt = parts[0]["text"]
            image_parts = [part["inlineData"] for part in parts if "inlineData" in part]
            assert all(part["mimeType"] == "image/jpeg" for part in image_parts)
            images = [base64.b64decode(part["data"], validate=True) for part in image_parts]
            response = {"candidates": [{"finishReason": "STOP", "content": {"parts": [
                {"inlineData": {"mimeType": "image/png", "data": response_image}},
            ]}}]}
        assert_ordered_images(images, colors)
        assert "Image 6: bag" in prompt
        assert "Carry the referenced bag naturally" in prompt
        assert "grip" in prompt.lower() and "occlusion" in prompt.lower()
        return httpx.Response(200, json=response)

    result = await make_provider(kind, handler).try_on(person, garments)
    assert result == person
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["openai", "gemini"])
@pytest.mark.parametrize("count", [0, 6])
async def test_zero_or_six_garments_are_rejected_before_http(kind, count, outfit_inputs):
    person, garments, _ = outfit_inputs
    calls = []

    def handler(request):
        calls.append(request)
        raise AssertionError("Invalid garment counts must not send a provider request")

    selected = [] if count == 0 else [*garments, garments[0]]
    with pytest.raises(AIProviderError) as error:
        await make_provider(kind, handler).try_on(person, selected)
    assert error.value.code == "invalid_request"
    assert calls == []
