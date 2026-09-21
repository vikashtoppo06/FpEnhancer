<!--
 * @Description: 
 * @Author: Xiongjun Guan
 * @Date: 2024-12-09 15:39:59
 * @version: 0.0.1
 * @LastEditors: Xiongjun Guan
 * @LastEditTime: 2025-01-02 10:59:52
 * 
 * Copyright (C) 2024 by Xiongjun Guan, Tsinghua University. All rights reserved.
-->
# FpEnhancer
This is a simple baseline for fingerprint enhancement.

We use the enhancer model of this repository‌ in [Joint Identity Verification and Pose Alignment for Partial Fingerprints](https://arxiv.org/abs/2405.03959) 

## Introduction
This is a `UNet` structured network for fingerprint enhancement. Input a fingerprint image, and the network will output the enhancement result in binary image format. Because a fully convolutional structure is used, there is no requirement for input size.


The basic block  comes from 
> Chen L, Chu X, Zhang X, et al. Simple baselines for image restoration[C]//European conference on computer vision. Cham: Springer Nature Switzerland, 2022: 17-33.

The overall flowchart of our proposed algorithm is shown as follows.
<br>
<p align="center">
    <img src="./images/flowchart_Unet.png"/ width=90%> <br />
</p>
<br>

We also explored the `VQVAE` form. Specifically, the codebook part is added between the original encoder and decoder, and the loss of quantization is additionally supervised.
The codebook block comes from
> Van Den Oord A, Vinyals O. Neural discrete representation learning[J]. Advances in neural information processing systems, 2017, 30.

The overall flowchart of our new algorithm is shown as follows.
<br>
<p align="center">
    <img src="./images/flowchart_VQVAE.png"/ width=90%> <br />
</p>
<br>

In addition, we also tried the form of `CodeFormer`. On the basis of the original `VQVAE`, a transformer is added to select the serial number of codebook. We use `VQFormer` to refer to it in the following text.
> Esser P, Rombach R, Ommer B. Taming transformers for high-resolution image synthesis[C]//Proceedings of the IEEE/CVF conference on computer vision and pattern recognition. 2021: 12873-12883.
> 
> Zhou S, Chan K, Li C, et al. Towards robust blind face restoration with codebook lookup transformer[J]. Advances in Neural Information Processing Systems, 2022, 35: 30599-30611.

The overall flowchart of our new algorithm is shown as follows.
<br>
<p align="center">
    <img src="./images/flowchart_VQFormer.png"/ width=90%> <br />
</p>
<br>



We use about `800` high-quality rolled fingerprints and binary image extracted by VeriFinger as dataset. During training, `128x128` image patches are randomly sampled from the original complete image. The image patches are then added with some random noise as augmentation. The methods and examples of augmentation can refer to 
> X. Guan, Z. Pan, J. Feng and J. Zhou, "Joint Identity Verification and Pose Alignment for Partial Fingerprints," in IEEE Transactions on Information Forensics and Security, vol. 20, pp. 249-263, 2025.

Examples of image augmentation are shown as follows.
<br>
<p align="center">
    <img src="./images/augmentation.png"/ width=90%> <br />
</p>
<br>

## Run
* **train Unet**
    ```shell
    python train_enhancer.py
    ```
* **train VQVAE**
    ```shell
    python train_VQenhancer.py
    ```

* **train VQFormer**
    ```shell
    python train_VQFormerEnhancer.py
    ```

* **test Unet**
    ```shell
    python inference_enhancer.py
    ```
* **test VQVAE**
    ```shell
    python inference_VQenhancer.py
    ```
* **test VQFormer**
    ```shell
    python test_VQFormerEnhancer.py
    ```

## Web App (FastAPI + FpEnhancer UI)
The `app.py` FastAPI application serves both the web interface and the enhancement API from one origin.
The UI is a **bulk fingerprint enhancement dashboard** protected by a secure server-side login.

```shell
pip install -r requirements.txt
export APP_USERNAME=youruser
export APP_PASSWORD=yourstrongpassword
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then open `http://localhost:8000` (on Railway: the deployed service URL).

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_USERNAME` | yes | — | Login username (never sent to the browser) |
| `APP_PASSWORD` | yes | — | Login password (never sent to the browser, never logged) |
| `IDLE_TIMEOUT_SECONDS` | no | `300` | Server-enforced idle timeout (5 min) |
| `ABSOLUTE_SESSION_SECONDS` | no | `43200` | Hard cap on session lifetime (12 h) |
| `SESSION_COOKIE_SECURE` | no | auto | Force `Secure` cookie flag (`true`/`false`). Auto-detected from HTTPS / `X-Forwarded-Proto` |
| `MAX_UPLOAD_MB` | no | `25` | Max upload size per image |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_SECONDS` | no | `8` / `900` | Login brute-force protection per IP |

If `APP_USERNAME` / `APP_PASSWORD` are missing, login is disabled (HTTP 503) and the dashboard cannot be accessed.

### Routes

| Route | Auth | Description |
|-------|------|-------------|
| `GET /` | ✔ | Dashboard (`static/index.html`); redirects to `/login` when not authenticated |
| `GET /login` | — | Login page |
| `POST /login` | — | JSON `{username, password}` (or form) → sets HttpOnly session cookie |
| `POST /logout` | — | Destroys the session, clears the cookie |
| `GET /auth/status` | — | `{authenticated, idle_timeout, remaining}` — does **not** extend the session |
| `POST /auth/ping` | ✔ | Marks meaningful activity; refreshes the server-side idle timer |
| `GET /health` | — | `{"status": "online", "service": "FpEnhancer", "device": "CPU"}` |
| `POST /enhance` | ✔ | multipart/form-data, field `file` → returns enhanced `image/png` |
| `/static/*` | — | CSS / JS / icon assets (JSZip is vendored in `static/vendor/`) |

### Security model

* Sessions are stored server-side (in-memory); the cookie is an opaque random token, `HttpOnly`, `SameSite=Lax`, `Secure` under HTTPS.
* **Idle timeout is enforced by the server** (`auth.py`): a session with no meaningful activity for 5 minutes is invalid, even with JavaScript disabled.
  The dashboard additionally warns 30 s before expiry with a **Stay Logged In** button and auto-logs out.
* `/enhance` rejects unauthenticated requests (401), non-image extensions (415), corrupt images (400) and oversized uploads (413).
  Client filenames are never used as filesystem paths (UUIDs are used); temporary files are deleted after the response is sent.
* CPU inference is serialised with a lock and executed in a worker thread, so the API stays responsive during long jobs.

### Bulk workflow

Login → drag & drop / choose one or many images (JPG, JPEG, PNG, BMP) → each image becomes a card
(original preview, filename, size, status) → **Enhance All** processes them sequentially through the existing
`POST /enhance` (progress `3 / 10 completed`, per-card `Pending / Processing... / Completed / Failed`) →
**Download** per image (`finger1.jpg` → `finger1_enhanced.png`), **Retry** failed images, **Before / After** slider,
**Download All as ZIP** (client-side via JSZip; successful images only; duplicate names de-duplicated), **Clear All**.

### Railway

The `Dockerfile` is unchanged (CPU-only). Set `APP_USERNAME` and `APP_PASSWORD` in the Railway service variables.
Railway terminates TLS and forwards `X-Forwarded-Proto: https`, so the session cookie is automatically marked `Secure`.

## Notice :exclamation:
Due to the fact that we only add some simple modal noise during training, there are still challenges in difficult scenarios such as latent fingerprints, highly blurry/incomplete images or complex backgrounds.
Below are examples before and after fingerprint enhancement.

- example 1
<p align="center">
    <img src="./images/ex-1.png"/ width=90%> <br />
</p>
<br>

- example 2
<p align="center">
    <img src="./images/ex-2.png"/ width=90%> <br />
</p>
<br>

- example 3
<p align="center">
    <img src="./images/ex-3.png"/ width=90%> <br />
</p>
<br>

- example 4
<p align="center">
    <img src="./images/ex-4.png"/ width=90%> <br />
</p>
<br>

- example 5
<p align="center">
    <img src="./images/ex-5.png"/ width=90%> <br />
</p>
<br>

- example 6
<p align="center">
    <img src="./images/ex-6.png"/ width=90%> <br />
</p>
<br>

- example 7
<p align="center">
    <img src="./images/ex-7.png"/ width=90%> <br />
</p>
<br>

## Citation
If you find this repository useful, please give us stars and use the following BibTeX entry for citation.
```
@ARTICLE{guan2024joint,
  author={Guan, Xiongjun and Pan, Zhiyu and Feng, Jianjiang and Zhou, Jie},
  journal={IEEE Transactions on Information Forensics and Security}, 
  title={Joint Identity Verification and Pose Alignment for Partial Fingerprints}, 
  year={2025},
  volume={20},
  number={},
  pages={249-263},
  keywords={Fingerprint recognition;Feature extraction;Pose estimation;Correlation;Fingers;Authentication;Transformers;Skin;Sensors;Prediction algorithms;Fingerprint recognition;partial fingerprint;fingerprint verification;fingerprint pose estimation;transformer},
  doi={10.1109/TIFS.2024.3516566}}
```

## License
This project is released under the MIT license. Please see the LICENSE file for more information.

## Contact me
If you have any questions about the code, please contact Xiongjun Guan gxj21@mails.tsinghua.edu.cn
