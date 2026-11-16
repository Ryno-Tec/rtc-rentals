"""Demo-mode browser test for maintenance: tenant logs a fault, owner sees it per property and
assigns it, the maintenance person works it in their own app, the tenant follows progress.
Also adds a team member, makes a login link, and writes an employment contract.

Run:  python3 tests/ui/maintenance_test.py
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
BASE = f"http://127.0.0.1:{server.server_port}"

errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    page.goto(f"{BASE}/index.html")
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")

    # ---- Tenant logs a fault
    page.goto(f"{BASE}/tenant.html#repairs")
    page.get_by_role("button", name="Report a problem").click()
    page.locator(".modal input, .modal textarea").first.fill("Bathroom light not working")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("body")).to_contain_text("Bathroom light not working")

    # ---- Owner sees faults per property and assigns it
    page.goto(f"{BASE}/maintenance.html")
    expect(page.locator(".nav").get_by_role("link", name="Maintenance")).to_be_visible()
    expect(page.locator(".prop", has_text="Mabaso Street rooms")).to_contain_text("Bathroom light not working")
    expect(page.locator(".prop", has_text="Wellington Road")).to_contain_text("Geyser burst")
    expect(page.locator(".kpi").nth(1)).to_contain_text("1")  # the new one is not assigned
    page.screenshot(path=SHOTS / "maintenance-owner.png", full_page=True)
    page.locator("#f-prop").select_option(label="Wellington Road townhouses")
    expect(page.locator(".fault-row")).to_have_count(1)
    page.locator("#f-prop").select_option(value="")

    page.locator(".fault-row", has_text="Bathroom light").click()
    page.get_by_label("Assigned to").select_option(label="Sipho Ndlovu (Handyman)")
    page.get_by_label("Booked for").fill("2026-11-20")
    page.locator("#mf-note").fill("Sipho will come on Friday morning")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    row = page.locator(".fault-row", has_text="Bathroom light")
    expect(row).to_contain_text("Sipho Ndlovu")
    expect(row).to_contain_text("Booked")

    # ---- Team: add a person, login link, contract
    page.get_by_role("tab", name="Team").click()
    page.get_by_role("button", name="Add a person").click()
    page.get_by_label("Name or company").fill("Nomsa Khumalo")
    page.get_by_label("Trade").fill("Caretaker")
    page.get_by_label("Phone").fill("082 111 2222")
    page.locator(".modal [name=is_employee]").check()
    page.locator(".modal [type=submit]").click()
    member = page.locator(".team-row", has_text="Nomsa Khumalo")
    expect(member).to_contain_text("Employed by you")
    member.get_by_role("button", name="Give a login").click()
    expect(page.locator("#st-link")).to_have_value(__import__("re").compile(r"staff\.html\?t="))
    page.get_by_role("button", name="Done").click()
    expect(member).to_contain_text("Invited")
    member.get_by_role("link", name="Contract").click()
    page.get_by_role("button", name="Fill in the details").click()
    page.get_by_label("Start date").fill("2026-12-01")
    page.locator("#cf-wage").fill("6500")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".lease-doc")).to_contain_text("Contract of employment")
    expect(page.locator(".lease-doc")).to_contain_text("R 6 500 every month")
    expect(page.locator(".lease-doc")).to_contain_text("Nomsa Khumalo")
    page.screenshot(path=SHOTS / "staff-contract.png", full_page=True)

    # ---- The maintenance person's app
    page.goto(f"{BASE}/staff.html")
    job = page.locator(".job", has_text="Bathroom light not working")
    expect(job).to_contain_text("Booked for")
    expect(job).to_contain_text("Lerato Nkosi")
    expect(job.get_by_role("link", name="Call").first).to_have_attribute("href", __import__("re").compile(r"^tel:"))
    job.get_by_role("button", name="Start the work").click()
    page.locator(".modal [type=submit]").click()
    expect(job).to_contain_text("In progress")
    job.get_by_role("button", name="Mark it fixed").click()
    page.locator("#ju-note").fill("Replaced the bulb holder")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".job", has_text="Bathroom light")).to_have_count(0)  # moved to Done
    page.get_by_role("link", name="Done").click()
    expect(page.locator(".job", has_text="Bathroom light")).to_contain_text("Fixed")
    page.screenshot(path=SHOTS / "staff-app.png", full_page=True)

    # ---- Tenant sees who and the progress
    page.goto(f"{BASE}/tenant.html#repairs")
    card = page.locator(".req", has_text="Bathroom light not working")
    expect(card).to_contain_text("Fixed")
    expect(card).to_contain_text("Replaced the bulb holder")
    expect(card).to_contain_text("Sipho Ndlovu")

    # ---- Mobile: staff app
    mob = browser.new_page(viewport={"width": 390, "height": 844})
    mob.on("pageerror", lambda e: errors.append(f"mobile: {e}"))
    mob.goto(f"{BASE}/index.html")
    mob.get_by_role("button", name="Explore the demo").click()
    mob.wait_for_url("**/dashboard.html")
    mob.goto(f"{BASE}/maintenance.html")
    mob.wait_for_selector(".fault-row")
    mob.screenshot(path=SHOTS / "mobile-maintenance.png", full_page=True)
    mob.goto(f"{BASE}/staff.html")
    mob.wait_for_selector(".job")
    mob.screenshot(path=SHOTS / "mobile-staff.png", full_page=True)
    browser.close()

if errors:
    print("Browser errors:\n" + "\n".join(errors))
    sys.exit(1)
print("Maintenance flows passed")
