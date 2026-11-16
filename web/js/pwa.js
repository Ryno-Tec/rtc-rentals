// Installable app: registers the service worker and offers "Install app".
// Android, Huawei (HarmonyOS/EMUI) and desktop Chromium browsers give an install prompt;
// iPhone and iPad install from Safari's Share menu, so there we show how.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const DISMISS = 'rtc-install-dismissed';
const dismissed = () => { try { return Number(localStorage.getItem(DISMISS) || 0) > Date.now() - 30 * 864e5; } catch { return false; } };

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

function bar(html) {
  if (document.getElementById('install-bar')) return null;
  const el = document.createElement('div');
  el.id = 'install-bar';
  el.className = 'install-bar';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Install the app');
  el.innerHTML = `<div class="install-text">${html}</div><button type="button" class="btn btn-ghost btn-sm" data-x>Not now</button>`;
  el.querySelector('[data-x]').addEventListener('click', () => { try { localStorage.setItem(DISMISS, String(Date.now())); } catch {} el.remove(); });
  document.body.appendChild(el);
  return el;
}

if (!standalone && !dismissed()) {
  let deferred = null;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    const el = bar('<b>Get the RTC Rentals app</b><span>Install it on this phone for one-tap access.</span>');
    if (!el) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = 'Install';
    b.addEventListener('click', async () => { el.remove(); deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; });
    el.insertBefore(b, el.querySelector('[data-x]'));
  });
  addEventListener('appinstalled', () => document.getElementById('install-bar')?.remove());
  if (ios) addEventListener('load', () => setTimeout(() => bar(
    '<b>Get the RTC Rentals app</b><span>In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.</span>'), 1500));
}
