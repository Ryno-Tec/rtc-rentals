"""Demo-mode browser test for the lease and inspection flows, owner and tenant.

Run:  python3 tests/ui/docs_test.py
Owner builds a lease, sends it and signs it with a witness on the same phone; the tenant signs
in their app. Owner starts a move-in inspection with a photo and confirms; the tenant changes an
item (which clears the owner's confirmation), confirms, and the owner confirms again to lock it.
"""
import base64, functools, http.server, pathlib, threading, sys
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)
PHOTO = SHOTS / "_test-photo.png"
# 2x2 orange PNG
PHOTO.write_bytes(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4/58BCBgY/oMBAwMDAwMA4ScJ/k2YwYYAAAAASUVORK5CYII="))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT / "web")))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"


def draw(page, pad="#sg-pad"):
    box = page.locator(f"{pad} canvas").bounding_box()
    page.mouse.move(box["x"] + 20, box["y"] + 30)
    page.mouse.down()
    for x, y in [(60, 60), (100, 20), (140, 70), (190, 30)]:
        page.mouse.move(box["x"] + x, box["y"] + y, steps=4)
    page.mouse.up()


def sign(page, name=None):
    if name:
        page.locator("#sg-name").fill(name)
    draw(page)
    page.locator(".modal [name=agree]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)


errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("dialog", lambda d: d.accept())

    page.goto(f"{BASE}/index.html")
    page.get_by_role("button", name="Explore the demo").click()
    page.wait_for_url("**/dashboard.html")

    # ---- Lease: build, send, owner signs, witness signs on the owner's phone
    page.get_by_role("link", name="Lease signing").click()
    page.wait_for_url("**/leases.html")
    card = page.locator("article", has_text="Lerato Nkosi")
    card.get_by_role("button", name="Create lease").click()
    page.get_by_label("Witnesses").select_option("1")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".doc-bar")).to_contain_text("Draft")
    expect(page.locator("body")).to_contain_text("Deposit")
    page.screenshot(path=SHOTS / "lease-draft.png", full_page=True)

    page.get_by_role("button", name="Send for signing").first.click()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".doc-bar")).to_contain_text("Out for signing")
    page.get_by_role("button", name="Sign the lease").first.click()
    sign(page)
    page.get_by_role("button", name="My witness signs here").first.click()
    sign(page, "Sipho Dlamini")
    expect(page.locator(".notice")).to_contain_text("the tenant")

    # Witness link for the tenant side is made by the tenant; check the owner can't get a second slot
    expect(page.get_by_role("button", name="My witness signs here")).to_have_count(0)

    # ---- Tenant signs and adds a witness through a link
    page.goto(f"{BASE}/tenant.html#lease")
    expect(page.locator(".t-hello")).to_contain_text("Out for signing")
    page.get_by_role("button", name="Sign the lease").first.click()
    sign(page)
    page.get_by_role("button", name="Send my witness a link").first.click()
    link = page.locator("#w-link").input_value()
    assert "witness.html?t=" in link, link
    page.keyboard.press("Escape")

    page.goto(link)
    expect(page.locator("body")).to_contain_text("Lerato Nkosi")
    page.locator("#w-name").fill("Thandi Mokoena")
    draw(page, "#w-pad")
    page.locator("#w-form [name=agree]").check()
    page.get_by_role("button", name="Sign as witness").click()
    expect(page.locator("body")).to_contain_text("Thank you")
    page.goto(link)
    expect(page.locator("body")).to_contain_text("can’t be used any more")  # one-time use

    page.goto(f"{BASE}/tenant.html#lease")
    expect(page.locator(".t-hello")).to_contain_text("Signed")
    page.screenshot(path=SHOTS / "lease-signed-tenant.png", full_page=True)

    # ---- Inspection: owner starts and confirms, with a photo
    page.goto(f"{BASE}/inspections.html")
    page.locator("article", has_text="Lerato Nkosi").get_by_role("button", name="New inspection").click()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".insp-head")).to_contain_text("Move-in inspection")
    for b in page.get_by_role("button", name="Mark the rest Good").all():
        pass
    while page.get_by_role("button", name="Mark the rest Good").count():
        page.get_by_role("button", name="Mark the rest Good").first.click()
        page.wait_for_timeout(150)
    first = page.locator(".insp-item").first
    first.locator("[data-cond=fair]").click()
    first.locator(".insp-mynote").fill("Scuff by the handle")
    first.locator(".insp-mynote").blur()
    first.locator("[data-addphoto]").set_input_files(str(PHOTO))
    expect(page.locator(".insp-item").first.locator(".thumb")).to_have_count(1)
    page.get_by_role("button", name="Confirm this inspection").click()
    page.locator(".modal [name=agree]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".insp-pills")).to_contain_text("Landlord: Thabo")
    page.screenshot(path=SHOTS / "inspection-owner.png", full_page=True)

    # ---- Tenant disagrees on one item: owner's confirmation is cleared
    page.goto(f"{BASE}/tenant.html#inspection")
    expect(page.locator(".badge").first).to_contain_text("Needs your confirmation")
    page.locator(".insp-row").first.click()
    expect(page.locator(".insp-item").first).to_contain_text("Scuff by the handle")
    page.locator(".insp-item").nth(1).locator("[data-cond=poor]").click()
    expect(page.locator(".insp-pills")).to_contain_text("Landlord: not confirmed yet")
    page.get_by_role("button", name="Confirm this inspection").click()
    page.locator(".modal [name=agree]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".insp-pills")).to_contain_text("Tenant: Lerato")

    # ---- Owner confirms again: locked
    page.goto(f"{BASE}/inspections.html")
    expect(page.locator("body")).to_contain_text("Needs your confirmation")
    page.locator(".insp-row").first.click()
    page.get_by_role("button", name="Confirm this inspection").click()
    page.locator(".modal [name=agree]").check()
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".insp-next")).to_contain_text("permanent record")
    expect(page.locator("[data-cond]:not([disabled])")).to_have_count(0)
    page.screenshot(path=SHOTS / "inspection-locked.png", full_page=True)

    # Mobile view of the tenant inspection
    m = browser.new_page(viewport={"width": 390, "height": 844})
    m.on("pageerror", lambda e: errors.append(f"mobile: {e}"))
    m.goto(f"{BASE}/index.html")
    m.get_by_role("button", name="Explore the demo").click()
    m.wait_for_url("**/dashboard.html")
    m.goto(f"{BASE}/tenant.html#inspection")
    m.screenshot(path=SHOTS / "mobile-tenant-inspection.png", full_page=True)
    browser.close()

PHOTO.unlink(missing_ok=True)
if errors:
    print("Browser errors:\n" + "\n".join(errors))
    sys.exit(1)
print("Lease and inspection flows passed")
