// A signature box: draw with a finger, stylus or mouse. Returns a PNG data URL.
export function signPad(host) {
  host.innerHTML = `
    <div class="signpad"><canvas aria-label="Draw your signature here" role="img"></canvas>
      <span class="signpad-hint">Sign here</span>
      <button type="button" class="btn btn-ghost btn-sm signpad-clear">Clear</button></div>`;
  const canvas = host.querySelector('canvas'), hint = host.querySelector('.signpad-hint');
  const ctx = canvas.getContext('2d');
  let drawing = false, strokes = 0, length = 0, last = null;

  function size() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 150;
    canvas.width = w * ratio; canvas.height = h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14213d';
    strokes = 0; length = 0; hint.classList.remove('hidden');
  }
  const at = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); canvas.setPointerCapture?.(e.pointerId);
    drawing = true; last = at(e); strokes++; hint.classList.add('hidden');
    ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    e.preventDefault();
    const p = at(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    length += Math.hypot(p.x - last.x, p.y - last.y); last = p;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
  host.querySelector('.signpad-clear').addEventListener('click', size);
  requestAnimationFrame(size);

  return {
    isEmpty: () => length < 40,                 // a dot or a tiny tick isn't a signature
    clear: size,
    // Trimmed to a fixed, modest size so it stores small and prints the same everywhere.
    toDataURL() {
      const out = document.createElement('canvas');
      out.width = 480; out.height = Math.round(480 * canvas.height / canvas.width);
      out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    },
  };
}
