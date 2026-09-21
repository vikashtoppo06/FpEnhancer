import os
import time
import uuid
import logging
import cv2
import yaml
import torch
import numpy as np

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Response, Depends
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from starlette.background import BackgroundTask
from easydict import EasyDict as edict
from pydantic import BaseModel
import threading

from models.Enhancer import Enhancer
from utils.data_loader import get_dataloader_test

import auth
from auth import (
    require_auth,
    get_session,
    login_session,
    logout_session,
    verify_credentials,
    auth_configured,
    client_ip,
    LOGIN_LIMITER,
    IDLE_TIMEOUT_SECONDS,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fpenhancer")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

MODEL_DIR = os.path.join(
    BASE_DIR, "ckpts", "Enhancer"
)

MODEL_PATH = os.path.join(
    MODEL_DIR, "best.pth"
)

CONFIG_PATH = os.path.join(
    MODEL_DIR, "config_enhancer.yaml"
)

INPUT_DIR = os.path.join(
    BASE_DIR, "data", "imgs"
)

OUTPUT_DIR = os.path.join(
    BASE_DIR, "data", "result", "Enhancer"
)

STATIC_DIR = os.path.join(
    BASE_DIR, "static"
)

INDEX_PATH = os.path.join(
    STATIC_DIR, "index.html"
)

LOGIN_PATH = os.path.join(
    STATIC_DIR, "login.html"
)

# Upload limits / validation
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp"}
ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp",
    "image/x-bmp", "application/octet-stream", "",
}

os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


# --------------------------------------------------
# LOAD CONFIG
# --------------------------------------------------

with open(CONFIG_PATH, "r") as f:
    cfg = edict(yaml.safe_load(f))


# --------------------------------------------------
# DEVICE
# --------------------------------------------------

device = torch.device("cpu")


# --------------------------------------------------
# LOAD MODEL
# --------------------------------------------------

model = Enhancer(
    img_channel=cfg.MODEL.img_channel,
    width=cfg.MODEL.width,
    mid_blk_num=cfg.MODEL.mid_blk_num,
    enc_blk_nums=cfg.MODEL.enc_blk_nums,
    dec_blk_nums=cfg.MODEL.dec_blk_nums,
    dw_expand=cfg.MODEL.dw_expand,
    ffn_expand=cfg.MODEL.ffn_expand,
)


state_dict = torch.load(
    MODEL_PATH,
    map_location="cpu"
)

model.load_state_dict(state_dict)

model = model.to(device)

model.eval()

# Serialise CPU inference: the production server is CPU-only, so heavy
# requests must never run concurrently.
INFERENCE_LOCK = threading.Lock()


# --------------------------------------------------
# FASTAPI
# --------------------------------------------------

app = FastAPI(
    title="FpEnhancer API",
    description="AI Fingerprint Enhancement API",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
    )
    if auth.is_https(request):
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# --------------------------------------------------
# FRONTEND (served by this same FastAPI app)
# --------------------------------------------------

if os.path.isdir(STATIC_DIR):
    app.mount(
        "/static",
        StaticFiles(directory=STATIC_DIR),
        name="static"
    )


def health_payload():

    return {
        "status": "online",
        "service": "FpEnhancer",
        "device": "CPU"
    }


@app.get("/health")
def health():

    return health_payload()


# --------------------------------------------------
# AUTHENTICATION
# --------------------------------------------------

class LoginBody(BaseModel):
    username: str = ""
    password: str = ""


def _no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/login", include_in_schema=False)
def login_page(request: Request):

    # Already authenticated -> straight to the dashboard.
    if get_session(request, touch=False) is not None:
        return RedirectResponse(url="/", status_code=303)

    if os.path.isfile(LOGIN_PATH):
        return FileResponse(
            LOGIN_PATH,
            media_type="text/html",
            headers={"Cache-Control": "no-store"}
        )

    raise HTTPException(status_code=404, detail="Login page missing")


@app.post("/login")
async def login(request: Request, response: Response):

    if not auth_configured():
        raise HTTPException(
            status_code=503,
            detail="Login is not configured on the server."
        )

    ip = client_ip(request)
    if LOGIN_LIMITER.is_locked(ip):
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts. Please try again later."
        )

    # Accept JSON (the dashboard) or classic form posts (no-JS fallback).
    username = ""
    password = ""
    content_type = request.headers.get("content-type", "")
    try:
        if "application/json" in content_type:
            body = LoginBody(**(await request.json()))
            username, password = body.username, body.password
        else:
            form = await request.form()
            username = str(form.get("username", ""))
            password = str(form.get("password", ""))
    except Exception:
        raise HTTPException(status_code=400, detail="Malformed login request")

    username = username.strip()[:256]
    password = password[:1024]

    if not verify_credentials(username, password):
        LOGIN_LIMITER.record_failure(ip)
        # Never log the submitted credentials.
        logger.info("Failed login attempt from %s", ip)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    LOGIN_LIMITER.reset(ip)
    login_session(request, response)
    _no_store(response)

    return {
        "ok": True,
        "idle_timeout": IDLE_TIMEOUT_SECONDS,
    }


