import os
from typing import List, Union
from pydantic_settings import BaseSettings
from pydantic import AnyHttpUrl, field_validator


class Settings(BaseSettings):
    PROJECT_NAME: str = "WhatsApp AI Auto-Reply System"
    API_V1_STR: str = "/api/v1"
    DEBUG: bool = True
    SECRET_KEY: str = "supersecret_jwt_key_change_in_production_whatsapp_ai"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 1 day

    # Database
    DATABASE_URL: str = "mysql+aiomysql://root:password@localhost:3306/whatsapp_ai"
    FALLBACK_TO_SQLITE: bool = True
    SQLITE_URL: str = "sqlite+aiosqlite:///./whatsapp_ai.db"

    # Meta WhatsApp Cloud API
    WHATSAPP_TOKEN: str = ""
    WHATSAPP_PHONE_NUMBER_ID: str = ""
    WHATSAPP_WABA_ID: str = ""
    WHATSAPP_VERIFY_TOKEN: str = "my_secure_verify_token_123"
    META_APP_SECRET: str = ""
    WHATSAPP_API_VERSION: str = "v20.0"

    # AI / LLM Configuration
    LLM_PROVIDER: str = "gemini"  # gemini, openai, or anthropic
    GEMINI_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    LLM_MODEL: str = "gemini-1.5-flash"
    TYPING_DELAY_ENABLED: bool = False  # Set False for instant sub-second Gemini responses
    TYPING_DELAY_MIN_SEC: float = 0.5
    TYPING_DELAY_MAX_SEC: float = 1.0

    # CORS
    BACKEND_CORS_ORIGINS: List[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
    ]

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    def assemble_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",")]
        elif isinstance(v, list):
            return v
        return [
            "http://localhost:5173",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
        ]

    class Config:
        case_sensitive = True
        env_file = ".env"
        extra = "allow"


settings = Settings()
