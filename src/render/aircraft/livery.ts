// Canvas-generated airline liveries: fuselage skin (both sides), fin artwork, registration decals.
import * as THREE from 'three';
import type { Airline, Livery, LogoKind } from '../../sim/airlines';
import type { FuselageModel } from './fuselage';
import type { ShapeDef, WindowRow } from './shapes';
import type { FinInfo } from './wing';

const DEG = Math.PI / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const DEFAULT_LIVERY: Livery = {
  style: 'minimal', body: '#f2f3f5', belly: '#c9cdd3', tail: '#5b6572', tail2: '#aab3bf', accent: '#5b6572',
  engine: '#d6d9de', text: '#3b4450', logo: 'ring', logoColor: '#ffffff',
};

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return [c, g];
}

function toTexture(c: HTMLCanvasElement, maxAniso: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// --------------------------------------------------------------------- logos

/** Draw a logo centred at (0,0) with radius 1 (caller sets the transform). */
export function drawLogo(g: CanvasRenderingContext2D, kind: LogoKind, color: string, color2: string): void {
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (kind) {
    case 'wave':
      g.lineWidth = 0.17;
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        const yy = -0.45 + k * 0.45;
        for (let i = 0; i <= 40; i++) {
          const x = -0.9 + (1.8 * i) / 40;
          const y = yy + Math.sin(x * 3.4 + k * 0.7) * 0.16;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.globalAlpha = 1 - k * 0.22;
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    case 'compass': {
      g.lineWidth = 0.08;
      g.beginPath();
      g.arc(0, 0, 0.72, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        const r = i % 2 === 0 ? 1 : 0.22;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      break;
    }
    case 'leaf':
      g.beginPath();
      g.moveTo(0, -1);
      g.bezierCurveTo(0.85, -0.55, 0.75, 0.45, 0, 0.9);
      g.bezierCurveTo(-0.75, 0.45, -0.85, -0.55, 0, -1);
      g.fill();
      g.strokeStyle = color2;
      g.lineWidth = 0.07;
      g.beginPath();
      g.moveTo(0, -0.75);
      g.lineTo(0, 0.95);
      for (let i = 0; i < 3; i++) {
        const y = -0.35 + i * 0.35;
        g.moveTo(0, y + 0.1);
        g.lineTo(0.38, y - 0.18);
        g.moveTo(0, y + 0.1);
        g.lineTo(-0.38, y - 0.18);
      }
      g.stroke();
      break;
    case 'star':
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const r = i % 2 === 0 ? 1 : 0.42;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      break;
    case 'sun':
      g.beginPath();
      g.arc(0, 0, 0.48, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 0.11;
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        g.beginPath();
        g.moveTo(Math.cos(a) * 0.62, Math.sin(a) * 0.62);
        g.lineTo(Math.cos(a) * 0.98, Math.sin(a) * 0.98);
        g.stroke();
      }
      break;
    case 'chevron':
      for (let k = 0; k < 2; k++) {
        const o = k * 0.62 - 0.45;
        g.beginPath();
        g.moveTo(-0.8, o - 0.35);
        g.lineTo(0, o + 0.25);
        g.lineTo(0.8, o - 0.35);
        g.lineTo(0.8, o - 0.02);
        g.lineTo(0, o + 0.58);
        g.lineTo(-0.8, o - 0.02);
        g.closePath();
        g.fill();
      }
      break;
    case 'bird':
      g.beginPath();
      g.moveTo(-1, -0.1);
      g.quadraticCurveTo(-0.5, -0.65, 0, 0.12);
      g.quadraticCurveTo(0.5, -0.65, 1, -0.1);
      g.quadraticCurveTo(0.5, -0.35, 0, 0.45);
      g.quadraticCurveTo(-0.5, -0.35, -1, -0.1);
      g.fill();
      break;
    case 'aurora':
      for (let k = 0; k < 4; k++) {
        g.globalAlpha = 0.55 + k * 0.15;
        g.beginPath();
        const x0 = -0.8 + k * 0.42;
        g.moveTo(x0, 0.9);
        g.bezierCurveTo(x0 - 0.3, 0.3, x0 + 0.35, -0.3, x0 + 0.05, -0.95);
        g.lineTo(x0 + 0.2, -0.95);
        g.bezierCurveTo(x0 + 0.5, -0.3, x0 - 0.15, 0.3, x0 + 0.15, 0.9);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
      break;
    case 'diamond':
      g.lineWidth = 0.1;
      g.beginPath();
      g.moveTo(0, -1);
      g.lineTo(0.7, 0);
      g.lineTo(0, 1);
      g.lineTo(-0.7, 0);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(0, -0.55);
      g.lineTo(0.38, 0);
      g.lineTo(0, 0.55);
      g.lineTo(-0.38, 0);
      g.closePath();
      g.fill();
      break;
    case 'bolt':
      g.beginPath();
      g.moveTo(0.25, -1);
      g.lineTo(-0.55, 0.12);
      g.lineTo(-0.02, 0.12);
      g.lineTo(-0.3, 1);
      g.lineTo(0.6, -0.2);
      g.lineTo(0.05, -0.2);
      g.lineTo(0.4, -1);
      g.closePath();
      g.fill();
      break;
    case 'ring':
      g.lineWidth = 0.2;
      g.beginPath();
      g.arc(0, 0, 0.75, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(0.2, -0.2, 0.22, 0, Math.PI * 2);
      g.fill();
      break;
    case 'arc':
      g.lineWidth = 0.16;
      for (let k = 0; k < 3; k++) {
        g.globalAlpha = 1 - k * 0.2;
        g.beginPath();
        g.arc(0, 0.55, 0.95 - k * 0.3, Math.PI * 1.05, Math.PI * 1.95);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
  }
}

// ----------------------------------------------------------------- fuselage

const LIVERY_W = 2048;
const LIVERY_HH = 256;

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** Text in metres (font sizes in canvas px break under large transforms, so scale down). */
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, h: number, maxW: number, font: string, color: string): void {
  g.save();
  g.translate(x, y);
  const k = 100;
  g.scale(1 / k, 1 / k);
  g.font = `${font} ${Math.round(h * k)}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(s).width / k;
  if (w > maxW) g.scale(maxW / w, 1);
  g.fillStyle = color;
  g.fillText(s, 0, 0);
  g.restore();
}

/**
 * Fuselage livery texture. Layout (see buildFuselageSkin): the top half of the canvas is the right side
 * (crown at the top, nose at the right), the bottom half is the left side (crown at the bottom, nose at the left).
 */
export function makeFuselageTexture(airline: Airline | undefined, shape: ShapeDef, fm: FuselageModel, maxAniso: number): THREE.CanvasTexture {
  const liv = airline?.livery ?? DEFAULT_LIVERY;
  const [c, g] = makeCanvas(LIVERY_W, LIVERY_HH * 2);
  const L = fm.L;
  const arc = fm.arc;
  const arcR = fm.arcR;
  const Y = (thetaDeg: number) => (90 - thetaDeg) * DEG * arcR;
  const D = fm.R * 2;
  const main = shape.windows.find((w) => w.deck === 'main') as WindowRow;
  const upper = shape.windows.find((w) => w.deck === 'upper');
  const yWin = Y(main.theta);
  const f = fm.f;

  for (const right of [true, false]) {
    g.save();
    if (right) g.setTransform(LIVERY_W / L, 0, 0, LIVERY_HH / arc, 0, 0);
    else g.setTransform(LIVERY_W / L, 0, 0, -LIVERY_HH / arc, 0, LIVERY_HH * 2);
    const X = (d: number) => (right ? L - d : d);
    // Everything is drawn over x in [0, L]; paths use X(d) for asymmetric features.
    const band = (y0: number, y1: number, color: string, d0 = 0, d1 = L) => {
      g.fillStyle = color;
      const a = X(d0);
      const b = X(d1);
      g.fillRect(Math.min(a, b), y0, Math.abs(b - a), y1 - y0);
    };
    const poly = (pts: [number, number][], color: string) => {
      g.fillStyle = color;
      g.beginPath();
      pts.forEach(([d, y], i) => (i === 0 ? g.moveTo(X(d), y) : g.lineTo(X(d), y)));
      g.closePath();
      g.fill();
    };

    band(0, arc, liv.body);
    const rear = L - f.tailLen;
    switch (liv.style) {
      case 'classic':
        band(Y(-24), arc, liv.belly);
        band(yWin + main.h * 0.5 + 0.1, yWin + main.h * 0.5 + 0.1 + D * 0.05, liv.accent, f.ntLen * 0.45, L - f.tailLen * 0.35);
        band(yWin + main.h * 0.5 + 0.12 + D * 0.065, yWin + main.h * 0.5 + 0.12 + D * 0.08, liv.tail2 === '#ffffff' ? liv.accent : liv.tail2, f.ntLen * 0.5, L - f.tailLen * 0.4);
        break;
      case 'retro':
        band(Y(-18), arc, liv.belly);
        band(yWin - main.h * 1.0, yWin + main.h * 0.95, liv.accent, f.ntLen * 0.2, L - f.tailLen * 0.2);
        band(yWin + main.h * 1.1, yWin + main.h * 1.3, liv.tail, f.ntLen * 0.25, L - f.tailLen * 0.25);
        break;
      case 'bold': {
        const yb = Y(-6);
        band(yb, arc, liv.belly);
        band(yb - D * 0.06, yb - D * 0.02, liv.accent);
        poly([[rear - f.tailLen * 0.6, arc], [rear - f.tailLen * 0.35, yb], [rear + f.tailLen * 0.25, Y(40)], [L + 1, Y(75)], [L + 1, arc]], liv.tail);
        poly([[rear - f.tailLen * 0.2, arc], [rear + f.tailLen * 0.05, yb + D * 0.1], [rear + f.tailLen * 0.45, Y(30)], [L + 1, Y(55)], [L + 1, arc]], liv.tail2);
        break;
      }
      case 'modern': {
        if (liv.belly !== liv.body) band(Y(-20), arc, liv.belly);
        const s0 = L * 0.42;
        poly([[s0, arc], [s0 + (rear - s0) * 0.55, Y(-38)], [rear + f.tailLen * 0.2, Y(12)], [L + 1, Y(40)], [L + 1, arc]], liv.tail);
        poly([[s0 + L * 0.1, arc], [s0 + (rear - s0) * 0.75, Y(-50)], [rear + f.tailLen * 0.3, Y(-8)], [L + 1, Y(18)], [L + 1, arc]], liv.tail2);
        band(Y(-60), Y(-57), liv.accent, f.ntLen * 0.5, s0 + 1);
        break;
      }
      case 'cargo':
        band(Y(-32), arc, liv.belly);
        poly([[L * 0.55, Y(-32)], [L * 0.62, Y(-32)], [rear + 2, Y(20)], [rear, Y(20)]], liv.accent);
        poly([[L * 0.63, Y(-32)], [L * 0.66, Y(-32)], [rear + 3.4, Y(20)], [rear + 2.6, Y(20)]], liv.tail);
        break;
      case 'minimal':
      default:
        if (liv.belly !== liv.body) band(Y(-30), arc, liv.belly);
        band(Y(-40), Y(-38.5), liv.tail, f.ntLen * 0.5, L - f.tailLen * 0.5);
        break;
    }

    // Door outlines and handles.
    g.lineWidth = 0.035;
    for (const dr of shape.doors) {
      const row = dr.deck === 'upper' && upper ? upper : main;
      const yw = Y(row.theta);
      let yc: number;
      if (dr.kind === 'cargo') yc = Y(-48);
      else if (dr.kind === 'exit') yc = yw;
      else yc = yw - row.h / 2 - 0.22 + dr.h / 2;
      g.strokeStyle = 'rgba(40,45,52,0.55)';
      roundRect(g, X(dr.s) - dr.w / 2, yc - dr.h / 2, dr.w, dr.h, dr.kind === 'cargo' ? 0.12 : 0.18);
      g.stroke();
      if (dr.kind === 'door') {
        g.fillStyle = 'rgba(40,45,52,0.45)';
        g.fillRect(X(dr.s) - 0.1, yc - 0.04, 0.2, 0.08);
      }
    }

    // Cockpit windows.
    const cw = shape.cockpit;
    const d0 = f.ntLen * (cw === 'bizjet' ? 0.3 : 0.25);
    const d1 = f.ntLen * (cw === 'b747' ? 0.4 : cw === 'a380' ? 0.42 : 0.5);
    const top0 = Y(cw === 'b747' ? 46 : 58);
    const top1 = Y(cw === 'b747' ? 42 : 46);
    const bot0 = Y(cw === 'a350' ? 22 : 26);
    const bot1 = Y(cw === 'a350' ? 24 : 30);
    const frame = liv.body;
    g.fillStyle = '#10141a';
    g.beginPath();
    g.moveTo(X(d0), top0);
    g.lineTo(X(d1), top1);
    g.lineTo(X(d1 + (cw === 'b787' ? 0.2 : 0)), bot1);
    g.lineTo(X(d0 - 0.15), bot0);
    g.closePath();
    g.fill();
    // Window frames.
    g.strokeStyle = frame;
    g.lineWidth = D * 0.018;
    const panes = cw === 'b787' || cw === 'bizjet' ? 2 : cw === 'atr' ? 3 : 3;
    for (let i = 1; i < panes; i++) {
      const t = i / panes;
      g.beginPath();
      g.moveTo(X(d0 + (d1 - d0) * t), top0 + (top1 - top0) * t - 0.05);
      g.lineTo(X(d0 - 0.15 + (d1 - d0 + 0.15) * t), bot0 + (bot1 - bot0) * t + 0.05);
      g.stroke();
    }

    // Titles.
    const titleRow = upper && upper.from < L * 0.3 && upper.to > L * 0.5 ? upper : main;
    const th = Math.min(D * (liv.style === 'cargo' || liv.style === 'bold' ? 0.24 : 0.18), 1.6);
    const ty = Y(titleRow.theta) - titleRow.h / 2 - 0.1 - th * 0.55;
    const name = airline ? (liv.style === 'bold' || liv.style === 'cargo' ? airline.name.toUpperCase() : airline.name) : '';
    if (name) {
      const tc = liv.style === 'cargo' ? L * 0.46 : L * 0.36;
      const font = liv.style === 'modern' ? 'italic 700' : liv.style === 'retro' ? '600' : '800';
      text(g, name, X(tc), ty, th, L * (liv.style === 'cargo' ? 0.5 : 0.36), font, liv.text);
      // Small logo ahead of the titles for some styles.
      if (liv.style === 'classic' || liv.style === 'minimal' || liv.style === 'retro') {
        g.save();
        g.translate(X(f.ntLen * 0.95), ty);
        g.scale(th * 0.55, th * 0.55);
        drawLogo(g, liv.logo, liv.tail, liv.tail2);
        g.restore();
      }
    }
    g.restore();
  }
  // Subtle panel lines (horizontal scan noise) for surface detail.
  g.globalAlpha = 0.05;
  g.fillStyle = '#000';
  for (let i = 0; i < 26; i++) {
    const x = (i / 26) * LIVERY_W;
    g.fillRect(x, 0, 1, LIVERY_HH * 2);
  }
  g.globalAlpha = 1;
  return toTexture(c, maxAniso);
}

// ---------------------------------------------------------------------- fin

export function makeFinTexture(airline: Airline | undefined, fin: FinInfo, maxAniso: number): THREE.CanvasTexture {
  const liv = airline?.livery ?? DEFAULT_LIVERY;
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  const U = (z: number) => ((z - fin.zMin) / (fin.zMax - fin.zMin)) * S;
  const V = (y: number) => (1 - (y - fin.yMin) / (fin.yMax - fin.yMin)) * S;
  g.fillStyle = liv.tail;
  g.fillRect(0, 0, S, S);
  switch (liv.style) {
    case 'modern': {
      const gr = g.createLinearGradient(0, S, S * 0.6, 0);
      gr.addColorStop(0, liv.tail);
      gr.addColorStop(0.55, liv.tail);
      gr.addColorStop(1, liv.tail2);
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      break;
    }
    case 'classic':
      g.fillStyle = liv.tail2;
      g.fillRect(0, S * 0.1, S, S * 0.04);
      g.fillRect(0, S * 0.9, S, S * 0.03);
      break;
    case 'bold':
      g.fillStyle = liv.tail2;
      g.beginPath();
      g.moveTo(0, S);
      g.lineTo(S, S * 0.25);
      g.lineTo(S, S);
      g.closePath();
      g.fill();
      break;
    case 'retro':
      g.fillStyle = liv.accent;
      for (let i = 0; i < 3; i++) g.fillRect(0, S * (0.06 + i * 0.06), S, S * 0.025);
      break;
    case 'cargo':
      g.fillStyle = liv.tail2;
      g.beginPath();
      g.moveTo(0, S * 0.8);
      g.lineTo(S, S * 0.45);
      g.lineTo(S, S * 0.55);
      g.lineTo(0, S * 0.9);
      g.closePath();
      g.fill();
      break;
    default:
      break;
  }
  // Logo at the fin's visual centre.
  const o = fin.outline;
  const cz = (o[0][0] + o[1][0] + o[2][0] + o[3][0]) / 4;
  const cy = fin.yMin + (fin.yMax - fin.yMin) * 0.5;
  const chordMid = (o[3][0] - o[0][0] + (o[2][0] - o[1][0])) / 2;
  const rM = Math.min(chordMid * 0.33, (fin.yMax - fin.yMin) * 0.28);
  const r = (rM / (fin.zMax - fin.zMin)) * S;
  const rv = (rM / (fin.yMax - fin.yMin)) * S;
  g.save();
  g.translate(U(cz), V(cy));
  g.scale(r, rv);
  drawLogo(g, liv.logo, liv.logoColor, liv.tail);
  g.restore();
  return toTexture(c, maxAniso);
}

// ------------------------------------------------------------- registration

export function makeRegistrationTexture(reg: string, aspect: number, dark: boolean): THREE.CanvasTexture {
  const W = 512;
  const H = Math.max(32, Math.round(W / aspect));
  const [c, g] = makeCanvas(W, H);
  g.clearRect(0, 0, W, H);
  g.fillStyle = dark ? '#1c2026' : '#f4f4f4';
  g.font = `600 ${Math.round(H * 0.82)}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(reg).width;
  g.save();
  g.translate(W / 2, H / 2);
  if (w > W * 0.96) g.scale((W * 0.96) / w, 1);
  g.fillText(reg, 0, 0);
  g.restore();
  const t = toTexture(c, 4);
  return t;
}

// ----------------------------------------------------------------- misc maps

/** Cabin window alpha/emissive tile: white rounded window on black, one per UV unit horizontally. */
export function makeWindowTile(wFrac: number, hFrac: number): THREE.CanvasTexture {
  const W = 64;
  const H = 64;
  const [c, g] = makeCanvas(W, H);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  const w = W * wFrac;
  const h = H * hFrac;
  roundRect(g, (W - w) / 2, (H - h) / 2, w, h, Math.min(w, h) * 0.45);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Soft radial glow (white centre -> transparent). */
export function makeGlowTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, g] = makeCanvas(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** Horizontal grey-level gradient by u (for alphaMap use, e.g. prop discs). */
export function makeGradientTexture(stops: [number, number][]): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 4);
  const gr = g.createLinearGradient(0, 0, 256, 0);
  for (const [p, a] of stops) {
    const l = Math.round(clamp01(a) * 255);
    gr.addColorStop(p, `rgb(${l},${l},${l})`);
  }
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
