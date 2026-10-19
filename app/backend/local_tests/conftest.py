"""Isolated local configuration is set before any test imports the application."""

import asyncio
import os
import shutil
import sys
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_data = TemporaryDirectory(prefix="aiyichu-test-")
os.environ.update({
    "DEBUG": "true", "LOCAL_DEVELOPMENT": "true", "AI_INTERNAL_ENABLED": "false",
    "DATABASE_URL": f"sqlite+aiosqlite:///{Path(_data.name) / 'test.sqlite3'}",
    "STORAGE_PATH": str(Path(_data.name) / "media"),
    "SECRET_KEY": "local-test-secret-" * 3,
    "OIDC_ISSUER_URL": "", "OIDC_CLIENT_ID": "", "FORWARD_AUTH_SECRET": "",
    "GEMINI_API_KEY": "", "OPENAI_API_KEY": "",
    "AIYI_API_KEY": "", "AIYI_CONFIG_PATH": str(Path(_data.name) / "aiyi-config"),
})


@pytest.fixture(autouse=True)
def isolated_local_database():
    from app.database import Base, engine
    from app.main import app  # noqa: F401 -- register every model before create_all

    async def reset():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
            await connection.run_sync(Base.metadata.create_all)
        await engine.dispose()

    asyncio.run(reset())
    shutil.rmtree(Path(_data.name) / "aiyi-config", ignore_errors=True)
    yield


@pytest.fixture
def local_client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        yield client


@pytest.fixture
def login_user():
    def login(client, email):
        response = client.post("/api/v1/auth/sync", json={
            "external_id": email.replace("@", "-"), "email": email,
            "display_name": "本地测试",
        })
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}
    return login


@pytest.fixture
def picture_bytes():
    image = Image.new("RGB", (180, 240), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((50, 30, 130, 200), fill="navy")
    draw.rectangle((20, 40, 160, 80), fill="navy")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
