"""Profile photos, tax reports, the tenant's tax-year statement, and the social sign-in buttons.

Run:  python3 tests/ui/features_test.py
"""
import base64, functools, http.server, json, pathlib, threading, sys, re
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = pathlib.Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)
PHOTO = SHOTS / "_face.png"
import struct, zlib
def _png(w=64, h=64, rgb=(196, 71, 26)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
PHOTO.write_bytes(_png())

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

    # ---- Tax report
    page.locator(".nav").get_by_role("link", name="Tax reports").click()
    page.wait_for_url("**/tax.html")
    expect(page.locator(".kpi").first).to_contain_text("Rent received")
    expect(page.locator(".tax-prop", has_text="Mabaso Street rooms")).to_contain_text("Rates and taxes")
    expect(page.locator(".tax-prop", has_text="Wellington Road")).to_contain_text("Bond interest")
    before = page.locator(".kpi").nth(1).inner_text()
    page.get_by_role("button", name="Add an expense").click()
    page.get_by_label("Type").select_option("advertising")
    page.get_by_label("Amount (R)").fill("350")
    page.get_by_label("Details").fill("Property24 listing")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator(".tax-lines")).to_contain_text("Property24 listing")
    assert page.locator(".kpi").nth(1).inner_text() != before
    with page.expect_download() as dl:
        page.get_by_role("button", name="Download CSV").click()
    text = pathlib.Path(dl.value.path()).read_text(encoding="utf-8-sig")
    assert "Property24 listing" in text and "Rent received" in text, text[:300]
    page.screenshot(path=SHOTS / "tax-report.png", full_page=True)
    page.locator("#ty").select_option(index=1)
    expect(page.locator("#ty")).not_to_have_value(str(page.evaluate("new Date().getMonth() >= 2 ? new Date().getFullYear() + 1 : new Date().getFullYear()")))

    # ---- Yearly increase as a fixed rand amount
    page.goto(f"{BASE}/tenants.html")
    card = page.locator("article", has_text="Lerato Nkosi")
    expect(card).to_contain_text("+6% a year")
    card.get_by_role("button", name=re.compile("Edit")).click()
    page.locator("#l-esc-type").select_option("amount")
    expect(page.locator("#l-esc-amount")).to_be_visible()
    expect(page.locator("#l-esc")).to_be_hidden()
    page.locator("#l-esc-amount").fill("250")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(card).to_contain_text("+R 250 a year")
    expect(card).to_contain_text("to R 3 450")       # R 3 200 start + R 250 on the first anniversary
    page.goto(f"{BASE}/leases.html")
    page.locator("article", has_text="Lerato Nkosi").get_by_role("button", name="Create lease").click()
    expect(page.locator("#lf-esct")).to_have_value("amount")
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".lease-doc")).to_contain_text("The rent goes up by R 250 a month on each anniversary")
    page.goto(f"{BASE}/tenant.html#home")
    expect(page.locator("body")).to_contain_text("R 250 a year")

    # ---- Owner sees the tenant's photo; changes their own
    page.goto(f"{BASE}/tenants.html")
    expect(page.locator(".with-avatar img").first).to_be_visible()
    page.locator("#me").click()
    page.locator("#pp-file").set_input_files(str(PHOTO))
    page.locator(".modal [type=submit]").click()
    expect(page.locator(".modal")).to_have_count(0)
    expect(page.locator("#me-avatar img")).to_be_visible()

    # ---- Tenant: photo is required before the app opens
    page.evaluate("""() => { const k = 'rtc-rentals-demo-data-v2'; const s = JSON.parse(localStorage.getItem(k));
      s.tenants[0].photo_path = null; localStorage.setItem(k, JSON.stringify(s)); }""")
    page.goto(f"{BASE}/tenant.html")
    expect(page.locator(".photo-gate")).to_be_visible()
    expect(page.locator("#t-tabs")).to_be_hidden()
    expect(page.locator("#pp-save")).to_be_disabled()
    page.screenshot(path=SHOTS / "photo-gate.png")
    page.locator("#pp-cam").set_input_files(str(PHOTO))
    page.locator("#pp-save").click()
    expect(page.locator(".t-hello")).to_contain_text("Hi Lerato")
    expect(page.locator("#t-me img")).to_be_visible()

    # ---- Tenant tax-year statement
    page.goto(f"{BASE}/tenant.html#payments")
    page.get_by_role("button", name="Tax-year statement").click()
    expect(page.locator(".tax-statement")).to_contain_text("Statement of rent paid")
    expect(page.locator(".tax-statement")).to_contain_text("Total paid in the tax year")
    page.keyboard.press("Escape")

    # ---- Maintenance person: photo required too
    page.evaluate("""() => { const k = 'rtc-rentals-demo-data-v2'; const s = JSON.parse(localStorage.getItem(k));
      (s.staff || []).forEach(m => m.photo_path = null); localStorage.setItem(k, JSON.stringify(s)); }""")
    page.goto(f"{BASE}/staff.html")
    expect(page.locator(".photo-gate")).to_be_visible()
    page.locator("#pp-file").set_input_files(str(PHOTO))
    page.locator("#pp-save").click()
    expect(page.locator(".t-hello")).to_contain_text("Your jobs")
    page.goto(f"{BASE}/maintenance.html#team")
    expect(page.locator(".team-row", has_text="Sipho Ndlovu").locator("img")).to_be_visible()

    # ---- Social sign-in buttons appear only for providers switched on in Supabase
    live = browser.new_page()
    live.on("pageerror", lambda e: errors.append(f"live: {e}"))
    live.route("**/js/config.js", lambda r: r.fulfill(content_type="text/javascript",
        body="export const config = { supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'anon' };"))
    live.route("https://test.supabase.co/auth/v1/settings", lambda r: r.fulfill(content_type="application/json",
        headers={"access-control-allow-origin": "*"}, body=json.dumps({"external": {"google": True, "apple": True, "azure": False}})))
    live.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(content_type="text/javascript",
        body="export function createClient(){ return { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; } } }; }"))
    live.goto(f"{BASE}/index.html")
    expect(live.get_by_role("button", name="Continue with Google")).to_be_visible()
    expect(live.get_by_role("button", name="Continue with Apple")).to_be_visible()
    expect(live.get_by_role("button", name="Continue with Microsoft")).to_have_count(0)
    live.screenshot(path=SHOTS / "signin-social.png")

    # ---- Password reset link: a proper form, not a browser prompt
    reset = browser.new_page()
    reset.on("pageerror", lambda e: errors.append(f"reset: {e}"))
    reset.on("dialog", lambda d: (errors.append("reset: browser dialog shown"), d.dismiss()))
    reset.route("**/js/config.js", lambda r: r.fulfill(content_type="text/javascript",
        body="export const config = { supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'anon' };"))
    reset.route("https://test.supabase.co/auth/v1/settings", lambda r: r.fulfill(content_type="application/json",
        headers={"access-control-allow-origin": "*"}, body=json.dumps({"external": {}})))
    reset.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(content_type="text/javascript", body="""
        window.__pw = null;
        export function createClient(){ return {
          auth: { getSession: async () => ({ data: { session: { user: { email: 'o@x.co', user_metadata: { role: 'landlord' } } } } }),
                  updateUser: async (u) => { window.__pw = u.password; return { error: null }; },
                  onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; } },
          rpc: async () => ({ data: [{ owner: true, tenant: false, side: null }], error: null }) }; }"""))
    reset.route("**/dashboard.html", lambda r: r.fulfill(content_type="text/html", body="<p id=dash>dashboard</p>"))
    reset.goto(f"{BASE}/index.html#access_token=x&type=recovery")
    expect(reset.locator("#title")).to_have_text("Choose a new password")
    reset.locator("#r-pw").fill("abcdefgh1"); reset.locator("#r-pw2").fill("abcdefgh2")
    reset.locator("#r-go").click()
    expect(reset.locator("#r-error")).to_contain_text("don’t match")
    reset.locator("#r-pw2").fill("abcdefgh1")
    reset.screenshot(path=SHOTS / "password-reset.png")
    reset.locator("#r-go").click()
    reset.wait_for_url("**/dashboard.html")
    browser.close()

PHOTO.unlink(missing_ok=True)
if errors:
    print("Browser errors:\n" + "\n".join(errors)); sys.exit(1)
print("Photos, tax reports and social sign-in passed")
