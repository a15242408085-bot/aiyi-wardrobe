"""Start the real Wardrowbe API locally without Docker, PostgreSQL or Redis."""

import argparse
import json
import os
from pathlib import Path
import secrets
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8000)
args = parser.parse_args()
backend = Path(__file__).resolve().parents[1] / "backend"
local_data = backend / ".local"
local_data.mkdir(exist_ok=True)
secrets_path = local_data / "secrets.json"
if not secrets_path.exists():
    secrets_path.write_text(json.dumps({"secret_key": secrets.token_hex(32)}))
    secrets_path.chmod(0o600)
local_secrets = json.loads(secrets_path.read_text())

os.environ.update({
    "LOCAL_DEVELOPMENT": "true",
    "DEBUG": "true",
    "APP_NAME": "爱衣橱",
    "SECRET_KEY": local_secrets["secret_key"],
    "DATABASE_URL": f"sqlite+aiosqlite:///{local_data / 'wardrobe.sqlite3'}",
    "STORAGE_PATH": str(local_data / "media"),
    "AI_INTERNAL_ENABLED": "false",
    "BG_REMOVAL_PROVIDER": "disabled",
    "CORS_ORIGINS": '["http://localhost:3000", "http://127.0.0.1:3000"]',
})
for setting in ("OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "FORWARD_AUTH_SECRET"):
    os.environ[setting] = ""
sys.path.insert(0, str(backend))
os.chdir(backend)

import uvicorn

uvicorn.run("app.main:app", host="127.0.0.1", port=args.port)
