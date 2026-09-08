"""
image_service/verify_image_engine.py
=====================================
Standalone smoke-test for the image engine.
Calls DuckDuckGo images directly (same code path as the FastAPI endpoint)
WITHOUT touching any AI APIs (Gemini / Groq / Scan).

Usage:
    .venv\\Scripts\\python.exe image_service\\verify_image_engine.py
"""

import sys
import time
import re

# ── inline copies of the helpers from main.py ──────────────────────────────
# (avoids any import issues; tests the exact same logic)

PRIORITY_CDN_HOSTS: list = [
    "nykaa.com",
    "sephora.com",
    "amazon.com",
    "tirabeauty.com",
    "myntra.com",
    "purplle.com",
]

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
        print(f"  x  No valid candidates for '{product_name}'")
        return None
    for host in PRIORITY_CDN_HOSTS:
        for r in valid:
            if host in r["image"]:
                print(f"  * Priority CDN hit ({host})")
                return r["image"]
    print(f"  > Non-CDN fallback used")
    return valid[0]["image"]


# ── test runner ─────────────────────────────────────────────────────────────

TEST_PRODUCTS = [
    "The Ordinary Caffeine Solution 5% + EGCG",
    "Cetaphil Moisturizing Cream",
    "Minimalist 10% Niacinamide Serum",
]


def run_test(product_name: str) -> bool:
    print(f"\n{'-'*60}")
    print(f"  PRODUCT : {product_name}")

    try:
        from duckduckgo_search import DDGS
    except ImportError as e:
        print(f"  x  Import error: {e}")
        print("     -> Run:  .venv\\Scripts\\pip install duckduckgo-search==6.3.7")
        return False

    query = (
        f'"{product_name}" product packaging bottle sephora nykaa amazon '
        f'-newspaper -letter -article -pdf'
    )
    print(f"  QUERY   : {query[:80]}...")

    start = time.time()
    try:
        with DDGS() as ddgs:
            results = list(
                ddgs.images(
                    query,
                    region="us-en",
                    safesearch="off",
                    max_results=30,
                )
            )
        elapsed_ms = round((time.time() - start) * 1000)
        print(f"  DDG     : {len(results)} results in {elapsed_ms} ms")
    except Exception as exc:
        elapsed_ms = round((time.time() - start) * 1000)
        print(f"  x  DDG error after {elapsed_ms} ms: {exc}")
        return False

    image_url = pick_best_image(results, product_name)
    if not image_url:
        print("  RESULT  : x  No valid image found")
        return False

    print(f"  RESULT  : OK  {image_url}")
    return True


if __name__ == "__main__":
    print("=" * 60)
    print("  Cosmolyze Image Engine -- Offline Verification")
    print("  (No AI APIs touched -- DuckDuckGo images only)")
    print("=" * 60)

    passed = 0
    for product in TEST_PRODUCTS:
        ok = run_test(product)
        if ok:
            passed += 1
        time.sleep(1)   # polite inter-request gap

    print(f"\n{'='*60}")
    print(f"  SUMMARY : {passed}/{len(TEST_PRODUCTS)} products returned a valid image URL")
    print("=" * 60)
    sys.exit(0 if passed == len(TEST_PRODUCTS) else 1)
