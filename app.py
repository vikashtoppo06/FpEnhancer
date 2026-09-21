import os
import io
import re
import time
import uuid
import cv2
import yaml
import torch
import numpy as np
import secrets
import hmac
import zipfile

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Depends
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from easydict import EasyDict as edict


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "ckpts", "Enhancer")
MODEL_PATH = os.path.join(MODEL_DIR, "best.pth")
CONFIG_PATH = os.path.join(MODEL_DIR, "config_enhancer.yaml")
INPUT_DIR = os.path.join(BASE_DIR, "data", "imgs")
OUTPUT_DIR = os.path.join(BASE_DIR, "data", "result", "Enhancer")
STATIC_DIR = os.path.join(BASE_DIR, "static")
INDEX_PATH = os.path.join(STATIC_DIR, "index.html")
LOGIN_PATH = os.path.join(STATIC_DIR, "login.html")

os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
IDLE_TIMEOUT = 5 * 60
COOKIE_NAME = "fp_session"

APP_USERNAME = os.getenv("APP_USERNAME", "vikash")
APP_PASSWORD = os.getenv("APP_PASSWORD", "")

# In-memory sessions are intentional for this single-instance Railway app.
# A Railway restart logs users out, which is safe and expected.
SESSIONS = {}


with open(CONFIG_PATH, "r") as f:
    cfg = edict(yaml.safe_load(f))

device = torch.device("cpu")

model = Enhancer(
    img_channel=cfg.MODEL.img_channel,
    width=cfg.MODEL.width,
    mid_blk_num=cfg.MODEL.mid_blk_num,
    enc_blk_nums=cfg.MODEL.enc_blk_nums,
    dec_blk_nums=cfg.MODEL.dec_blk_nums,
    dw_expand=cfg.MODEL.dw_expand,
    ffn_expand=cfg.MODEL.ffn_expand,
)

state_dict = torch.load(MODEL_PATH, map_location="cpu")
model.load_state_dict(state_dict)
model = model.to(device)
model.eval()


app = FastAPI(
    title="FpEnhancer API",
    description="AI Fingerprint Enhancement API",
)


if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def health_payload():
    return {"status": "online", "service": "FpEnhancer", "device": "CPU"}


@app.get("/health")
def health():
    return health_payload()


def current_session(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    entry = SESSIONS.get(token)
    if not entry:
        return None

    now = time.time()
    if now - entry["last"] > IDLE_TIMEOUT:
        SESSIONS.pop(token, None)
        return None

    entry["last"] = now
    return token


def require_session(request: Request):
    token = current_session(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return token


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def home(request: Request):
    if current_session(request):
        if os.path.isfile(INDEX_PATH):
            return FileResponse(
                INDEX_PATH,
                media_type="text/html",
                headers={"Cache-Control": "no-cache"},
            )
    return RedirectResponse(url="/login.html", status_code=303)


@app.get("/login.html", include_in_schema=False)
def login_page():
    if os.path.isfile(LOGIN_PATH):
        return FileResponse(
            LOGIN_PATH,
            media_type="text/html",
            headers={"Cache-Control": "no-cache"},
        )
    return JSONResponse({"detail": "Login page missing"}, status_code=500)


class LoginPayload(BaseModel):
    username: str
    password: str


@app.post("/login")
def login(payload: LoginPayload):
    if not APP_PASSWORD:
        raise HTTPException(
            status_code=500,
            detail="APP_PASSWORD is not configured on the server.",
        )

    user_ok = hmac.compare_digest(payload.username, APP_USERNAME)
    pass_ok = hmac.compare_digest(payload.password, APP_PASSWORD)

    if not (user_ok and pass_ok):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"username": APP_USERNAME, "last": time.time()}

    response = JSONResponse({"ok": True, "username": APP_USERNAME})
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=IDLE_TIMEOUT,
        path="/",
    )
    return response


@app.post("/logout")
def logout(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        SESSIONS.pop(token, None)

    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response


@app.get("/auth/status")
def auth_status(request: Request):
    token = current_session(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"authenticated": True, "username": SESSIONS[token]["username"]}


@app.post("/auth/keepalive")
def keepalive(request: Request, _token: str = Depends(require_session)):
    return {"ok": True}


@app.post("/enhance")
async def enhance(
    request: Request,
    file: UploadFile = File(...),
    _token: str = Depends(require_session),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Maximum file size is 25 MB")

    uid = uuid.uuid4().hex
    input_path = os.path.join(INPUT_DIR, uid + ".png")
    output_path = os.path.join(OUTPUT_DIR, uid + ".png")

    image_array = np.frombuffer(contents, dtype=np.uint8)
    image = cv2.imdecode(image_array, cv2.IMREAD_GRAYSCALE)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image")

    cv2.imwrite(input_path, image)

    try:
        from utils.data_loader import get_dataloader_test

        test_loader = get_dataloader_test(
            info_lst=[uid],
            img_dir=INPUT_DIR,
            batch_size=1,
        )

        with torch.no_grad():
            for imgs, _ftitle_lst in test_loader:
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
                    255,
                ).astype(np.uint8)
                cv2.imwrite(output_path, pred)
    finally:
        try:
            os.remove(input_path)
        except Exception:
            pass

    if not os.path.exists(output_path):
        raise HTTPException(status_code=500, detail="Enhancement failed")

    return FileResponse(
        output_path,
        media_type="image/png",
        filename="enhanced_fingerprint.png",
        headers={"X-Result-ID": uid},
    )


class ZipPayload(BaseModel):
    ids: list[str]


_UUID_RE = re.compile(r"^[0-9a-f]{32}$", re.I)


@app.post("/download-zip")
def download_zip(payload: ZipPayload, _token: str = Depends(require_session)):
    ids = []
    seen = set()

    for value in payload.ids[:100]:
        if not isinstance(value, str) or not _UUID_RE.fullmatch(value):
            continue
        if value not in seen:
            seen.add(value)
            ids.append(value)

    if not ids:
        raise HTTPException(status_code=400, detail="No enhanced images available")

    buffer = io.BytesIO()
    used_names = set()

    with zipfile.ZipFile(
        buffer,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
    ) as zf:
        for index, uid in enumerate(ids, 1):
            path = os.path.join(OUTPUT_DIR, uid + ".png")
            if not os.path.isfile(path):
                continue

            name = f"enhanced_fingerprint_{index}.png"
            while name.lower() in used_names:
                index += 1
                name = f"enhanced_fingerprint_{index}.png"
            used_names.add(name.lower())
            zf.write(path, arcname=name)

    if not used_names:
        raise HTTPException(status_code=404, detail="Enhanced files are no longer available")

    buffer.seek(0)
    filename = f"FpEnhancer_{time.strftime('%Y-%m-%d')}.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        },
    )
