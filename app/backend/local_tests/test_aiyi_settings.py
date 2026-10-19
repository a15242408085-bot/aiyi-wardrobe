"""Credentials stay server-side, scoped to one user and destination."""

import json
from pathlib import Path

from app.config import get_settings


def settings_body(**overrides):
    return {"provider": "openai", "base_url": "https://api.openai.com/v1",
            "vision_model": "gpt-4.1-mini", "image_model": "gpt-image-1.5",
            "quality": "medium", **overrides}


def test_settings_encrypt_key_and_do_not_reuse_it_at_a_new_host(local_client, login_user):
    alice = login_user(local_client, "settings-alice@aiyichu.local")
    bob = login_user(local_client, "settings-bob@aiyichu.local")
    response = local_client.put("/api/v1/ai/settings", headers=alice,
                                json=settings_body(api_key="test-secret-not-for-real-api"))
    assert response.status_code == 200, response.text
    assert response.json()["configured"] is True
    assert "test-secret" not in response.text and "api_key" not in response.json()
    assert local_client.get("/api/v1/ai/settings", headers=bob).json()["configured"] is False
    root = Path(get_settings().aiyi_config_path) if get_settings().aiyi_config_path else Path(get_settings().storage_path).parent / "aiyi-config"
    saved = [p.read_text() for p in root.glob("*.json")]
    assert saved and all("test-secret-not-for-real-api" not in value for value in saved)
    assert any(json.loads(value).get("encrypted_api_key") for value in saved)

    # Empty key keeps the current destination's credential.
    response = local_client.put("/api/v1/ai/settings", headers=alice, json=settings_body(api_key=""))
    assert response.json()["key_source"] == "saved"
    # Switching servers must never silently forward an old credential.
    response = local_client.put("/api/v1/ai/settings", headers=alice, json=settings_body(
        provider="openai_compatible", base_url="https://example.invalid/v1"))
    assert response.status_code == 200 and response.json()["configured"] is False


def test_key_deletion_and_missing_key_are_truthful(local_client, login_user, picture_bytes):
    headers = login_user(local_client, "settings-delete@aiyichu.local")
    local_client.put("/api/v1/ai/settings", headers=headers, json=settings_body(api_key="unused-test-key"))
    cleared = local_client.delete("/api/v1/ai/settings/key", headers=headers)
    assert cleared.status_code == 200 and cleared.json()["configured"] is False
    result = local_client.post("/api/v1/ai/recognitions", headers=headers,
                              files={"image": ("shirt.png", picture_bytes, "image/png")})
    assert result.status_code == 503 and "尚未配置" in result.text
    assert local_client.get("/api/v1/ai/jobs", headers=headers).json()["jobs"] == []


def test_settings_reject_credential_urls_and_require_auth(local_client, login_user):
    assert local_client.get("/api/v1/ai/settings").status_code == 401
    headers = login_user(local_client, "settings-validation@aiyichu.local")
    for base in ["https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "http://example.com/v1"]:
        result = local_client.put("/api/v1/ai/settings", headers=headers,
                                  json=settings_body(provider="openai_compatible", base_url=base))
        assert result.status_code == 422
        assert "user:secret" not in result.text
