import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.api.router import api_router
from app.config import Settings, get_settings
from app.database import Base, engine
from app.logging_config import configure_logging
from app.services.aiyi_tasks import start_task_worker, stop_task_worker

settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    configure_logging(settings)
    warning = settings.validate_security()
    if warning:
        logger.error("Configuration: %s", warning)
    logger.info("Auth mode: %s", settings.get_auth_mode())
    if settings.local_development:
        # Models are imported by the routers before lifespan starts. Production
        # continues to use Alembic; SQLite files are disposable local development data.
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        await start_task_worker()
        logger.info("Local workspace: SQLite and durable AI tasks; upstream Redis queues disabled")
    try:
        yield
    finally:
        if settings.local_development:
            await stop_task_worker()
        await engine.dispose()


def docs_urls(settings: Settings) -> dict[str, str | None]:
    enabled = settings.dev_mode
    return {
        "docs_url": "/docs" if enabled else None,
        "redoc_url": "/redoc" if enabled else None,
        "openapi_url": "/openapi.json" if enabled else None,
    }


app = FastAPI(
    title=settings.app_name,
    description="AI-powered wardrobe management and outfit recommendations",
    version="1.0.0",
    lifespan=lifespan,
    **docs_urls(settings),
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# Enable GZip compression for responses > 500 bytes
app.add_middleware(GZipMiddleware, minimum_size=500)
# Include API router
app.include_router(api_router, prefix="/api/v1")


@app.middleware("http")
async def local_framework_boundaries(request: Request, call_next):
    if settings.local_development:
        path = request.url.path
        unsupported_suffixes = (
            "/rotate", "/remove-background", "/analyze", "/cancel-analysis",
            "/suggest", "/suggest-options", "/test-ai-endpoint",
        )
        if request.method == "POST" and (
            path.endswith(unsupported_suffixes) or "/pairings/generate/" in path
        ):
            return JSONResponse(
                status_code=503,
                content={"detail": "此功能尚未接入。本地框架模式已关闭 AI 和后台图片任务。"},
            )
    return await call_next(request)


# Global exception handlers
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = []
    for error in exc.errors():
        field = " -> ".join(str(loc) for loc in error["loc"])
        errors.append({"field": field, "message": error["msg"]})

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "Validation error",
            "errors": errors,
        },
    )


@app.exception_handler(ValidationError)
async def pydantic_validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    errors = []
    for error in exc.errors():
        field = " -> ".join(str(loc) for loc in error["loc"])
        errors.append({"field": field, "message": error["msg"]})

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "Validation error",
            "errors": errors,
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(f"Unhandled exception on {request.method} {request.url.path}: {exc}")

    # Don't expose internal error details in production
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "An unexpected error occurred. Please try again later.",
        },
    )
