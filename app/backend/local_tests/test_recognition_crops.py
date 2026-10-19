"""Real image crop boundaries, using only synthetic images and temporary storage."""

from uuid import uuid4

import pytest
from PIL import Image, ImageDraw

from app.models.ai_task import AITask
from app.services import aiyi_tasks
from app.services.image_service import ImageService


@pytest.fixture(autouse=True)
def isolated_local_database():
    # Crop preparation needs neither a database nor the application's worker.
    yield


@pytest.fixture
def source_job(tmp_path, monkeypatch):
    monkeypatch.setattr(aiyi_tasks, "ImageService", lambda: ImageService(storage_path=str(tmp_path)))

    def save(image):
        user_id = uuid4()
        directory = tmp_path / str(user_id)
        directory.mkdir()
        image.save(directory / "source.png", format="PNG")
        return AITask(
            id=uuid4(), user_id=user_id, kind="recognition", status="awaiting_confirmation",
            stage="待确认", progress=100, attempt=1,
            inputs={"source": {"image_path": f"{user_id}/source.png"}}, result={},
        )

    return save


def garment(bbox):
    return {"name": "测试上衣", "type": "shirt", "colors": ["blue"],
            "primary_color": "blue", "season": ["spring"], "bbox": bbox}


@pytest.mark.asyncio
async def test_crop_keeps_nearby_markers_outside_model_box(source_job):
    image = Image.new("RGB", (201, 161), "white")
    draw = ImageDraw.Draw(image)
    # Every marker lies outside the model's original box (50.25,40.25,150.75,120.75).
    draw.rectangle((44, 60, 49, 90), fill=(255, 0, 0))
    draw.rectangle((151, 60, 157, 90), fill=(0, 180, 0))
    draw.rectangle((70, 35, 100, 39), fill=(0, 0, 255))
    draw.rectangle((70, 122, 100, 126), fill=(255, 220, 0))
    job = source_job(image)
    candidates = await aiyi_tasks._prepare_candidates(job, [garment([0.25, 0.25, 0.75, 0.75])])
    with Image.open(aiyi_tasks.owned_image_path(job.user_id, candidates[0]["paths"]["image_path"])) as crop:
        crop = crop.convert("RGB")
        left = crop.getpixel((3, 34))      # Original pixel (48,70).
        right = crop.getpixel((108, 34))  # Original pixel (153,70).
        top = crop.getpixel((35, 2))      # Original pixel (80,38).
        bottom = crop.getpixel((35, 87))  # Original pixel (80,123).
    # JPEG processing may soften edges, so test retained color rather than exact bytes.
    assert left[0] > 150 and left[0] > left[1] + 80 and left[0] > left[2] + 80
    assert right[1] > 100 and right[1] > right[0] + 60 and right[1] > right[2] + 60
    assert top[2] > 150 and top[2] > top[0] + 80 and top[2] > top[1] + 80
    assert bottom[0] > 150 and bottom[1] > 130 and bottom[2] < 100


@pytest.mark.asyncio
async def test_fractional_edges_round_outward_and_original_bbox_stays_private(source_job):
    bbox = [0.25, 0.25, 0.75, 0.75]
    job = source_job(Image.new("RGB", (201, 161), "white"))
    candidates = await aiyi_tasks._prepare_candidates(job, [garment(bbox)])
    candidate = candidates[0]
    assert candidate["image_kind"] == "crop"
    assert candidate["bbox"] == bbox
    with Image.open(aiyi_tasks.owned_image_path(job.user_id, candidate["paths"]["image_path"])) as crop:
        # 2.5% padding on all sides gives (45,36,156,125), with floor/ceil.
        assert crop.size == (111, 89)
    job.result = {"candidates": candidates}
    assert "bbox" not in aiyi_tasks.public_job(job)["result"]["candidates"][0]


@pytest.mark.asyncio
async def test_full_image_box_is_clipped_without_black_borders(source_job):
    job = source_job(Image.new("RGB", (201, 161), "white"))
    candidates = await aiyi_tasks._prepare_candidates(job, [garment([0, 0, 1, 1])])
    candidate = candidates[0]
    assert candidate["image_kind"] == "crop"
    assert candidate["bbox"] == [0, 0, 1, 1]
    with Image.open(aiyi_tasks.owned_image_path(job.user_id, candidate["paths"]["image_path"])) as crop:
        assert crop.size == (201, 161)
        assert all(minimum >= 250 for minimum, maximum in crop.convert("RGB").getextrema())


@pytest.mark.asyncio
@pytest.mark.parametrize("bbox", [
    None,
    [-0.1, 0, 0.5, 0.5],
    [0.8, 0.2, 0.2, 0.8],
    [0.4, 0.4, 0.401, 0.401],
    [0, 0, float("nan"), 1],
])
async def test_invalid_bbox_uses_original_image_fallback(source_job, bbox):
    job = source_job(Image.new("RGB", (201, 161), "white"))
    source_path = aiyi_tasks.owned_image_path(job.user_id, job.inputs["source"]["image_path"])
    original_bytes = source_path.read_bytes()
    candidates = await aiyi_tasks._prepare_candidates(job, [garment(bbox)])
    candidate = candidates[0]
    assert candidate["image_kind"] == "source"
    assert candidate["paths"] == job.inputs["source"]
    assert source_path.read_bytes() == original_bytes
    assert len(list(source_path.parent.iterdir())) == 1
