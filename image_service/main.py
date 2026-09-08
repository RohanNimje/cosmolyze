"""
image_service/main.py — Cosmolyze Image Sidecar
================================================
Lightweight FastAPI microservice that wraps the duckduckgo_search library
to fetch genuine commercial product packshot URLs (Amazon, Nykaa, Sephora, etc.).

Why Python instead of Node.js fetch():
  - duckduckgo_search manages the vqd token lifecycle internally using a
    persistent requests.Session + cookie jar — this works from datacenter IPs.
  - Node.js raw fetch() against duckduckgo.com is blocked at the ASN level
    on Render/AWS IPs because the HTML response never contains the vqd token.

Endpoints:
  POST /image  { "product_name": "Cetaphil Moisturizing Cream" }
               -> { "image_url": "https://m.media-amazon.com/..." }
               -> HTTP 404 when no valid image found
               -> HTTP 502 on upstream DDG failure
  GET  /health -> { "status": "ok" }

Run locally:
  uvicorn image_service.main:app --reload --port 8001
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from duckduckgo_search import DDGS
import re
import logging
import time

# -- Logging ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("cosmolyze.image_svc")

# -- FastAPI app --------------------------------------------------------------
app = FastAPI(
    title="Cosmolyze Image Service",
    description="Zero-API commercial product packshot engine using DuckDuckGo",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5000", "http://127.0.0.1:5000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# -- Domain priority gate -----------------------------------------------------
# URLs whose hostname contains one of these strings are prioritised,
# in the order listed. Official retail CDNs serve studio/packshot images.
PRIORITY_CDN_HOSTS: list = [
    "nykaa.com",
    "sephora.com",
    "amazon.com",       # covers m.media-amazon.com, images-amazon.com, etc.
    "tirabeauty.com",
    "myntra.com",
    "purplle.com",
]

# -- Invalid media filter -----------------------------------------------------
INVALID_TERMS: list = [
    "newspaper", "letter", "article", "journal", "officer", "military",
    "portrait", "founder", "ceo", "building", "document", "paper",
    "screenshot", "hand", "holding", "review", "user",
    "banner", "logo", "icon", "diagram", "chart",
]

RASTER_RE = re.compile(r'\.(jpe?g|png|webp)(\?.*)?$', re.IGNORECASE)


def is_valid_packshot(url: str, title: str = "") -> bool:
    if not url or not url.startswith("http"):
        return False
    haystack = f"{title} {url}".lower()
    if any(term in haystack for term in INVALID_TERMS):
        return False
    if not RASTER_RE.search(url):
        return False
    return True


def pick_best_image(results: list, product_name: str):
    valid = [
        r for r in results
        if is_valid_packshot(r.get("image", ""), r.get("title", ""))
    ]

    if not valid:
        log.warning(f"[ImageSvc] No valid candidates for: '{product_name}'")
        return None

    for host in PRIORITY_CDN_HOSTS:
        for r in valid:
            if host in r["image"]:
                log.info(f"[ImageSvc] Priority CDN ({host}) -> {r['image']}")
                return r["image"]

    log.info(f"[ImageSvc] Non-CDN match -> {valid[0]['image']}")
    return valid[0]["image"]


# -- Request / Response schemas -----------------------------------------------
class ImageRequest(BaseModel):
    product_name: str


class ImageResponse(BaseModel):
    image_url: str


# -- Routes -------------------------------------------------------------------
@app.get("/health")
def health_check():
    return {"status": "ok", "service": "cosmolyze-image-svc"}


@app.post("/image", response_model=ImageResponse)
def get_product_image(req: ImageRequest):
    name = req.product_name.strip()
    if not name or len(name) < 2:
        raise HTTPException(status_code=400, detail="product_name too short")

    query = (
        f'"{name}" product packaging bottle sephora nykaa amazon '
        f'-newspaper -letter -article -pdf'
    )
    log.info(f"[ImageSvc] Querying DDG: {query}")

    start = time.time()
    try:
        # DDGS() manages a persistent requests.Session internally.
        # This is what makes it work from datacenter IPs: the library handles
        # cookie jars, vqd token acquisition, and retry backoff automatically.
        with DDGS() as ddgs:
            results = list(
                ddgs.images(
                    query,
                    region="us-en",
                    safesearch="off",
                    max_results=30,
                )
            )
    except Exception as exc:
        elapsed = round((time.time() - start) * 1000)
        log.error(f"[ImageSvc] DDG error after {elapsed}ms: {exc}")
        raise HTTPException(status_code=502, detail=f"upstream_error: {exc}")

    elapsed = round((time.time() - start) * 1000)
    log.info(f"[ImageSvc] DDG returned {len(results)} results in {elapsed}ms")

    image_url = pick_best_image(results, name)
    if not image_url:
        raise HTTPException(status_code=404, detail="no_image_found")

    return ImageResponse(image_url=image_url)
