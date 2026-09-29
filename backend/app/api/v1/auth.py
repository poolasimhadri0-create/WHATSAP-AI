from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.core.security import create_access_token, verify_password
from app.db.session import get_db
from app.models.agent import Agent
from app.schemas.auth import LoginRequest, Token, AgentOut
from app.api.deps import get_current_agent

router = APIRouter()


@router.post("/login", response_model=Token)
async def login(credentials: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Authenticate agent and issue JWT access token."""
    stmt = select(Agent).where(Agent.email == credentials.email)
    result = await db.execute(stmt)
    agent = result.scalar_one_or_none()

    if not agent or not verify_password(credentials.password, agent.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        subject=agent.email, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me", response_model=AgentOut)
async def get_me(current_agent: Agent = Depends(get_current_agent)):
    """Get current authenticated agent details."""
    return current_agent
