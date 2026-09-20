import os
import uuid
import cv2
import yaml
import torch
import numpy as np

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from easydict import EasyDict as edict

from models.Enhancer import Enhancer
from utils.data_loader import get_dataloader_test


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


# --------------------------------------------------
# FASTAPI
# --------------------------------------------------

app = FastAPI(
    title="FpEnhancer API",
    description="AI Fingerprint Enhancement API"
)


@app.get("/")
def home():

    return {
        "status": "online",
        "service": "FpEnhancer",
        "device": "CPU"
    }


@app.post("/enhance")
async def enhance(
    file: UploadFile = File(...)
):

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="No file uploaded"
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

    # Read uploaded image
    contents = await file.read()

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


    # Delete input
    try:
        os.remove(input_path)
    except:
        pass


    if not os.path.exists(output_path):

        raise HTTPException(
            status_code=500,
            detail="Enhancement failed"
        )


    return FileResponse(
        output_path,
        media_type="image/png",
        filename="enhanced_fingerprint.png"
    )
