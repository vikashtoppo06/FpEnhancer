"""
FpEnhancer — secure server-side session authentication.

Design goals
------------
* Credentials come ONLY from the APP_USERNAME / APP_PASSWORD environment
  variables. They are never rendered into HTML/JS and never logged.
* Sessions are stored server-side (in-memory). The browser only receives an
  opaque, random, HttpOnly cookie. Nothing sensitive lives in the cookie.
* Idle timeout is enforced SERVER-SIDE: a session whose last meaningful
  activity is older than IDLE_TIMEOUT_SECONDS is rejected, regardless of
  what the browser does (JavaScript disabled, tampered timers, etc.).
* An absolute lifetime (ABSOLUTE_SESSION_SECONDS) caps how long a session can
  live even with continuous activity.
* Login attempts are rate-limited per client IP (in-memory, no Redis).
* No external dependencies beyond FastAPI / Starlette.
"""

import hmac
import logging
import os
import secrets
import threading
import time
from typing import Dict, Optional

from fastapi import HTTPException, Request, Response

logger = logging.getLogger("fpenhancer.auth")


# --------------------------------------------------
# CONFIG (environment)
# --------------------------------------------------

def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip() or default)
        return value if value > 0 else default
    except ValueError:
        return default


APP_USERNAME = os.environ.get("APP_USERNAME", "")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

# 5 minutes of inactivity -> session is invalid (server-side enforced)
IDLE_TIMEOUT_SECONDS = _env_int("IDLE_TIMEOUT_SECONDS", 300)

# Hard cap on the total lifetime of a session (default 12 h)
ABSOLUTE_SESSION_SECONDS = _env_int("ABSOLUTE_SESSION_SECONDS", 12 * 60 * 60)

SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "fp_session")

# Force the Secure cookie flag on/off. When unset, it is auto-detected from
# the request (HTTPS directly, or X-Forwarded-Proto=https behind Railway's proxy).
_cookie_secure_env = os.environ.get("SESSION_COOKIE_SECURE", "").strip().lower()
COOKIE_SECURE_OVERRIDE: Optional[bool] = (
    True if _cookie_secure_env in ("1", "true", "yes") else
    False if _cookie_secure_env in ("0", "false", "no") else
    None
)

# Login brute-force protection (per client IP)
LOGIN_MAX_ATTEMPTS = _env_int("LOGIN_MAX_ATTEMPTS", 8)
LOGIN_LOCKOUT_SECONDS = _env_int("LOGIN_LOCKOUT_SECONDS", 15 * 60)


def auth_configured() -> bool:
    return bool(APP_USERNAME) and bool(APP_PASSWORD)


if not auth_configured():
    # Never print the values — only whether they are present.
    logger.warning(
        "APP_USERNAME / APP_PASSWORD are not set. "
        "Login is disabled until both environment variables are configured."
    )


# --------------------------------------------------
# SESSION STORE (server-side, in-memory)
# --------------------------------------------------

class Session:
    __slots__ = ("sid", "created_at", "last_active")

    def __init__(self, sid: str, now: float):
        self.sid = sid
        self.created_at = now
        self.last_active = now

    def is_expired(self, now: float) -> bool:
        if now - self.last_active > IDLE_TIMEOUT_SECONDS:
            return True
        if now - self.created_at > ABSOLUTE_SESSION_SECONDS:
            return True
        return False

    def remaining(self, now: float) -> int:
        idle_left = IDLE_TIMEOUT_SECONDS - (now - self.last_active)
        abs_left = ABSOLUTE_SESSION_SECONDS - (now - self.created_at)
        return max(0, int(min(idle_left, abs_left)))


