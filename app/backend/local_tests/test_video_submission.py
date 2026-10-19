"""An ambiguous paid submission must not become an ordinary resend button."""

import httpx
import pytest
from pydantic import SecretStr

from app.services.aiyi_provider import AIProviderError
from app.services.aiyi_settings import AIServiceInput, WAVESPEED_BASE
from app.services.aiyi_video_provider import WaveSpeedProvider


@pytest.mark.parametrize("outcome,expected", [
    ("read_error", "submission_unknown"), ("timeout", "submission_unknown"),
    ("invalid_json", "submission_unknown"), ("server_error", "submission_unknown"),
    ("unauthorized", "invalid_key"), ("quota", "rate_limit"),
    ("bad_request", "unsupported_request"),
])
async def test_generation_submission_classifies_ambiguous_responses(outcome, expected, picture_bytes):
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/media/upload/binary"):
            return httpx.Response(200, json={"code": 200, "data": {"download_url": "https://cdn.example.test/source.jpg"}})
        if outcome == "read_error":
            raise httpx.ReadError("response lost", request=request)
        if outcome == "timeout":
            raise httpx.ReadTimeout("response timeout", request=request)
        if outcome == "invalid_json":
            return httpx.Response(200, content=b"broken response")
        statuses = {"server_error": 503, "unauthorized": 401, "quota": 429, "bad_request": 400}
        return httpx.Response(statuses[outcome], json={"error": {"code": "test"}})

    provider = WaveSpeedProvider(AIServiceInput(provider="wavespeed", base_url=WAVESPEED_BASE,
        model="bytedance/seedance-2.0/image-to-video", api_key=SecretStr("offline-test-key")),
        transport=httpx.MockTransport(handler))
    with pytest.raises(AIProviderError) as caught:
        await provider.generate(picture_bytes)
    assert caught.value.code == expected
    assert len(requests) == 2 and requests[-1].method == "POST"