@app.post("/logout")
def logout(request: Request, response: Response):

    logout_session(request, response)
    _no_store(response)
    return {"ok": True}


@app.get("/logout", include_in_schema=False)
def logout_get(request: Request):

    # Convenience for no-JS clients / direct navigation.
    response = RedirectResponse(url="/login", status_code=303)
    logout_session(request, response)
    return response


@app.get("/auth/status")
def auth_status(request: Request, response: Response):

    # Pure status check: does NOT count as activity, so polling the status
    # can never keep an idle session alive.
    _no_store(response)
    session = get_session(request, touch=False)

    if session is None:
        return {
            "authenticated": False,
            "idle_timeout": IDLE_TIMEOUT_SECONDS,
        }

    return {
        "authenticated": True,
        "idle_timeout": IDLE_TIMEOUT_SECONDS,
        "remaining": session.remaining(time.time()),
    }


@app.post("/auth/ping")
def auth_ping(request: Request, response: Response):

    # Explicit "meaningful activity" heartbeat (e.g. Stay Logged In button,
    # uploads, removals). Refreshes the server-side idle timer.
    _no_store(response)
    session = get_session(request, touch=True)

    if session is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    return {
        "ok": True,
        "idle_timeout": IDLE_TIMEOUT_SECONDS,
        "remaining": IDLE_TIMEOUT_SECONDS,
    }


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def home(request: Request):

    # Dashboard requires a valid (non-expired) session.
    if get_session(request, touch=False) is None:
        if os.path.isfile(INDEX_PATH):
            return RedirectResponse(url="/login", status_code=303)
        # UI missing -> keep the original public JSON status.
        return JSONResponse(health_payload())

    # Serve the FpEnhancer web interface.
    if os.path.isfile(INDEX_PATH):
        return FileResponse(
            INDEX_PATH,
            media_type="text/html",
            headers={"Cache-Control": "no-store"}
        )

    return JSONResponse(health_payload())


def _safe_extension(filename: str) -> str:
    # Only the extension of the client filename is ever inspected; the name
    # itself is NEVER used to build a filesystem path (uuid is used instead).
    base = os.path.basename(filename or "")
    return os.path.splitext(base)[1].lower()


@app.post("/enhance")
async def enhance(
    file: UploadFile = File(...),
    _session=Depends(require_auth),
):

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="No file uploaded"
        )

    ext = _safe_extension(file.filename)
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Use JPG, JPEG, PNG or BMP."
        )

    if (file.content_type or "").lower() not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported content type."
        )

    # Unique filename
    uid = uuid.uuid4().hex

    input_path = os.path.join(
        INPUT_DIR,
        uid + ".png"
    )

    output_path = os.path.join(
        OUTPUT_DIR,
        uid + ".png"
    )

    # Read uploaded image (bounded)
    contents = await file.read(MAX_UPLOAD_BYTES + 1)

    if len(contents) == 0:
        raise HTTPException(
            status_code=400,
            detail="Empty file"
        )

    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File too large"
        )

    image_array = np.frombuffer(
        contents,
        dtype=np.uint8
    )

    image = cv2.imdecode(
        image_array,
        cv2.IMREAD_GRAYSCALE
    )

    if image is None:
        raise HTTPException(
            status_code=400,
            detail="Invalid image"
        )

    # Save input
    cv2.imwrite(
        input_path,
        image
    )


    # Run the (unchanged) CPU inference pipeline in a worker thread so the
    # event loop stays responsive (auth / health / status calls) during
    # long CPU jobs. A lock serialises inference: one image at a time.
    try:
        await run_in_threadpool(_run_inference, uid, output_path)
    except Exception:
        logger.exception("Inference failed")
    finally:
        # Delete input
        try:
            os.remove(input_path)
        except Exception:
            pass


    if not os.path.exists(output_path):

        raise HTTPException(
            status_code=500,
            detail="Enhancement failed"
        )


    # Serve the result, then remove it from disk once sent so the
    # container's filesystem does not fill up during bulk batches.
    return FileResponse(
        output_path,
        media_type="image/png",
        filename="enhanced_fingerprint.png",
        background=BackgroundTask(_remove_quietly, output_path),
    )


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except Exception:
        pass


def _run_inference(uid: str, output_path: str) -> None:

    with INFERENCE_LOCK:

        # --------------------------------------------------
        # PREPARE INPUT USING ORIGINAL DATA LOADER
        # --------------------------------------------------

        test_loader = get_dataloader_test(
            info_lst=[uid],
            img_dir=INPUT_DIR,
            batch_size=1
        )


        # --------------------------------------------------
        # INFERENCE
        # --------------------------------------------------

        with torch.no_grad():

            for imgs, ftitle_lst in test_loader:

                imgs = imgs.float().to(device)

                decoded_images = model(imgs)

                pred = (
                    decoded_images[0]
                    .detach()
                    .squeeze()
                    .cpu()
                    .numpy()
                )

                pred = np.clip(
                    255 * (1 - pred),
                    0,
                    255
                ).astype(np.uint8)

                cv2.imwrite(
                    output_path,
                    pred
                )
