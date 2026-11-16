"""Billing & payments (demo): connect Ozow, switch it off/on, pay a Ryno-Tec invoice; tenant pays rent online.

Run:  python3 tests/ui/billing_test.py
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
BASE = f"http://localhost:{server.server_port}"
errors = []

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(page.url + " " + str(e) + " " + (e.stack or "")))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(f"{BASE}/index.html")
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")
    page.locator(".lock-offer [data-x]").click()

    page.locator(".nav").get_by_role("link", name="Billing & payments").click()
    page.wait_for_url("**/billing.html")
    expect(page.locator("#oz-state")).to_have_text("Not connected")
    expect(page.locator("#plan-h").locator("..")).to_contain_text("Growth")
    expect(page.locator("#unbilled")).to_contain_text("R 22,50")

    # Connect: a short key is refused, then a good one saves in test mode
    page.get_by_role("button", name="Connect Ozow").click()
    page.get_by_label("Site Code").fill("TST-RTC-001")
    page.get_by_label("Client ID").fill("client-123")
    page.get_by_label("Client Secret").fill("short")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("too short")
    page.get_by_label("Client Secret").fill("abcdef0123456789wxyz")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#oz-state")).to_have_text("Live")
    expect(page.locator("#oz-h").locator("../..")).to_contain_text("wxyz")
    page.screenshot(path=str(SHOTS / "billing.png"), full_page=True)

    page.get_by_role("button", name="Switch off").click()
    expect(page.locator("#oz-state")).to_have_text("Switched off")
    page.get_by_role("button", name="Switch on").click()
    expect(page.locator("#oz-state")).to_have_text("Live")

    # Pay Ryno-Tec's invoice
    page.get_by_role("button", name="Pay now").click()
    expect(page.locator(".modal")).to_contain_text("Ryno-Tec Consulting")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".t-table")).to_contain_text("Paid")

    # Help guide covers it
    page.goto(f"{BASE}/help.html")
    expect(page.locator("#owners")).to_contain_text("Let tenants pay rent online")

    # The tenant side of the demo can pay online
    page.goto(f"{BASE}/tenant.html#payments")
    pay = page.locator("[data-action=pay]").first
    if pay.count():
        pay.click()
        expect(page.locator(".modal")).to_contain_text("straight to")
    browser.close()

server.shutdown()
if errors:
    print("Console errors:", *errors, sep="\n  "); sys.exit(1)
print("Billing tests passed")
