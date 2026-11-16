"""Agency (demo): owners with a fee, property linked to an owner, owner statement and payout, team member invite.

Run:  python3 tests/ui/agency_test.py
"""
import functools, http.server, pathlib, threading, sys
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(__file__).parent / "screenshots"; SHOTS.mkdir(exist_ok=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT / "web")))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://localhost:{server.server_port}"
errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(f"{BASE}/index.html")
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")
    page.locator(".lock-offer [data-x]").click()

    page.locator(".nav").get_by_role("link", name="Agency: owners & team").click()
    page.wait_for_url("**/agency.html")
    page.get_by_role("button", name="Add owner").first.click()
    page.get_by_label("Owner’s name").fill("Mr M Dlamini")
    page.get_by_label("Management fee (% of rent received)").fill("10")
    page.get_by_label("Pay out to").fill("FNB 62001234567")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal .form-error")).to_contain_text("account numbers")
    page.get_by_label("Pay out to").fill("FNB …4567")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".t-table")).to_contain_text("Mr M Dlamini")

    # Link the owner to the first property
    page.goto(f"{BASE}/properties.html")
    page.locator(".prop", has_text="Mabaso Street rooms").locator("[data-action=edit-property]").click()
    page.get_by_label("Owner").select_option(label="Mr M Dlamini")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".prop", has_text="Mabaso Street rooms")).to_contain_text("Owner: Mr M Dlamini")

    # Statement for a month with rent received (the demo has rent paid each month)
    page.goto(f"{BASE}/agency.html#statements")
    expect(page.locator("#statement")).to_contain_text("Owner statement")
    expect(page.locator("#statement")).to_contain_text("Management fee (10%)")
    expect(page.locator("#statement")).to_contain_text("Rent:")
    rent = page.locator(".statement-sum div", has_text="Rent received").locator("dd").inner_text()
    assert rent != "R 0,00", rent
    page.locator("[data-action=payout]").click()
    page.get_by_label("EFT reference").fill("OWNER NOV")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#statement")).to_contain_text("OWNER NOV")
    page.screenshot(path=str(SHOTS / "agency-statement.png"), full_page=True)

    # Team: add an agent, get an invite link
    page.goto(f"{BASE}/agency.html#team")
    page.get_by_role("button", name="Add person").click()
    page.get_by_label("Name").fill("Bongani M")
    page.get_by_label("Work email").fill("bongani@agency.co.za")
    page.locator(".modal [type=submit]").click()
    expect(page.locator("#inv-link")).to_have_value(__import__("re").compile(r"member\.html\?t="))
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".t-table")).to_contain_text("Bongani M")

    page.goto(f"{BASE}/help.html")
    expect(page.locator("#agencies")).to_contain_text("Give each agent their own login")
    browser.close()
server.shutdown()
if errors:
    print("Console errors:", *errors, sep="\n  "); sys.exit(1)
print("Agency tests passed")
