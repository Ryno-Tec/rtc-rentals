"""Browser smoke test for demo mode: sign-in page, dashboard, properties and units CRUD.

Run:  python3 tests/ui/smoke_test.py   (needs `pip install playwright && playwright install chromium`)
Screenshots land in tests/ui/screenshots/.
"""
import functools, http.server, pathlib, threading, sys
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
SHOTS = pathlib.Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

handler = functools.partial(Quiet, directory=str(WEB))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"

errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    for name, viewport in [("desktop", {"width": 1280, "height": 860}), ("mobile", {"width": 390, "height": 844})]:
        page = browser.new_page(viewport=viewport)
        page.on("pageerror", lambda e: errors.append(f"{name}: {e}"))
        page.on("console", lambda m: m.type == "error" and errors.append(f"{name} console: {m.text}"))

        page.goto(f"{BASE}/index.html")
        expect(page.get_by_text("isn’t connected to its database yet")).to_be_visible()
        page.screenshot(path=SHOTS / f"{name}-signin.png", full_page=True)
        page.get_by_role("button", name="Explore the demo").click()

        page.wait_for_url("**/dashboard.html")
        expect(page.get_by_text("Monthly rent roll")).to_be_visible()
        # Seed: occupied 3200+3200+5800+11500 + notice 7900 = 31 600
        expect(page.locator(".kpi").first).to_contain_text("31 600")
        expect(page.locator(".kpi").nth(1)).to_contain_text("71%")
        page.screenshot(path=SHOTS / f"{name}-dashboard.png", full_page=True)

        if name == "desktop":
            page.get_by_role("link", name="Properties & units").click()
            page.wait_for_url("**/properties.html")
            expect(page.locator("#plan-usage")).to_contain_text("7 of 10 units")

            # Add a property
            page.get_by_role("button", name="Add property").first.click()
            page.get_by_label("Property name").fill("Umlazi house")
            page.get_by_label("Street address").fill("45 Mangosuthu Highway")
            page.get_by_label("Suburb or township").fill("Umlazi")
            page.get_by_label("City or town").fill("Durban")
            page.get_by_label("Province").select_option("KZN")
            page.get_by_label("Postal code").fill("40")
            page.locator(".modal [type=submit]").click()
            expect(page.locator(".form-error")).to_contain_text("4 digits")
            page.get_by_label("Postal code").fill("4031")
            page.locator(".modal [type=submit]").click()
            expect(page.locator(".modal")).to_have_count(0)
            card = page.locator("article", has_text="Umlazi house")
            expect(card).to_contain_text("No units yet")

            # Add units until the Growth plan limit (10) is hit
            for i in range(1, 4):
                card.get_by_role("button", name="Unit", exact=True).click()
                page.get_by_label("Unit name").fill(f"Room {i}")
                page.get_by_label("Monthly rent").fill("2800")
                expect(page.get_by_label("Deposit")).to_have_value("2800")
                page.locator(".modal [type=submit]").click()
                expect(page.locator(".modal")).to_have_count(0)
            expect(page.locator("#plan-usage")).to_contain_text("10 of 10 units")

            card.get_by_role("button", name="Unit", exact=True).click()
            page.get_by_label("Unit name").fill("Room 4")
            page.get_by_label("Monthly rent").fill("2800")
            page.locator(".modal [type=submit]").click()
            expect(page.locator(".form-error")).to_contain_text("Growth plan allows 10 units")
            page.get_by_role("button", name="Cancel").click()

            # Duplicate unit name is refused
            card.get_by_role("button", name="Edit Room 2").click()
            page.get_by_label("Unit name").fill("Room 1")
            page.locator(".modal [type=submit]").click()
            expect(page.locator(".form-error")).to_contain_text("already has a unit with that name")
            page.get_by_role("button", name="Cancel").click()

            # Quick status change
            card.get_by_label("Status of Room 1").select_option("occupied")
            expect(page.locator(".toast").last).to_contain_text("Room 1 marked occupied")

            # Filter
            page.get_by_label("Filter by unit status").select_option("vacant")
            expect(page.locator("article")).to_have_count(2)   # Mabaso (Room 3) + Umlazi (Rooms 2, 3)
            page.get_by_label("Filter by unit status").select_option("")
            page.screenshot(path=SHOTS / "desktop-properties.png", full_page=True)

            # Delete a unit, then the whole property
            card.get_by_role("button", name="Delete Room 3").click()
            page.locator(".modal [type=submit]").click()
            expect(card).not_to_contain_text("Room 3")
            card.get_by_role("button", name="Delete Umlazi house").click()
            expect(page.locator(".modal")).to_contain_text("also deletes its 2 units")
            page.locator(".modal [type=submit]").click()
            expect(page.locator("article", has_text="Umlazi house")).to_have_count(0)
            expect(page.locator("#plan-usage")).to_contain_text("7 of 10 units")

            # Data survives a reload (kept in this browser)
            page.reload()
            expect(page.locator("article")).to_have_count(3)
        else:
            page.get_by_role("button", name="Open menu").click()
            expect(page.locator(".sidebar")).to_be_in_viewport()
            page.get_by_role("link", name="Properties & units").click()
            page.wait_for_url("**/properties.html")
            page.get_by_role("button", name="Edit Room 1").first.click()
            page.screenshot(path=SHOTS / "mobile-unit-form.png", full_page=False)
            page.get_by_role("button", name="Cancel").click()
            page.screenshot(path=SHOTS / "mobile-properties.png", full_page=True)
            overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
            assert not overflow, "page scrolls sideways on mobile"
        page.close()
    browser.close()

server.shutdown()
if errors:
    print("Browser errors:\n  " + "\n  ".join(errors)); sys.exit(1)
print("UI smoke test passed")
