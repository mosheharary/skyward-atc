// Inline SVG icon set (24×24, stroked, currentColor) so the HUD has one consistent visual language.

const P: Record<string, string> = {
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  speed: '<path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="16" cy="15" r="1" fill="currentColor"/>',
  tower: '<path d="M8 21h8M10 21l1-9h2l1 9M7 8h10l-1.5 4h-7zM9 8V5h6v3M12 5V2"/>',
  orbit: '<ellipse cx="12" cy="12" rx="10" ry="4.5"/><circle cx="12" cy="12" r="2.5"/><path d="M19 8.5l2.5-1"/>',
  follow: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  cockpit: '<path d="M3 16c2-6 5-9 9-9s7 3 9 9M3 16h18M9 16l1-4h4l1 4"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6V14"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wind: '<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".6" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/>',
  plane: '<path d="M21 15v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5.5z"/>',
  arrive: '<path d="M3 20h18"/><path d="M4 8l4 1 7 6 4 1-1 1-5-1-3 2-1-1 1-2-5-4z"/>',
  depart: '<path d="M3 20h18"/><path d="M4 16l4-1 6-6 5-1 1 1-3 3-2 5-1 0-.5-3-4 2-5 1z"/>',
  ground: '<rect x="3" y="10" width="18" height="6" rx="1"/><path d="M7 13h2M11 13h2M15 13h2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  exit: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.3 2.5 3.8 5.5"/>',
  career: '<path d="M4 20V10l8-6 8 6v10"/><path d="M9 20v-6h6v6"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  gamepad: '<path d="M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 14h-4l-1 1.6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M7 10v4M5 12h4"/><circle cx="16" cy="11" r=".7" fill="currentColor"/><circle cx="18" cy="13" r=".7" fill="currentColor"/>',
  radio: '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M7 9l10-5"/><circle cx="8" cy="14.5" r="2.5"/><path d="M14 13h4M14 16h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  target: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  trail: '<circle cx="5" cy="18" r="1.3" fill="currentColor"/><circle cx="9" cy="14" r="1.3" fill="currentColor"/><circle cx="13" cy="10.5" r="1.3" fill="currentColor"/><rect x="16" y="4" width="5" height="5"/>',
  vector: '<rect x="3" y="15" width="6" height="6"/><path d="M8 16l12-12M14 4h6v6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.3"/>',
  rings: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="10"/>',
  fix: '<path d="M12 4l8 14H4z"/>',
  runway: '<path d="M9 3l-3 18M15 3l3 18M12 5v2M12 10v2M12 15v2"/>',
  water: '<path d="M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heading: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-7"/><path d="M12 3v2M21 12h-2M12 21v-2M3 12h2"/>',
  altitude: '<path d="M4 20h16M8 20V8l4-4 4 4v12"/><path d="M12 4v16"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  direct: '<circle cx="18" cy="6" r="2.5"/><path d="M4 20L16 8"/>',
  hold: '<rect x="5" y="7" width="14" height="10" rx="5"/><path d="M15 5l2 2-2 2"/>',
  ils: '<path d="M3 20h18M12 20V9"/><path d="M5 20l7-11 7 11"/>',
  land: '<path d="M3 20h18"/><path d="M4 9l4 1 7 6 4 1-1 1-5-1-3 2-1-1 1-2-5-4z"/>',
  goaround: '<path d="M4 17a8 8 0 0 1 14-7l2 2M20 6v6h-6"/>',
  push: '<path d="M12 20V6M7 11l5-5 5 5"/><rect x="8" y="16" width="8" height="4" rx="1"/>',
  taxi: '<path d="M4 18h16M6 18c0-5 3-9 6-9s6 4 6 9"/><circle cx="12" cy="7" r="1.5"/>',
  cross: '<path d="M3 12h18M8 7l-4 5 4 5M16 7l4 5-4 5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  takeoff: '<path d="M3 20h18"/><path d="M4 16l4-1 6-6 5-1 1 1-3 3-2 5-1 0-.5-3-4 2-5 1z"/>',
  handoff: '<path d="M4 12h12M12 7l5 5-5 5M20 5v14"/>',
  emergency: '<path d="M12 3l10 18H2z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".6" fill="currentColor"/>',
  score: '<path d="M6 20V10M12 20V4M18 20v-7"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5"/><path d="M12 8v4l3 2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  logo: '<path d="M12 2l4 10-4 10-4-10z" fill="currentColor" stroke="none" opacity=".9"/><path d="M2 12h20" opacity=".6"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19.5 11 3.5 3.5 0 0 1 18.5 18z"/>',
  thermo: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/>',
  pressure: '<circle cx="12" cy="12" r="9"/><path d="M12 12l-4-4M7 16h10"/>',
  visibility: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><path d="M4 4l16 16"/>',
  // Google "G" mark in its brand colours (for the sign-in button only).
  google: '<g transform="scale(.5)" stroke="none">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></g>',
};

export type IconName = keyof typeof P;

/** Returns a span containing the named icon, sized by the surrounding font size. */
export function icon(name: IconName | string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `ic${cls ? ` ${cls}` : ''}`;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? P.dot}</svg>`;
  return s;
}
