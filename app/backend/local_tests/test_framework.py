"""Meaningful local API smoke tests; independent of upstream's PostgreSQL suite."""

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import ValidationError
import pytest
from sqlalchemy.dialects import postgresql

from app.config import Settings
from app.main import app
from app.models.item import ClothingItem


def login(client, email):
    response = client.post("/api/v1/auth/sync", json={
        "external_id": email.replace("@", "-"), "email": email,
        "display_name": "本地测试",
    })
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def picture():
    image = Image.new("RGB", (180, 240), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((50, 30, 130, 200), fill="navy")
    draw.rectangle((20, 40, 160, 80), fill="navy")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_real_upload_persistence_ownership_and_saved_outfit():
    with TestClient(app) as client:
        assert client.get("/api/v1/health/ready").json()["status"] == "healthy"
        assert client.get("/api/v1/capabilities").json()["ai"] == {"vision": False, "text": False}
        alice = login(client, "alice@aiyichu.local")
        bob = login(client, "bob@aiyichu.local")
        upload = client.post("/api/v1/items", headers=alice,
            data={"name": "测试上衣", "type": "shirt", "colors": "blue", "skip_ai": "true"},
            files={"image": ("shirt.png", picture(), "image/png")})
        assert upload.status_code == 201, upload.text
        item = upload.json()
        item_id = item["id"]
        assert item["status"] == "ready"
        assert item["ai_processed"] is False
        assert client.get("/api/v1/items?colors=blue", headers=alice).json()["total"] == 1
        assert client.get("/api/v1/items", headers=bob).json()["total"] == 0
        assert client.get(f"/api/v1/items/{item_id}", headers=bob).status_code == 404
        media = client.get(f"/api/v1/images/{item['image_path']}", headers=alice)
        assert media.status_code == 200 and media.headers["content-type"] == "image/jpeg"
        assert client.get(f"/api/v1/images/{item['image_path']}", headers=bob).status_code == 401
        assert client.patch(f"/api/v1/items/{item_id}", headers=alice,
            json={"name": "修改后的上衣", "favorite": True}).status_code == 200
        outfit = client.post("/api/v1/outfits/studio", headers=alice,
            json={"items": [item_id], "occasion": "casual", "name": "测试搭配"})
        assert outfit.status_code == 201, outfit.text
        assert outfit.json()["source"] == "manual"
        outsider = client.post("/api/v1/outfits/studio", headers=bob,
            json={"items": [item_id], "occasion": "casual", "name": "不可保存"})
        assert outsider.status_code == 403, outsider.text
        assert client.post("/api/v1/outfits/suggest", headers=alice, json={}).status_code == 503
        assert client.post(f"/api/v1/items/{item_id}/remove-background", headers=alice).status_code == 503
        assert client.get("/api/v1/health/features").json()["background_removal"] is False
        outfit_id = outfit.json()["id"]
        assert client.delete(f"/api/v1/outfits/{outfit_id}", headers=alice).status_code == 204
        assert client.delete(f"/api/v1/items/{item_id}", headers=alice).status_code == 204
        assert client.get("/api/v1/items", headers=alice).json()["total"] == 0


def test_postgres_types_and_local_mode_guards():
    dialect = postgresql.dialect()
    assert str(ClothingItem.__table__.c.tags.type.compile(dialect=dialect)) == "JSONB"
    assert str(ClothingItem.__table__.c.colors.type.compile(dialect=dialect)) == "VARCHAR[]"
    with pytest.raises(ValidationError):
        Settings(local_development=False, database_url="sqlite+aiosqlite:///bad.db")
    with pytest.raises(ValidationError):
        Settings(local_development=True, debug=False)