class SessionStore:
    def __init__(self):
        self._sessions: Dict[str, Session] = {}
        self._lock = threading.Lock()
        self._last_purge = 0.0

    def create(self) -> Session:
        now = time.time()
        sid = secrets.token_urlsafe(32)
        session = Session(sid, now)
        with self._lock:
            self._sessions[sid] = session
            self._purge(now)
        return session

    def get(self, sid: Optional[str], touch: bool) -> Optional[Session]:
        """Return a valid session or None. If `touch`, refresh last_active."""
        if not sid:
            return None
        now = time.time()
        with self._lock:
            session = self._sessions.get(sid)
            if session is None:
                return None
            if session.is_expired(now):
                # Server-side idle / absolute timeout reached -> destroy.
                self._sessions.pop(sid, None)
                return None
            if touch:
                session.last_active = now
            self._purge(now)
            return session

    def delete(self, sid: Optional[str]) -> None:
        if not sid:
            return
        with self._lock:
            self._sessions.pop(sid, None)

    def _purge(self, now: float) -> None:
        # Opportunistic cleanup, at most once a minute.
        if now - self._last_purge < 60:
            return
        self._last_purge = now
        expired = [k for k, s in self._sessions.items() if s.is_expired(now)]
        for k in expired:
            self._sessions.pop(k, None)


SESSIONS = SessionStore()


# --------------------------------------------------
# LOGIN RATE LIMITING
# --------------------------------------------------

class LoginLimiter:
    def __init__(self):
        self._attempts: Dict[str, list] = {}
        self._lock = threading.Lock()

    def is_locked(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            times = [t for t in self._attempts.get(key, []) if now - t < LOGIN_LOCKOUT_SECONDS]
            self._attempts[key] = times
            return len(times) >= LOGIN_MAX_ATTEMPTS

    def record_failure(self, key: str) -> None:
        now = time.time()
        with self._lock:
            times = [t for t in self._attempts.get(key, []) if now - t < LOGIN_LOCKOUT_SECONDS]
            times.append(now)
            self._attempts[key] = times
            if len(self._attempts) > 5000:  # keep memory bounded
                self._attempts.clear()

    def reset(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)


LOGIN_LIMITER = LoginLimiter()


# --------------------------------------------------
# HELPERS
# --------------------------------------------------

def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


def is_https(request: Request) -> bool:
    if COOKIE_SECURE_OVERRIDE is not None:
        return COOKIE_SECURE_OVERRIDE
    proto = request.headers.get("x-forwarded-proto", "")
    if proto:
        return proto.split(",")[0].strip().lower() == "https"
    return request.url.scheme == "https"


def verify_credentials(username: str, password: str) -> bool:
    """Constant-time comparison; never log inputs."""
    if not auth_configured():
        return False
    ok_user = hmac.compare_digest(username.encode("utf-8"), APP_USERNAME.encode("utf-8"))
    ok_pass = hmac.compare_digest(password.encode("utf-8"), APP_PASSWORD.encode("utf-8"))
    return ok_user and ok_pass


def set_session_cookie(response: Response, request: Request, sid: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=sid,
        max_age=ABSOLUTE_SESSION_SECONDS,
        httponly=True,
        secure=is_https(request),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=is_https(request),
        samesite="lax",
    )


def get_session(request: Request, touch: bool) -> Optional[Session]:
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    return SESSIONS.get(sid, touch=touch)


def login_session(request: Request, response: Response) -> Session:
    # Rotate: drop any previous session bound to this browser.
    SESSIONS.delete(request.cookies.get(SESSION_COOKIE_NAME))
    session = SESSIONS.create()
    set_session_cookie(response, request, session.sid)
    return session


def logout_session(request: Request, response: Response) -> None:
    SESSIONS.delete(request.cookies.get(SESSION_COOKIE_NAME))
    clear_session_cookie(response, request)


# --------------------------------------------------
# FASTAPI DEPENDENCIES
# --------------------------------------------------

def require_auth(request: Request) -> Session:
    """
    Dependency for API routes (e.g. /enhance).
    Counts as meaningful activity -> refreshes the idle timer.
    Raises 401 when there is no valid (non-expired) session.
    """
    session = get_session(request, touch=True)
    if session is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return session


def require_auth_no_touch(request: Request) -> Session:
    """Dependency that validates the session WITHOUT extending it."""
    session = get_session(request, touch=False)
    if session is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return session
