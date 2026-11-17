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
    page.locator("#oz-id").fill("client-123")
    page.locator("#oz-secret").fill("short")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("too short")
    page.locator("#oz-secret").fill("abcdef0123456789wxyz")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#oz-state")).to_have_text("Live")
    expect(page.locator("#oz-h").locator("../..")).to_contain_text("wxyz")
    page.screenshot(path=str(SHOTS / "billing.png"), full_page=True)

    page.get_by_role("button", name="Switch off").click()
    expect(page.locator("#oz-state")).to_have_text("Switched off")
    page.get_by_role("button", name="Switch on").click()
    expect(page.locator("#oz-state")).to_have_text("Live")

    # Switch to a Private Key + API Key account: both keys needed, Payout API Key not asked for
    page.get_by_role("button", name="Edit connection").click()
    expect(page.locator("#oz-pk")).to_be_hidden()
    page.get_by_label("Private Key and API Key").check()
    expect(page.locator("#oz-id")).to_be_hidden()
    expect(page.locator(".modal")).to_contain_text("Not the Payout API Key")
    page.locator("#oz-pk").fill("pk-0123456789abcdefKEY9")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("Private Key and API Key")
    page.locator("#oz-api").fill("api-0123456789abcdef")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#oz-h").locator("../..")).to_contain_text("Private Key + API Key")
    expect(page.locator("#oz-h").locator("../..")).to_contain_text("KEY9")
    expect(page.locator("#oz-state")).to_have_text("Live")
    page.locator("[data-action=ap-settings]").click()
    expect(page.locator(".modal input[name=ozow_capitec]")).to_be_disabled()
    expect(page.locator(".modal")).to_contain_text("Needs Ozow One API keys")
    page.keyboard.press("Escape")
    expect(page.locator(".modal")).to_have_count(0)
    # ...and back to One API: new keys are needed when switching type
    page.get_by_role("button", name="Edit connection").click()
    page.get_by_label("Client ID and Client Secret").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("Client ID and Client Secret")
    page.locator("#oz-id").fill("client-123")
    page.locator("#oz-secret").fill("abcdef0123456789wxyz")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#oz-h").locator("../..")).to_contain_text("wxyz")

    # Pay Ryno-Tec's invoice
    page.get_by_role("button", name="Pay now").click()
    expect(page.locator(".modal")).to_contain_text("Ryno-Tec Consulting")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".t-table")).to_contain_text("Paid")

    # Change plan: upgrade to Pro, then back to Growth
    page.get_by_role("button", name="Change plan").click()
    page.locator(".plan-opt input[value=pro]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#plan-h").locator("..")).to_contain_text("Pro")
    page.get_by_role("button", name="Change plan").click()
    expect(page.locator(".plan-opt input[value=agency]")).to_be_disabled()
    page.locator(".plan-opt input[value=growth]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#plan-h").locator("..")).to_contain_text("Growth")
    page.screenshot(path=str(SHOTS / "billing-plan.png"), full_page=True)

    # Remove a tenant: one with paid rent goes to Past tenants
    page.goto(f"{BASE}/tenants.html")
    first = page.locator("article.card.prop").first
    name = first.locator("h2 span").first.inner_text()
    before = page.locator("article.card.prop").count()
    first.locator("[data-action=remove]").click()
    page.locator(".modal [type=submit]").click()
    expect(page.locator("article.card.prop")).to_have_count(before - 1)
    expect(page.locator(".past-tenants summary")).to_contain_text("Past tenants")
    page.locator(".past-tenants summary").click()
    expect(page.locator(".past-tenants")).to_contain_text(name)
    page.screenshot(path=str(SHOTS / "tenants-past.png"), full_page=True)

    # Admin is live-only and hidden from owners in the demo
    expect(page.locator(".nav")).not_to_contain_text("Admin dashboard")
    page.goto(f"{BASE}/admin.html")
    expect(page.locator("#view")).to_contain_text("live system only")

    # Automatic payments: owner switches them on (Ozow already connected above), tenant sets up Capitec Pay
    page.goto(f"{BASE}/billing.html")
    expect(page.locator("#ap-h")).to_be_visible()
    page.locator("[data-action=ap-settings]").click()
    page.locator(".modal input[name=ozow_capitec]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#ap-h").locator("../..")).to_contain_text("Tenants with Capitec")
    page.goto(f"{BASE}/tenant.html#payments")
    expect(page.locator("#ap-h")).to_be_visible()
    page.locator("[data-action=autopay-capitec]").click()
    page.locator(".modal [type=submit]").click()
    expect(page.locator("#ap-h").locator("..")).to_contain_text("On")
    page.screenshot(path=str(SHOTS / "tenant-autopay.png"), full_page=True)
    page.locator("[data-action=autopay-stop]").click()
    page.locator(".modal [type=submit]").click()
    expect(page.locator("[data-action=autopay-capitec]")).to_be_visible()

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
