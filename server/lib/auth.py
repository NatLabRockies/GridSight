"""API key authentication dependency for FastAPI routes."""
import os

from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

API_KEY_SEED = os.environ["API_KEY"]
api_key_header = APIKeyHeader(name="X-MyApp-ApiKey", auto_error=False)


def require_api_key(key: str = Depends(api_key_header)):
    if key != API_KEY_SEED:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
