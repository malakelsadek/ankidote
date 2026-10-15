// Colour palettes. Each palette is a set of CSS variables for light and dark mode,
// written into one <style>, so the whole UI recolours with no per-component code.
(() => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

  const hex = (h, s, l) => {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  };
  // h1 = main colour hue, h2 = second colour hue (used for "correct" and charts), k scales the main colour's saturation
  const gen = (h1, h2, k = 1) => {
    const L = h1 > 70 && h1 < 200 ? 40 : 56;   // greens/cyans need to be darker for white text to stay readable
    return {
      light: { bg: hex(h1, 100 * k, 98), fg: hex(h1, 25 * k, 13), mut: hex(h1, 12 * k, 38), line: hex(h1, 45 * k, 89), card: '#ffffff', acc: hex(h1, 62 * k, L), 'acc-d': hex(h1, 55 * k, L - 14), accsoft: hex(h1, 85 * k, 94), onacc: '#ffffff', blue: hex(h2, 65, 55), 'blue-d': hex(h2, 62, 41), bluesoft: hex(h2, 75, 94), bad: '#d6455d', 'bad-d': '#b0334a', badsoft: '#fde3e6' },
      dark: { bg: hex(h1, 18 * k, 9), fg: hex(h1, 35 * k, 94), mut: hex(h1, 10 * k, 72), line: hex(h1, 14 * k, 23), card: hex(h1, 18 * k, 12.5), acc: hex(h1, 75 * k, 72), 'acc-d': hex(h1, 50 * k, 58), accsoft: hex(h1, 28 * k, 18), onacc: hex(h1, 18 * k, 9), blue: hex(h2, 70, 70), 'blue-d': hex(h2, 52, 56), bluesoft: hex(h2, 28, 16), bad: '#ff7a8a', 'bad-d': '#cc5565', badsoft: '#3a2027' },
    };
  };
  const P = {
    bubblegum: { label: 'Bubblegum', light: { bg: '#fff6f9', fg: '#2a1d25', mut: '#6f5d68', line: '#efd3e0', card: '#ffffff', acc: '#d9528c', 'acc-d': '#b03a70', accsoft: '#fde3ee', onacc: '#ffffff', blue: '#4aa3d9', 'blue-d': '#2e86bd', bluesoft: '#e3f2fb', bad: '#d6455d', 'bad-d': '#b0334a', badsoft: '#fde3e6' },
      dark: { bg: '#1a1418', fg: '#f6e9ef', mut: '#bfaab5', line: '#44333d', card: '#241b21', acc: '#f08ab8', 'acc-d': '#c4639a', accsoft: '#3a2230', onacc: '#1a1418', blue: '#7cc0ea', 'blue-d': '#4f9bc8', bluesoft: '#1f2f3a', bad: '#ff7a8a', 'bad-d': '#cc5565', badsoft: '#3a2027' } },
    ocean: { label: 'Ocean', ...gen(215, 160) },
    mint: { label: 'Mint', ...gen(155, 205) },
    lavender: { label: 'Lavender', ...gen(265, 195) },
    sunset: { label: 'Sunset', ...gen(18, 205) },
    teal: { label: 'Teal', ...gen(182, 255) },
    berry: { label: 'Berry', ...gen(315, 170) },
    graphite: { label: 'Graphite', ...gen(225, 200, .22) },
  };

  const pat = (acc, blue, op) => `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220' fill='none' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><g stroke='%23${acc.slice(1)}' stroke-opacity='${op}'><path d='M34 24v18M25 33h18'/><path d='M150 168v18M141 177h18'/><path d='M158 92c-5-9-18-4-13 6l13 12 13-12c5-10-8-15-13-6z'/></g><g stroke='%23${blue.slice(1)}' stroke-opacity='${op}'><path d='M24 130h30l6-15 9 30 7-21 5 6h30'/><rect x='118' y='28' width='34' height='15' rx='7.5' transform='rotate(-35 135 35)'/><path d='M135 35l-5 7' transform='rotate(-35 135 35)'/><circle cx='70' cy='196' r='7'/></g></svg>")`;
  const block = (o, op) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';') + ';--pat:' + pat(o.acc, o.blue, op);

  let cur = 'bubblegum';
  try { const s = localStorage.getItem('palette'); if (P[s]) cur = s; } catch {}
  const el = document.createElement('style');
  document.head.appendChild(el);
  const apply = () => {
    const { light, dark } = P[cur], dk = block(dark, .11);
    el.textContent = `:root{${block(light, .13)}}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${dk}}}:root[data-theme=dark]{${dk}}`;
  };
  apply();

  window.PALETTES = Object.entries(P).map(([id, p]) => ({ id, label: p.label, sw: [p.light.acc, p.light.blue] }));
  window.curPalette = () => cur;
  window.setPalette = id => {
    if (!P[id]) return;
    cur = id; apply();
    try { localStorage.setItem('palette', id); } catch {}
  };
})();
