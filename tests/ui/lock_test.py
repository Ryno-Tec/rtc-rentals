"""App lock: PIN and fingerprint/face (WebAuthn, using Chromium's virtual authenticator).

Run:  python3 tests/ui/lock_test.py
"""
import functools, http.server, pathlib, threading, sys
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT / "web")))
threading.Thread(target=server.serve_forever, daemon=True).start()
# localhost is a secure context, which WebAuthn needs
BASE = f"http://localhost:{server.server_port}"

errors = []


def type_pin(page, pin):
    for d in pin:
        page.locator(f".lock-pad [data-k='{d}']").click()


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    cdp = ctx.new_cdp_session(page)
    cdp.send("WebAuthn.enable")
    auth = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
        "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
        "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})

    page.goto(f"{BASE}/index.html")
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")

    # First visit offers the lock
    offer = page.locator(".lock-offer")
    expect(offer).to_be_visible()
    page.screenshot(path=SHOTS / "lock-offer.png")
    offer.get_by_role("button", name="Set up").click()

    # Weak PIN refused, mismatch refused, then a good one with fingerprint
    page.locator("#lk-pin").fill("111111"); page.locator("#lk-pin2").fill("111111")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("6 digits")
    page.locator("#lk-pin").fill("482916"); page.locator("#lk-pin2").fill("482917")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("don’t match")
    page.locator("#lk-pin2").fill("482916")
    expect(page.locator(".modal [name=bio]")).to_be_checked()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    creds = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth["authenticatorId"]})["credentials"]
    assert len(creds) == 1, creds

    # Reopening the app (new session) locks it; the fingerprint prompt unlocks it
    page.evaluate("sessionStorage.clear()")
    page.reload()
    expect(page.locator(".nav")).to_be_visible()          # unlocked by the virtual fingerprint
    expect(page.locator("#app-lock")).to_have_count(0)

    # Without a fingerprint: wrong PIN, then the right one
    cdp.send("WebAuthn.setUserVerified", {"authenticatorId": auth["authenticatorId"], "isUserVerified": False})
    page.evaluate("sessionStorage.clear()")
    page.reload()
    expect(page.locator("#app-lock")).to_be_visible()
    expect(page.locator(".lock-msg")).to_contain_text("Use your PIN")
    page.screenshot(path=SHOTS / "lock-screen.png")
    type_pin(page, "000000")
    expect(page.locator(".lock-msg")).to_contain_text("4 tries left")
    type_pin(page, "482916")
    expect(page.locator("#app-lock")).to_have_count(0)
    expect(page.get_by_text("Monthly rent roll")).to_be_visible()

    # Moving between pages in the same session doesn't lock again
    page.goto(f"{BASE}/rent.html")
    expect(page.locator("#app-lock")).to_have_count(0)

    # Idle past the limit locks it on return
    # (leaving the page counts as activity, so age the timestamp as the next page starts)
    page.add_init_script("if (sessionStorage.getItem('age-once')) { sessionStorage.removeItem('age-once'); localStorage.setItem('rtc-last-active', String(Date.now() - 6 * 60000)); }")
    page.evaluate("sessionStorage.setItem('age-once', '1')")
    page.reload()
    expect(page.locator("#app-lock")).to_be_visible()
    type_pin(page, "482916")
    expect(page.locator("#app-lock")).to_have_count(0)

    # The tenant app has the lock too (separate login, so no lock set yet): its button opens settings
    page.goto(f"{BASE}/tenant.html")
    page.locator("#t-lock").click()
    expect(page.locator(".modal")).to_contain_text("Set up app lock")
    page.keyboard.press("Escape")

    # Five wrong PINs signs out and removes the lock
    page.goto(f"{BASE}/dashboard.html")
    page.evaluate("sessionStorage.removeItem('rtc-unlocked')")
    page.reload()
    for _ in range(5):
        type_pin(page, "000000")
        page.wait_for_timeout(150)
    page.wait_for_url("**/index.html", timeout=8000)
    assert page.evaluate("localStorage.getItem('rtc-lock:thabo@example.co.za')") is None

    # Turning it off from settings
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")
    page.locator("#navtoggle").click()
    page.locator("#applock").click()
    page.locator("#lk-pin").fill("739251"); page.locator("#lk-pin2").fill("739251")
    page.locator(".modal [name=bio]").uncheck() if page.locator(".modal [name=bio]").count() else None
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    if not page.locator("#applock").is_visible():
        page.locator("#navtoggle").click()
    page.locator("#applock").click()
    page.locator("#lk-off").click()
    assert page.evaluate("localStorage.getItem('rtc-lock:thabo@example.co.za')") is None
    browser.close()

if errors:
    print("Browser errors:\n" + "\n".join(errors))
    sys.exit(1)
print("App lock passed")
