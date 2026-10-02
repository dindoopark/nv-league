// 순위 탭의 3D 카드 팩과 카드 넘기기(three.js). app.js가 순위 탭을 처음 열 때만 불러온다.
// 캔버스 그림은 꾸밈이다(aria-hidden). 같은 내용은 app.js가 글자(DOM)로 따로 보여 준다.
//
// mountCards3D(container, options) → Promise<controller>
//   options.model    { rows, perTeam, fixtures: Map(팀 번호 → 주차별 일정 9줄), currentWeek }
//   options.metaFor  팀 이름 → { logo, accent, base } | null  (null이면 번호 배지)
//   options.sealed   true면 봉인된 팩부터(처음 온 사람), false면 카드가 바로 깔린다
//   options.focusNo  처음 가운데에 둘 팀 번호
//   options.onSelect(no, { silent }) · onFlip(no, flipped) · onOpen() · onState(state) · onLost(error)
//   controller       update(model) · setActive(no, { open }) · reseal() · pause() · resume() · destroy()
// WebGL이 없거나 three.js를 제때 못 불러오면 reject 한다. app.js가 평면 카드로 바꾼다.

import { TIERS } from './standings.js';

/* ═══════════════════════ 1. 상수·작은 도구 ═══════════════════════ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const CW = 512; // 카드 캔버스 크기
const CH = 768;
const NEUTRAL = { accent: '#8d94ad', base: '#151a2b' }; // 로고·색 정보가 없는 팀

// 카드 등급(자체 이름): 1위 SOLAR(금), 2~3위 FROST(은청), 나머지 VOLT(형광)
const RARITY = {
  prism: {
    key: 'prism',
    label: 'SOLAR',
    frame: ['#fff7d1', '#f6c64f', '#a06c14', '#ffe68f', '#c88d24'],
    accent: '#ffd25e',
    edge: '#d9a740',
    foil: 1.0,
    rays: 0.82,
    ray: '#ffc95a',
    spark: ['#fff4c8', '#ffd25e', '#f2a93b', '#ffffff'],
  },
  chrome: {
    key: 'chrome',
    label: 'FROST',
    frame: ['#ffffff', '#bcd6ec', '#5a7894', '#e6f3ff', '#8fb0cc'],
    accent: '#bfe4ff',
    edge: '#a9c2d8',
    foil: 0.78,
    rays: 0.62,
    ray: '#7fd2ff',
    spark: ['#ffffff', '#bfe4ff', '#3ce6ff'],
  },
  neon: {
    key: 'neon',
    label: 'VOLT',
    frame: ['#f1ffb0', '#bdf43a', '#4b7a00', '#dcff70', '#8fc21a'],
    accent: '#c8ff2e',
    edge: '#7fae1a',
    foil: 0.55,
    rays: 0.42,
    ray: '#a8ff2a',
    spark: ['#e9ff9a', '#c8ff2e', '#3ce6ff'],
  },
};
export const rarityOf = (row) => (row.rank === 1 ? RARITY.prism : row.rank <= 3 ? RARITY.chrome : RARITY.neon);

// 티어 칩: 1티어 금, 2티어 은, 3티어 동
const TIER_META = {
  1: { colors: ['#fff1c1', '#f2c14e', '#b98019'], ink: '#2a1a00' },
  2: { colors: ['#ffffff', '#c9d5e4', '#7d8ea3'], ink: '#18202b' },
  3: { colors: ['#ffd9b8', '#d88a52', '#8a4a22'], ink: '#2a1206' },
};

const RESULT_COLOR = { w: '#c8ff2e', d: '#9aa3bd', l: '#ff5d7a', partial: '#3ce6ff', todo: '#8d94ad', unknown: '#ffd25e' };

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const pad2 = (n) => String(n).padStart(2, '0');
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};

const linear = (k) => k;
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeInCubic = (k) => k * k * k;
const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOutBack = (k) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2);
const easeInBack = (k) => 2.70158 * k * k * k - 1.70158 * k * k;

function rgbOf(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function mixHex(x, y, t) {
  const a = rgbOf(x);
  const b = rgbOf(y);
  return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(', ')})`;
}

// 결과 한 줄을 그 팀 기준 승/무/패/진행 중/예정/휴식으로
export function fixtureOutcome(f) {
  if (f.rest) return 'rest';
  if (f.status !== 'done') return f.status;
  return f.pts > f.oppPts ? 'w' : f.pts < f.oppPts ? 'l' : 'd';
}

// DOM 요소 만들기(글자는 텍스트 노드로만)
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════ 2. 캔버스 그림(카드·팩 무늬) ═══════════════════════ */

function makeCanvas(w, h2) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h2;
  return c;
}

function rr(ctx, x, y, w, h2, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h2, r);
  ctx.arcTo(x + w, y + h2, x, y + h2, r);
  ctx.arcTo(x, y + h2, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function metal(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

function spaced(ctx, text, x, y, spacing, align = 'left') {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
  ctx.textAlign = prev;
  return total;
}

function fitFont(ctx, text, maxW, weight, size) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > 10 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// 축구공 패널을 닮은 육각 그물
function hexGrid(ctx, W, H, size, stroke, lw = 1.5) {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  const hh = size * Math.sqrt(3);
  for (let col = -1; col * size * 1.5 < W + size * 2; col++) {
    for (let row = -1; row * hh < H + hh; row++) {
      const cx = col * size * 1.5;
      const cy = row * hh + (Math.abs(col % 2) === 1 ? hh / 2 : 0);
      hexPath(ctx, cx, cy, size * 0.94);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function shield(ctx, cx, cy, w, h2) {
  const x = cx - w / 2;
  const y = cy - h2 / 2;
  ctx.beginPath();
  ctx.moveTo(cx, y);
  ctx.bezierCurveTo(cx + w * 0.28, y + h2 * 0.07, cx + w * 0.4, y + h2 * 0.02, x + w, y + h2 * 0.09);
  ctx.lineTo(x + w, y + h2 * 0.48);
  ctx.bezierCurveTo(x + w, y + h2 * 0.78, cx + w * 0.2, y + h2 * 0.92, cx, y + h2);
  ctx.bezierCurveTo(cx - w * 0.2, y + h2 * 0.92, x, y + h2 * 0.78, x, y + h2 * 0.48);
  ctx.lineTo(x, y + h2 * 0.09);
  ctx.bezierCurveTo(cx - w * 0.4, y + h2 * 0.02, cx - w * 0.28, y + h2 * 0.07, cx, y);
  ctx.closePath();
}

function starPath(ctx, cx, cy, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

function drawFrame(ctx, W, H, rar) {
  ctx.save();
  ctx.lineWidth = 12;
  ctx.strokeStyle = metal(ctx, 0, 0, W, H, rar.frame);
  rr(ctx, 6, 6, W - 12, H - 12, 34);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  rr(ctx, 22, 22, W - 44, H - 44, 22);
  ctx.stroke();
  ctx.restore();
}

// 로고가 없는 팀(시트에서 이름을 바꾼 팀): 무채색 방패에 팀 번호
function drawNoBadge(ctx, cx, cy, size, no, rar) {
  const w = size * 0.86;
  const hh = size;
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.35)';
  ctx.shadowBlur = 36;
  shield(ctx, cx, cy, w + 18, hh + 20);
  ctx.fillStyle = metal(ctx, cx - w / 2, cy - hh / 2, cx + w / 2, cy + hh / 2, rar.frame);
  ctx.fill();
  ctx.shadowBlur = 0;
  shield(ctx, cx, cy + 2, w, hh);
  const g = ctx.createLinearGradient(cx, cy - hh / 2, cx, cy + hh / 2);
  g.addColorStop(0, '#5a6283');
  g.addColorStop(1, '#151a2b');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${Math.round(size * 0.11)}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  spaced(ctx, 'TEAM', cx, cy - hh * 0.2, 5, 'center');
  ctx.font = `900 ${Math.round(size * 0.52)}px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(no), cx, cy + hh * 0.31);
  ctx.restore();
}

function drawStarBadge(ctx, cx, cy, rar) {
  ctx.save();
  ctx.shadowColor = 'rgba(255,210,94,0.9)';
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.fillStyle = metal(ctx, cx - 46, cy - 46, cx + 46, cy + 46, rar.frame);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(cx, cy, 38, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1206';
  ctx.fill();
  starPath(ctx, cx, cy + 2, 26, 11);
  ctx.fillStyle = metal(ctx, cx - 26, cy - 26, cx + 26, cy + 26, rar.frame);
  ctx.fill();
  ctx.restore();
}

const LOGO = { x: CW / 2, y: 312, size: 236 };

function drawCardFront(ctx, c) {
  const W = CW;
  const H = CH;
  const { row, rar, look, perTeam } = c;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  rr(ctx, 0, 0, W, H, 40);
  ctx.clip();
  let g = ctx.createLinearGradient(0, 0, W * 0.35, H);
  g.addColorStop(0, mixHex(look.base, look.accent, 0.32));
  g.addColorStop(0.42, look.base);
  g.addColorStop(1, '#04050b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 엠블럼 뒤 빛줄기
  ctx.save();
  ctx.translate(W / 2, LOGO.y);
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 20; k++) {
    ctx.rotate((Math.PI * 2) / 20);
    ctx.fillStyle = rgba(look.accent, k % 2 ? 0.035 : 0.07);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-32, -640);
    ctx.lineTo(32, -640);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  g = ctx.createRadialGradient(W / 2, LOGO.y, 10, W / 2, LOGO.y, 270);
  g.addColorStop(0, rgba(look.accent, 0.55));
  g.addColorStop(1, rgba(look.accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  hexGrid(ctx, W, H, 24, 'rgba(255,255,255,0.05)', 1.5);
  g = ctx.createLinearGradient(0, 430, 0, H);
  g.addColorStop(0, 'rgba(4,5,11,0)');
  g.addColorStop(0.3, 'rgba(4,5,11,0.8)');
  g.addColorStop(1, 'rgba(4,5,11,0.96)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 430, W, H - 430);
  ctx.restore();

  drawFrame(ctx, W, H, rar);

  // 순위
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `900 150px ${FONT}`;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = metal(ctx, 40, 60, 170, 190, rar.frame);
  const rankText = String(row.rank);
  ctx.fillText(rankText, 40, 182);
  const rw = ctx.measureText(rankText).width;
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = `800 40px ${FONT}`;
  ctx.fillStyle = rar.accent;
  ctx.fillText('위', 40 + rw + 6, 178);
  ctx.font = `700 21px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  spaced(ctx, 'RANK', 46, 216, 6);
  ctx.restore();

  // 오른쪽 위: 단독 선두 배지, 결정전 대기, 또는 등급
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  if (row.star) {
    drawStarBadge(ctx, W - 98, 100, rar);
    ctx.textAlign = 'center';
    ctx.font = `800 21px ${FONT}`;
    ctx.fillStyle = rar.accent;
    ctx.fillText('단독 선두', W - 98, 178);
  } else {
    const label = row.playoff ? '결정전 대기' : rar.label;
    const color = row.playoff ? '#3ce6ff' : rar.accent;
    ctx.font = row.playoff ? `800 21px ${FONT}` : `800 19px ${FONT}`;
    const tw = row.playoff
      ? ctx.measureText(label).width
      : [...label].reduce((s, ch) => s + ctx.measureText(ch).width, 0) + 4 * (label.length - 1);
    const pw = tw + 30;
    const px = W - 44 - pw;
    rr(ctx, px, 70, pw, 38, 19);
    ctx.fillStyle = row.playoff ? 'rgba(60,230,255,0.16)' : 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    if (row.playoff) {
      ctx.textAlign = 'center';
      ctx.fillText(label, px + pw / 2, 96);
    } else {
      spaced(ctx, label, px + pw / 2, 96, 4, 'center');
    }
  }
  ctx.restore();

  // 팀 로고(없으면 번호 방패)
  if (look.logo) {
    const { x, y, size } = LOGO;
    ctx.save();
    ctx.shadowColor = rgba(look.accent, 0.9);
    ctx.shadowBlur = 46;
    ctx.drawImage(look.logo, x - size / 2, y - size / 2, size, size);
    ctx.restore();
    ctx.drawImage(look.logo, x - size / 2, y - size / 2, size, size);
  } else {
    drawNoBadge(ctx, LOGO.x, LOGO.y + 6, 190, row.no, rar);
  }

  // 팀 이름
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  fitFont(ctx, row.name, W - 120, 900, 76);
  ctx.shadowColor = rgba(look.accent, 0.75);
  ctx.shadowBlur = 26;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(row.name, W / 2, 516);
  ctx.restore();

  // 숫자 4칸
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const stats = [
    ['승점', String(row.pts), true],
    ['경기', `${row.played}/${perTeam}`, false],
    ['승-무-패', `${row.w}-${row.d}-${row.l}`, false],
    ['득실', signed(row.diff), false],
  ];
  const x0 = 40;
  const cw = (W - 80) / 4;
  stats.forEach(([label, value, hot], k) => {
    const cx = x0 + cw * k + cw / 2;
    fitFont(ctx, value, cw - 14, 850, 44);
    ctx.fillStyle = hot ? rar.accent : '#ffffff';
    ctx.fillText(value, cx, 588);
    ctx.font = `600 19px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(label, cx, 618);
    if (k) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0 + cw * k - 1, 552, 2, 72);
    }
  });
  ctx.restore();

  // 티어 칩(금·은·동)
  const chipY = 642;
  const chipH = 50;
  const gap = 10;
  const chipW = (W - 80 - gap * 2) / 3;
  TIERS.forEach((t, k) => {
    const meta = TIER_META[t];
    const name = row.players[t - 1] || '—';
    const x = 40 + k * (chipW + gap);
    ctx.save();
    rr(ctx, x, chipY, chipW, chipH, 12);
    ctx.fillStyle = metal(ctx, x, chipY, x + chipW, chipY + chipH, meta.colors);
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, chipY, chipW, chipH * 0.42);
    ctx.restore();
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `800 19px ${FONT}`;
    ctx.fillStyle = meta.ink;
    ctx.globalAlpha = 0.7;
    const tag = `${t}T`;
    ctx.fillText(tag, x + 10, chipY + 33);
    const tw = ctx.measureText(tag).width;
    ctx.globalAlpha = 1;
    fitFont(ctx, name, chipW - tw - 26, 800, 24);
    ctx.fillText(name, x + 16 + tw, chipY + 34);
    ctx.restore();
  });

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `600 17px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fillText(`NV 내전 리그 · ${rar.label} CARD`, W / 2, 727);
  ctx.restore();
}

// 홀로 반사가 들어갈 자리(흰색일수록 강함). 글자 칸은 거의 빼서 읽기 쉽게 둔다.
function drawCardFrontMask(m, c) {
  const { row, look } = c;
  m.save();
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, m.canvas.width, m.canvas.height);
  m.scale(m.canvas.width / CW, m.canvas.height / CH);
  m.fillStyle = '#000';
  m.fillRect(0, 0, CW, CH);
  m.fillStyle = 'rgb(150,150,150)';
  rr(m, 0, 0, CW, CH, 40);
  m.fill();
  m.fillStyle = 'rgb(26,26,26)';
  m.fillRect(30, 452, 452, 288);
  m.fillStyle = 'rgb(80,80,80)';
  m.fillRect(40, 642, 432, 50);
  m.lineWidth = 18;
  m.strokeStyle = '#fff';
  rr(m, 6, 6, 500, 756, 34);
  m.stroke();
  // 로고 모양 자리는 반사를 약하게 해서 로고 그림이 또렷이 보이게 한다
  const { x, y, size } = LOGO;
  if (look.logo) {
    const tmp = makeCanvas(64, 64);
    const t = tmp.getContext('2d');
    t.drawImage(look.logo, 0, 0, 64, 64);
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = 'rgb(56,56,56)';
    t.fillRect(0, 0, 64, 64);
    m.drawImage(tmp, x - size / 2, y - size / 2, size, size);
  } else {
    shield(m, x, y + 6, 190 * 0.86 + 18, 190 + 20);
    m.fillStyle = '#fff';
    m.fill();
  }
  m.fillStyle = '#fff';
  m.font = `900 150px ${FONT}`;
  m.textAlign = 'left';
  m.textBaseline = 'alphabetic';
  m.fillText(String(row.rank), 40, 182);
  if (row.star) {
    m.beginPath();
    m.arc(CW - 98, 100, 50, 0, Math.PI * 2);
    m.fill();
  }
  m.restore();
}

// 카드 뒷면: 그 팀의 주차별 일정(휴식·결과·예정)
function drawCardBack(ctx, c, logoFor, currentWeek) {
  const W = CW;
  const H = CH;
  const { row, rar, look, fixtures } = c;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  rr(ctx, 0, 0, W, H, 40);
  ctx.clip();
  let g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0b0d1b');
  g.addColorStop(0.6, look.base);
  g.addColorStop(1, '#05060c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.font = `900 46px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = -640, r = 0; y <= 640; y += 70, r++) {
    for (let x = -600; x <= 600; x += 116) ctx.fillText('NV', x + (r % 2 ? 58 : 0), y);
  }
  ctx.restore();
  g = ctx.createRadialGradient(W * 0.2, 60, 10, W * 0.2, 60, 340);
  g.addColorStop(0, rgba(look.accent, 0.35));
  g.addColorStop(1, rgba(look.accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  drawFrame(ctx, W, H, rar);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 19px ${FONT}`;
  ctx.fillStyle = rar.accent;
  spaced(ctx, `SCHEDULE · ${fixtures.length}주`, 46, 72, 4);
  fitFont(ctx, row.name, W - 200, 900, 54);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(row.name, 46, 132);
  const nw = ctx.measureText(row.name).width;
  ctx.font = `800 30px ${FONT}`;
  ctx.fillStyle = rar.accent;
  ctx.fillText(`${row.rank}위`, 46 + nw + 14, 130);
  ctx.font = `600 20px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(TIERS.map((t) => row.players[t - 1] || '—').join(' · '), 46, 166);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(46, 184, W - 92, 2);

  const rowH = fixtures.length ? Math.min(56, Math.floor(500 / fixtures.length)) : 56;
  // 대진표의 이름을 시트에서 찾지 못한 팀(시트에서 팀 이름만 바꾼 경우): 아홉 줄 '미정' 대신 한 줄 안내
  const lost = fixtures.length > 0 && fixtures.every((f) => !f.rest && f.opponent == null);
  if (!fixtures.length || lost) {
    ctx.textAlign = 'center';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillStyle = lost ? RESULT_COLOR.unknown : 'rgba(255,255,255,0.55)';
    if (lost) {
      ctx.fillText('대진표에서 이 팀 이름을', W / 2, 400);
      ctx.fillText('찾지 못했습니다', W / 2, 440);
      ctx.font = `600 20px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('운영자 확인 필요', W / 2, 492);
    } else {
      ctx.fillText('일정이 없습니다', W / 2, 420);
    }
  }
  if (!lost) fixtures.forEach((f, k) => {
    const y = 194 + k * rowH;
    const mid = y + rowH / 2;
    const out = fixtureOutcome(f);
    if (f.week === currentWeek) {
      rr(ctx, 34, y + 3, W - 68, rowH - 6, 12);
      ctx.fillStyle = 'rgba(200,255,46,0.09)';
      ctx.fill();
      ctx.fillStyle = '#c8ff2e';
      ctx.fillRect(34, y + 10, 4, rowH - 20);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 20px ${FONT}`;
    ctx.fillStyle = f.week === currentWeek ? '#e9ff9a' : 'rgba(255,255,255,0.5)';
    ctx.fillText(`${f.week}주`, 50, mid);
    if (out === 'rest') {
      ctx.font = `700 24px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('휴식', 146, mid);
    } else {
      // 상대 이름을 시트에서 못 찾으면 옛 로고 대신 빈 방패와 '확인'
      const unknown = f.opponent == null;
      const logo = f.opponentName && !unknown ? logoFor(f.opponentName) : null;
      if (logo) ctx.drawImage(logo, 100, mid - 20, 40, 40);
      else {
        shield(ctx, 120, mid, 28, 34);
        ctx.fillStyle = '#4a5170';
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      fitFont(ctx, f.opponentName || '미정', 150, 800, 25);
      ctx.fillText(f.opponentName || '미정', 148, mid);
      ctx.textAlign = 'right';
      if (out === 'w' || out === 'd' || out === 'l' || out === 'partial') {
        ctx.font = `850 32px ${FONT}`;
        ctx.fillStyle = out === 'w' ? rar.accent : '#ffffff';
        ctx.fillText(`${f.pts}:${f.oppPts}`, W - 142, mid + 1);
      }
      const key = unknown ? 'unknown' : out;
      const label = { w: '승', d: '무', l: '패', partial: `${f.count}/${TIERS.length}`, todo: '예정', unknown: '확인' }[key];
      const color = RESULT_COLOR[key];
      rr(ctx, W - 128, mid - 18, 82, 36, 10);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      ctx.font = `800 21px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(label, W - 87, mid + 1);
    }
    if (k < fixtures.length - 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(46, y + rowH - 1, W - 92, 1);
    }
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fillText('한 번 더 탭하면 앞면', W / 2, 731);
  ctx.restore();
}

function drawCardBackMask(m) {
  m.save();
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.scale(m.canvas.width / CW, m.canvas.height / CH);
  m.fillStyle = '#000';
  m.fillRect(0, 0, CW, CH);
  m.fillStyle = 'rgb(110,110,110)';
  rr(m, 0, 0, CW, CH, 40);
  m.fill();
  m.fillStyle = 'rgb(12,12,12)';
  m.fillRect(30, 40, 452, 700);
  m.lineWidth = 18;
  m.strokeStyle = '#fff';
  rr(m, 6, 6, 500, 756, 34);
  m.stroke();
  m.restore();
}

function drawPackArt(c, e, W, H, count, logos) {
  c.clearRect(0, 0, W, H);
  e.clearRect(0, 0, W, H);
  let g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#141c44');
  g.addColorStop(0.38, '#2a1254');
  g.addColorStop(0.7, '#0c2d40');
  g.addColorStop(1, '#070d18');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  // 무지개 홀로 띠
  c.save();
  c.translate(W / 2, H / 2);
  c.rotate(-0.5);
  c.globalCompositeOperation = 'lighter';
  for (let i = -7; i <= 7; i++) {
    const hue = (i * 40 + 720) % 360;
    const x = i * 78;
    const sg = c.createLinearGradient(x - 40, 0, x + 40, 0);
    sg.addColorStop(0, `hsla(${hue}, 100%, 60%, 0)`);
    sg.addColorStop(0.5, `hsla(${hue}, 100%, 65%, 0.09)`);
    sg.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    c.fillStyle = sg;
    c.fillRect(x - 40, -H, 80, H * 2);
  }
  c.restore();
  hexGrid(c, W, H, 30, 'rgba(200,255,46,0.09)', 1.5);
  hexGrid(e, W, H, 30, 'rgba(200,255,46,0.1)', 1.5);

  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.font = `800 28px ${FONT}`;
  c.fillStyle = '#ffffff';
  spaced(c, 'TEAM CARD PACK', W / 2, 84, 7, 'center');
  c.font = `700 19px ${FONT}`;
  c.fillStyle = 'rgba(255,255,255,0.6)';
  spaced(c, 'NV LEAGUE', W / 2, 114, 8, 'center');

  // 공의 궤적 링
  for (const ctx of [c, e]) {
    ctx.save();
    ctx.translate(W / 2, 310);
    ctx.rotate(-0.22);
    ctx.beginPath();
    ctx.ellipse(0, 0, 214, 66, 0, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#3ce6ff';
    ctx.shadowColor = '#3ce6ff';
    ctx.shadowBlur = ctx === e ? 14 : 0;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(196, -28, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  c.font = `900 250px ${FONT}`;
  const ng = c.createLinearGradient(0, 220, 0, 400);
  ng.addColorStop(0, '#ffffff');
  ng.addColorStop(0.5, '#c9d2f0');
  ng.addColorStop(1, '#6f7aa6');
  c.fillStyle = ng;
  c.fillText('NV', W / 2, 394);
  c.lineWidth = 5;
  c.strokeStyle = '#c8ff2e';
  c.strokeText('NV', W / 2, 394);
  e.save();
  e.font = c.font;
  e.textAlign = 'center';
  e.textBaseline = 'alphabetic';
  e.lineWidth = 5;
  e.strokeStyle = '#c8ff2e';
  e.shadowColor = '#c8ff2e';
  e.shadowBlur = 20;
  e.strokeText('NV', W / 2, 394);
  e.restore();

  c.font = `900 46px ${FONT}`;
  c.fillStyle = '#ffffff';
  c.fillText('NV 내전 리그', W / 2, 458);
  c.font = `600 20px ${FONT}`;
  c.fillStyle = 'rgba(255,255,255,0.72)';
  c.fillText(`팀 카드 ${count}장 · 순위 카드 전원 수록`, W / 2, 492);

  // 팩에 든 팀 로고 줄
  const shown = logos.slice(0, 9);
  if (shown.length) {
    const size = 42;
    const gap = 8;
    const total = shown.length * size + (shown.length - 1) * gap;
    let x = (W - total) / 2;
    for (const img of shown) {
      if (img) c.drawImage(img, x, 510, size, size);
      x += size + gap;
    }
  }
  for (const ctx of [c, e]) {
    ctx.fillStyle = '#c8ff2e';
    ctx.fillRect(0, 568, W, 10);
    ctx.fillStyle = '#3ce6ff';
    ctx.fillRect(0, 584, W, 3);
  }
  c.font = `700 15px ${FONT}`;
  c.fillStyle = 'rgba(255,255,255,0.5)';
  c.textAlign = 'left';
  c.fillText('NV LEAGUE', 30, 616);
  c.textAlign = 'right';
  c.fillText('LIMITED EDITION', W - 30, 616);
}

function drawPackBack(c, W, H) {
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#11163a');
  g.addColorStop(1, '#070a16');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  hexGrid(c, W, H, 24, 'rgba(60,230,255,0.08)', 1.2);
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.font = `800 22px ${FONT}`;
  c.fillStyle = '#c8ff2e';
  spaced(c, 'HOW TO OPEN', W / 2, 80, 6, 'center');
  c.strokeStyle = '#ffffff';
  c.lineWidth = 6;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(W / 2 - 70, 150);
  c.lineTo(W / 2 + 70, 150);
  c.moveTo(W / 2 + 50, 132);
  c.lineTo(W / 2 + 70, 150);
  c.lineTo(W / 2 + 50, 168);
  c.stroke();
  c.font = `800 26px ${FONT}`;
  c.fillStyle = '#ffffff';
  c.fillText('윗부분을 옆으로 밀어', W / 2, 220);
  c.fillText('뜯으세요', W / 2, 254);
  for (let x = 70, i = 0; x < W - 70; i++) {
    const w = 2 + ((i * 7) % 5);
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.fillRect(x, 330, w, 70);
    x += w + 3 + ((i * 3) % 4);
  }
  c.font = `700 17px ${FONT}`;
  c.fillStyle = 'rgba(255,255,255,0.6)';
  spaced(c, 'NV-LEAGUE-TCP', W / 2, 428, 5, 'center');
}

function drawCrimp(c, W, H) {
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#9aa3c7');
  g.addColorStop(0.5, '#eef1ff');
  g.addColorStop(1, '#59618a');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 8) {
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.fillRect(x, 0, 3, H);
    c.fillStyle = 'rgba(255,255,255,0.3)';
    c.fillRect(x + 3, 0, 1, H);
  }
}

// 축구공(깎은 정이십면체: 오각형 12 + 육각형 20) 무늬를 구 텍스처로 직접 계산한다.
// 각 픽셀의 방향에서 가장 먼저 닿는 면(오각형/육각형)을 찾고, 두 면이 거의 같으면 솔기로 칠한다.
function drawBallTexture(c, W, H) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const ico = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) ico.push([0, s1, s2 * phi], [s1, s2 * phi, 0], [s2 * phi, 0, s1]);
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const faces = [];
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (Math.abs(dist(ico[i], ico[j]) - 2) > 1e-6) continue;
      for (let k = j + 1; k < 12; k++) {
        if (Math.abs(dist(ico[j], ico[k]) - 2) > 1e-6 || Math.abs(dist(ico[i], ico[k]) - 2) > 1e-6) continue;
        faces.push([ico[i][0] + ico[j][0] + ico[k][0], ico[i][1] + ico[j][1] + ico[k][1], ico[i][2] + ico[j][2] + ico[k][2]]);
      }
    }
  }
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  // 면까지의 거리: 오각형 2.3275, 육각형 2.2673 (모서리 길이 1 기준)
  const planes = [...ico.map((v) => [...norm(v), 2.32745, 1]), ...faces.map((v) => [...norm(v), 2.26729, 0])];
  const img = c.createImageData(W, H);
  const d = img.data;
  const PENT = [18, 21, 34];
  const HEX = [240, 243, 250];
  const SEAM = [52, 58, 80];
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI;
    const st = Math.sin(th);
    const ct = Math.cos(th);
    for (let x = 0; x < W; x++) {
      const ph = ((x + 0.5) / W) * Math.PI * 2;
      const px = -Math.cos(ph) * st;
      const pz = Math.sin(ph) * st;
      let t1 = Infinity;
      let t2 = Infinity;
      let pent = 0;
      for (const p of planes) {
        const dot = p[0] * px + p[1] * ct + p[2] * pz;
        if (dot <= 0) continue;
        const t = p[3] / dot;
        if (t < t1) {
          t2 = t1;
          t1 = t;
          pent = p[4];
        } else if (t < t2) t2 = t;
      }
      const seam = clamp(1 - (t2 - t1) / t1 / 0.016, 0, 1);
      const base = pent ? PENT : HEX;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) d[o + k] = Math.round(lerp(base[k], SEAM[k], seam * seam * (3 - 2 * seam)));
      d[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}

/* ═══════════════════════ 3. 셰이더 ═══════════════════════ */

const UV_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CARD_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;

// 홀로그램 포일: 기울기(uTilt)·시선 각도에 따라 무지개 띠, 반짝이, 광택 띠가 움직인다.
const CARD_FS = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uMask;
uniform float uTime;
uniform vec2 uTilt;
uniform float uFoil;
uniform float uDim;
uniform float uGlow;
uniform vec3 uTint;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec4 base = texture2D(uMap, vUv);
  float m = texture2D(uMask, vUv).r;
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  vec2 ang = N.xy * 0.8 + uTilt;
  float h = fract(dot(vUv, vec2(0.62, 0.38)) * 1.4 + ang.x * 0.55 - ang.y * 0.4 + uTime * 0.015);
  vec3 rainbow = hue2rgb(h);
  float stripes = 0.5 + 0.5 * sin((vUv.x * 1.3 - vUv.y * 2.1) * 46.0 + ang.x * 9.0 + ang.y * 5.0);
  float bandPos = vUv.x * 0.75 + vUv.y * 0.55;
  float bandCenter = 0.65 + ang.x * 1.25 - ang.y * 0.9;
  float bandD = (bandPos - bandCenter) * 4.2;
  float glint = exp(-bandD * bandD);
  vec2 grid = vUv * vec2(72.0, 108.0);
  vec2 cell = floor(grid);
  vec2 f = fract(grid) - 0.5;
  float rnd = hash(cell);
  float dotS = max(1.0 - length(f) * 2.4, 0.0);
  float crs = max(1.0 - abs(f.x) * 10.0, 0.0) * max(1.0 - abs(f.y) * 2.1, 0.0)
              + max(1.0 - abs(f.y) * 10.0, 0.0) * max(1.0 - abs(f.x) * 2.1, 0.0);
  float shape = dotS * dotS + crs * 0.45;
  float twinkle = step(0.986, rnd) * shape * pow(0.5 + 0.5 * sin(rnd * 91.0 + ang.x * 26.0 + ang.y * 17.0 + uTime * 0.7), 6.0);
  vec3 col = base.rgb;
  vec3 foil = rainbow * (0.45 + 0.55 * stripes);
  col += foil * m * uFoil * 0.34;
  col += glint * (0.1 + 0.5 * m) * uFoil * mix(vec3(1.0), rainbow, 0.55);
  col += twinkle * m * uFoil * 2.0;
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col += uTint * fres * 0.35;
  float edgeD = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y) * 1.5);
  col += uTint * uGlow * (1.0 - smoothstep(0.0, 0.06, edgeD)) * 0.8;
  col *= uDim;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const SPARK_VS = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aAlpha > 0.001 ? max(aSize * uScale / max(-mv.z, 0.1), 1.0) : 0.0;
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = pow(1.0 - d * 2.0, 1.8);
  float core = 1.0 - smoothstep(0.0, 0.16, d);
  gl_FragColor = vec4(vColor * (a + core * 1.5) * vAlpha, 1.0);
  #include <colorspace_fragment>
}`;

const DUST_VS = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
varying float vSeed;
void main() {
  vec3 p = position;
  float sp = 0.05 + aSeed * 0.09;
  p.y = mod(p.y + 2.2 + uTime * sp, 7.4) - 2.2;
  p.x += sin(uTime * 0.21 + aSeed * 31.0) * 0.3;
  p.z += cos(uTime * 0.17 + aSeed * 17.0) * 0.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.018 + aSeed * 0.03) * uScale / max(-mv.z, 0.1);
  vA = 0.25 + 0.75 * pow(abs(sin(uTime * 0.6 + aSeed * 40.0)), 3.0);
  vSeed = aSeed;
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FS = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uOpacity;
varying float vA;
varying float vSeed;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = pow(1.0 - d * 2.0, 2.0) * vA * uOpacity;
  gl_FragColor = vec4(mix(uColA, uColB, step(0.6, vSeed)) * a, 1.0);
  #include <colorspace_fragment>
}`;

const FLOOR_VS = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// 바닥: 센터서클·하프라인·센터 스폿이 빛나는 경기장 한가운데
const FLOOR_FS = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uWave;
uniform float uWaveAmp;
uniform vec3 uLine;
uniform vec3 uBase;
varying vec2 vP;
void main() {
  float r = length(vP);
  float circle = 1.0 - smoothstep(0.012, 0.032, abs(r - 1.55));
  float midline = (1.0 - smoothstep(0.012, 0.032, abs(vP.y))) * step(r, 5.2);
  float spot = 1.0 - smoothstep(0.05, 0.08, r);
  float outer = (1.0 - smoothstep(0.01, 0.03, abs(r - 4.6))) * 0.5;
  float marks = max(max(circle, midline), max(spot, outer));
  float grass = step(0.5, fract(vP.x * 0.55 + 0.25)) * 0.5 + 0.5;
  float fade = 1.0 - smoothstep(1.2, 5.6, r);
  float wave = (1.0 - smoothstep(0.0, 0.22, abs(r - uWave))) * uWaveAmp;
  float scan = 0.5 + 0.5 * sin(r * 16.0 - uTime * 1.5);
  vec3 col = uBase * (0.6 + 0.4 * grass);
  col += uLine * marks * (0.35 + uPulse);
  col += uLine * wave * 1.2;
  col += uLine * 0.03 * scan * fade;
  gl_FragColor = vec4(col * fade, fade);
  #include <colorspace_fragment>
}`;

const RAYS_FS = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  float a = atan(p.y, p.x);
  float rays = pow(0.5 + 0.5 * sin(a * 12.0 + uTime * 0.35), 5.0) + 0.7 * pow(0.5 + 0.5 * sin(a * 7.0 - uTime * 0.22 + 1.3), 9.0);
  float fall = 1.0 - smoothstep(0.05, 1.0, r);
  float core = (1.0 - smoothstep(0.0, 0.55, r)) * 0.32;
  gl_FragColor = vec4(uColor * (rays * fall * 0.55 + core) * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

const BEAM_VS = /* glsl */ `
varying float vY;
varying vec3 vN;
varying vec3 vV;
void main() {
  vY = uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = -mv.xyz;
  vN = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vY;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = abs(dot(normalize(vN), normalize(vV)));
  float a = pow(vY, 1.4) * pow(f, 1.6) * uOpacity;
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

const GLOW_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 2.2);
  gl_FragColor = vec4(uColor * a * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

const SEAM_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float v = max(1.0 - abs(vUv.y - 0.5) * 2.0, 0.0);
  gl_FragColor = vec4(uColor * (pow(v, 1.5) * 1.6 + pow(v, 8.0) * 2.0) * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

// 뜯긴 틈에서 새는 빛. uP(뜯은 정도)만큼만 보인다.
const LEAK_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uP;
uniform float uDir;
varying vec2 vUv;
void main() {
  float x = uDir > 0.0 ? vUv.x : 1.0 - vUv.x;
  float reveal = 1.0 - smoothstep(uP - 0.05, uP + 0.02, x);
  float v = max(1.0 - abs(vUv.y - 0.5) * 2.0, 0.0);
  gl_FragColor = vec4(uColor * pow(v, 3.0) * reveal * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

// 팩이 열릴 때 위로 뻗는 빛 부채
const FAN_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vec2((vUv.x - 0.5) * 1.6, vUv.y);
  float ang = atan(p.x, p.y + 0.08);
  float rays = 0.45 + 0.55 * pow(0.5 + 0.5 * cos(ang * 22.0 + sin(ang * 5.0 + uTime) * 1.5), 3.0);
  float spread = 1.0 - smoothstep(0.35, 0.95, abs(ang));
  float fade = pow(1.0 - vUv.y, 1.6);
  float base = 1.0 - smoothstep(0.0, 0.25, length(p));
  gl_FragColor = vec4(uColor * (rays * spread * fade + base * 0.8) * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

/* ═══════════════════════ 4. 무대 ═══════════════════════ */

export async function mountCards3D(container, options = {}) {
  if (!hasWebGL()) throw new Error('WebGL을 쓸 수 없는 환경입니다.');
  const stage = createStage(container, options);
  try {
    await stage.start(options.timeoutMs ?? 15000);
  } catch (err) {
    stage.destroy();
    throw err;
  }
  return stage.controller;
}

function createStage(container, opts) {
  let model = opts.model;
  let rows = model.rows;
  let N = rows.length;
  const metaFor = opts.metaFor || (() => null);
  const cb = {
    select: opts.onSelect || noop,
    flip: opts.onFlip || noop,
    open: opts.onOpen || noop,
    state: opts.onState || noop,
    lost: opts.onLost || noop,
  };

  const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduceMotion = mqReduce.matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const lowPower = coarse || window.innerWidth < 640;
  // 봉인된 팩 안내: 터치 기기는 '밀기·탭', 마우스는 '드래그·클릭'. 아주 좁은 화면(360px 미만)은 한 줄에 들어가게 짧게.
  const narrowUI = () => (container.clientWidth || 999) < 360;
  const sealHint = () =>
    coarse ? (narrowUI() ? '옆으로 밀거나 세 번 탭' : '윗부분을 옆으로 밀거나 세 번 탭') : '윗부분을 옆으로 드래그하거나 세 번 클릭';
  const CAROUSEL_HINTS = [
    '← 밀어서 넘기기 · 카드를 탭하면 뒤집혀요 →',
    coarse ? '카드를 길게 누르고 좌우로 움직이면 홀로그램이 기울어요' : '마우스를 움직이면 카드가 기울고 홀로그램이 반응해요',
  ];
  // 터치: 가운데 카드를 이만큼 누르고 있으면 살펴보기(inspect). 잠깐 멈췄다 스크롤하는 손짓과 헷갈리지 않게 넉넉히.
  const HOLD_MS = 480;
  // 한동안 아무 입력·움직임이 없으면 그리는 횟수를 줄인다(주변 반짝임만 남았을 때 배터리·발열 줄이기)
  const IDLE_AFTER_MS = 4000;
  const IDLE_LONG_MS = 20000;

  const ui = { state: 'loading', focus: 0, live: 0, flipped: -1, pendingFocus: null, pendingOpen: false };
  const cleanups = [];
  let destroyed = false;
  let paused = false;

  function listen(target, type, fn, o) {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  }

  const indexOfNo = (no) => Math.max(0, rows.findIndex((r) => r.no === no));
  ui.focus = ui.live = opts.focusNo != null ? indexOfNo(opts.focusNo) : 0;

  /* ───────── 무대 위 글자·단추(DOM) ───────── */

  const dom = buildDom();

  function buildDom() {
    container.replaceChildren();
    container.classList.add('stage');
    container.dataset.state = 'loading';
    container.tabIndex = 0;
    container.setAttribute('role', 'group');
    container.setAttribute('aria-roledescription', '3D 카드 무대');
    container.setAttribute('aria-label', '팀 카드');
    container.setAttribute('aria-describedby', 'stage-help');
    const d = {};
    d.canvas = h('canvas', { 'aria-hidden': 'true' });
    d.heroCount = h('em', {}, `${N}장`);
    d.gestureText = h('span', {}, sealHint());
    d.gesture = h('p', { class: 'gesture' }, h('span', { class: 'swipe-icon', 'aria-hidden': 'true' }, h('i')), d.gestureText);
    d.openNow = h('button', { type: 'button', class: 'btn-open' }, '바로 열기');
    d.tearGuide = h(
      'div',
      { class: 'tear-guide', 'aria-hidden': 'true' },
      h('span', { class: 'tg-line' }),
      h('span', { class: 'tg-dot' }),
      h('span', { class: 'tg-label' }, '← 밀어서 뜯기 →'),
    );
    d.counter = h('span', { class: 'counter', 'aria-hidden': 'true' });
    d.flipBtn = h('button', { type: 'button', class: 'pill-btn', 'aria-pressed': 'false' }, '뒤집기');
    d.resealBtn = h('button', { type: 'button', class: 'pill-btn' }, '팩 다시 열기');
    d.carouselHint = h('p', { class: 'carousel-hint is-gone', 'aria-hidden': 'true' }, CAROUSEL_HINTS[0]);
    d.prevBtn = h('button', { type: 'button', class: 'nav-btn', 'aria-label': '이전 카드' }, icon('m12 4-6 6 6 6'));
    d.nextBtn = h('button', { type: 'button', class: 'nav-btn', 'aria-label': '다음 카드' }, icon('m8 4 6 6-6 6'));
    d.dots = h('div', { class: 'dots' });
    d.flash = h('div', { class: 'flash', 'aria-hidden': 'true' });
    container.append(
      d.canvas,
      h('div', { class: 'stage-vignette', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'hero-copy' },
        h('p', { class: 'kicker' }, 'Team card pack'),
        h('p', { class: 'hero-title' }, '팀 카드 ', d.heroCount, ',', h('br'), '지금 개봉하세요'),
        h('p', { class: 'hero-sub' }, '팩 윗부분을 옆으로 밀어 뜯으면 순위대로 팀 카드가 쏟아져요.'),
      ),
      d.tearGuide,
      h('div', { class: 'pre-ui' }, d.gesture, d.openNow),
      h('div', { class: 'post-top' }, d.counter, h('div', { class: 'post-tools' }, d.flipBtn, d.resealBtn)),
      d.carouselHint,
      h('div', { class: 'post-ui' }, d.prevBtn, d.dots, d.nextBtn),
      d.flash,
      h(
        'div',
        { class: 'loader', 'aria-hidden': 'true' },
        h('span', { class: 'loader-pack' }, h('b', {}, 'NV')),
        h('span', { class: 'loader-text' }, '카드 팩 준비 중…'),
      ),
      h(
        'p',
        { id: 'stage-help', class: 'sr-only' },
        '왼쪽·오른쪽 화살표 키로 카드를 넘기고, Enter 키로 팩을 열거나 카드를 뒤집습니다. 카드 내용은 아래 팀 정보와 순위표에 글자로도 있습니다.',
      ),
    );
    return d;
  }

  function setState(s) {
    ui.state = s;
    container.dataset.state = s;
    cb.state(s);
  }

  function renderDots() {
    dom.dots.replaceChildren(
      ...rows.map((r, i) =>
        h(
          'button',
          { type: 'button', class: `dot r-${rarityOf(r).key}`, 'data-index': i, 'aria-label': `${r.rank}위 ${r.name} 카드` },
          r.rank,
        ),
      ),
    );
    syncDots(ui.live);
  }

  function syncDots(i) {
    [...dom.dots.children].forEach((b, k) => {
      b.classList.toggle('is-active', k === i);
      if (k === i) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    dom.counter.textContent = N ? `${pad2(i + 1)} / ${pad2(N)}` : '';
  }

  function flash(strength = 0.85, duration = 700) {
    if (!dom.flash.animate) return;
    dom.flash.animate([{ opacity: reduceMotion ? Math.min(strength, 0.25) : strength }, { opacity: 0 }], {
      duration: reduceMotion ? 220 : duration,
      easing: 'cubic-bezier(.2,.7,.2,1)',
    });
  }

  function haptic(pattern) {
    try {
      if (reduceMotion || !navigator.vibrate) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      navigator.vibrate(pattern);
    } catch {
      /* 진동이 없는 기기 */
    }
  }

  renderDots();

  /* ───────── 그림 자료(로고·글꼴) ───────── */

  const images = new Map(); // 로고 주소 → { img, ok }

  function logoUrl(name) {
    return metaFor(name)?.logo || null;
  }

  function logoFor(name) {
    const url = logoUrl(name);
    const entry = url && images.get(url);
    return entry?.ok ? entry.img : null;
  }

  function loadLogos() {
    const names = new Set(rows.map((r) => r.name));
    for (const list of model.fixtures.values()) for (const f of list) if (f.opponentName) names.add(f.opponentName);
    const jobs = [];
    for (const name of names) {
      const url = logoUrl(name);
      if (!url || images.has(url)) continue;
      const img = new Image();
      img.decoding = 'async';
      const entry = { img, ok: false };
      images.set(url, entry);
      img.src = url;
      jobs.push(
        img.decode().then(
          () => {
            entry.ok = true;
          },
          () => {},
        ),
      );
    }
    // 새로 불러온 로고가 있으면 true(그때만 다시 그린다)
    return jobs.length ? Promise.allSettled(jobs).then(() => true) : Promise.resolve(false);
  }

  function fontJobs() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const names = rows.map((r) => r.name + r.players.join('')).join('');
    const opponents = [...model.fixtures.values()].flat().map((f) => f.opponentName || '').join('');
    const text = `0123456789:+-/·— 위팀승점경기무패득실휴식예정진행중주차이번한번더탭하면앞면일정이없습니다미정내전리그장카드순위전원수록결정전대기단독선두윗부분을옆으로밀어뜯으세요대진표에서이름찾지못했운영자확인필요ABCDEFGHIJKLMNOPQRSTUVWXYZ${names}${opponents}`;
    return Promise.allSettled([900, 850, 800, 700, 600].map((w) => document.fonts.load(`${w} 40px "Pretendard Variable"`, text)));
  }

  // 글꼴·로고를 2.6초까지 기다린다. 그보다 늦으면 일단 그리고, 다 오면 다시 그린다.
  // 늦은 작업은 { late } 객체에 담아 돌려준다. async 함수가 약속을 그대로 돌려주면 그 약속이 끝날 때까지
  // 기다리게 되어 2.6초 제한이 사라지고, 받는 쪽에는 약속 대신 결과 배열이 간다.
  async function assetsReady(logoJob) {
    const jobs = Promise.allSettled([fontJobs(), logoJob]);
    const timedOut = await Promise.race([jobs.then(() => false), wait(2600).then(() => true)]);
    return timedOut ? { late: jobs } : null;
  }

  /* ───────── three.js 상태 ───────── */

  let THREE = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let raycaster = null;
  let sceneReady = false;
  let running = false;
  let rafId = 0;
  let lastNow = 0;
  let activeUntil = 0;
  let inView = true;
  let raysOn = false;
  let frameK = 0;
  let shakeAmp = 0;
  let sparks = null;
  let confetti = null;
  let PAL = null;
  let RAR_C = null;
  let wheelAcc = 0;
  let hintTimer = 0;
  let holdTimer = 0;
  let inspectK = 0;
  let resizeObs = null;
  let viewObs = null;
  // 팩 둘레를 도는 3D 축구공: orbit(공전) → fly(개봉 때 차 올림) → off
  const BALL = { mesh: null, mode: 'orbit', a: 0.6, k: 1, spinBoost: 0, t: 0, trail: 0, vel: null, spin: null };

  const U = { time: { value: 0 }, scale: { value: 600 } };
  const sim = { t: 0 };
  const stageSize = { w: 0, h: 0 };
  const L = { narrow: true, wide: false, xNear: 0.98, xFar: 0.3, zNear: 0.85, zFar: 0.4, rot: 1.05, visible: 3, packScale: 0.84 };
  const P = { W: 1.6, H: 2.0, CH: 0.22, offsetX: 0, progress: 0, shown: 0, lastShown: 0, dir: 1, settle: 0, scaleK: 1, sinkK: 0, flapFlying: false, openQueued: false, seamPx: 200 };
  const CARD = { w: 1.2, h: 1.8, r: 0.085, t: 0.028 };
  const cards = [];
  const pickables = [];
  const car = { pos: ui.focus, target: ui.focus, dragging: false };
  const tilt = { x: 0, y: 0, gx: 0, gy: 0, gtx: 0, gty: 0 };
  const par = { x: 0, y: 0 };
  const ptr = { down: false, id: -1, x0: 0, y0: 0, t0: 0, mode: null, lastX: 0, lastT: 0, vx: 0, pos0: 0, tear0: 0, nx: 0, ny: 0, cx: 0, cy: 0, type: 'mouse', inspectAt: 0 };
  const env = {};
  const tweens = [];
  const timers = [];
  const V = {};
  let cardShared = null; // 카드 모양(모든 카드가 같이 씀)

  function tween(dur, update, { delay = 0, ease = easeOutCubic, done = null } = {}) {
    const tw = { t: -delay, dur: Math.max(dur, 1e-4), update, ease, done };
    tweens.push(tw);
    return tw;
  }

  function after(sec, fn) {
    timers.push({ t: sec, fn });
  }

  function stepTweens(dt) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (!tw) continue;
      tw.t += dt;
      if (tw.t < 0) continue;
      const raw = Math.min(tw.t / tw.dur, 1);
      tw.update(tw.ease(raw), raw);
      if (raw >= 1) {
        tweens.splice(tweens.indexOf(tw), 1);
        if (tw.done) tw.done();
      }
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      const tm = timers[i];
      if (!tm) continue;
      tm.t -= dt;
      if (tm.t <= 0) {
        timers.splice(timers.indexOf(tm), 1);
        tm.fn();
      }
    }
  }

  function makeTexture(canvas, srgb) {
    const t = new THREE.CanvasTexture(canvas);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    t.needsUpdate = true;
    return t;
  }

  function glowMaterial(fs, uniforms, { vs = UV_VS, side = THREE.FrontSide } = {}) {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: vs,
      fragmentShader: fs,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side,
    });
  }

  function setupRenderer(RoomEnvironment) {
    renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x05060c, 1);
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060c, 0.05);
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
    camera.position.set(0, 0.4, 6);
    raycaster = new THREE.Raycaster();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    if (typeof room.dispose === 'function') room.dispose();
    pmrem.dispose();
    V.a = new THREE.Vector3();
    V.b = new THREE.Vector3();
    V.c = new THREE.Vector3();
    V.ndc = new THREE.Vector2();
    V.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.6);
    const toColors = (list) => list.map((c) => new THREE.Color(c));
    PAL = {
      open: toColors(['#ffffff', '#fff1b8', '#c8ff2e', '#3ce6ff', '#ffd25e', '#ff7ad1']),
      tear: toColors(['#ffffff', '#fff1b8', '#e9ff9a', '#ffd25e']),
      trail: toColors(['#c8ff2e', '#3ce6ff', '#e9ff9a']),
      confetti: toColors(['#ffd25e', '#c8ff2e', '#3ce6ff', '#ffffff', '#ff4fb8', '#bfe4ff']),
    };
    RAR_C = {};
    for (const rar of Object.values(RARITY)) RAR_C[rar.key] = { spark: toColors(rar.spark), ray: new THREE.Color(rar.ray) };
  }

  function buildEnvironment() {
    scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x080610, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2.5, 4, 5);
    scene.add(key);
    const rimL = new THREE.PointLight(0x3ce6ff, 16, 14, 2);
    rimL.position.set(-3.2, 1.4, 1.8);
    scene.add(rimL);
    const rimR = new THREE.PointLight(0xff4fb8, 12, 14, 2);
    rimR.position.set(3.2, -0.6, 1.8);
    scene.add(rimR);
    env.burst = new THREE.PointLight(0xfff0c0, 0, 9, 2);
    env.burst.position.set(0, 1.1, 0.8);
    scene.add(env.burst);

    env.floorU = {
      uTime: U.time,
      uPulse: { value: 0.2 },
      uWave: { value: 0 },
      uWaveAmp: { value: 0 },
      uLine: { value: new THREE.Color('#c8ff2e') },
      uBase: { value: new THREE.Color('#06140f') },
    };
    const floor = (env.floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 96),
      new THREE.ShaderMaterial({ uniforms: env.floorU, vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, transparent: true, depthWrite: false }),
    ));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.42;
    scene.add(floor);

    env.ringMat = new THREE.MeshBasicMaterial({
      color: 0xc8ff2e,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const ring = (env.ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.1, 128), env.ringMat));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -1.41;
    scene.add(ring);

    // 경기장 조명 빛기둥
    env.beams = [];
    [
      [-2.9, 4.3, -2.4, 0.42, '#3ce6ff', 0.16],
      [2.9, 4.3, -2.4, -0.42, '#c8ff2e', 0.12],
      [0, 4.8, -3.8, 0, '#ffffff', 0.07],
    ].forEach(([x, y, z, rz, color, opacity]) => {
      const geo = new THREE.CylinderGeometry(0.04, 1.35, 8, 40, 1, true);
      geo.translate(0, -4, 0);
      const mat = glowMaterial(BEAM_FS, { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } }, { vs: BEAM_VS, side: THREE.DoubleSide });
      const beam = new THREE.Mesh(geo, mat);
      beam.position.set(x, y, z);
      beam.rotation.z = rz;
      beam.userData.rz = rz;
      scene.add(beam);
      env.beams.push(beam);
    });

    env.raysU = { uTime: U.time, uOpacity: { value: 0 }, uColor: { value: new THREE.Color('#ffc95a') } };
    env.rays = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), glowMaterial(RAYS_FS, env.raysU));
    env.rays.position.set(0, 0.05, -1.7);
    scene.add(env.rays);

    env.shockMat = new THREE.MeshBasicMaterial({
      color: 0xffd25e,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    env.shock = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 128), env.shockMat);
    env.shock.visible = false;
    scene.add(env.shock);

    // 떠다니는 먼지(경기장 조명 속 입자)
    const n = lowPower ? 120 : 420;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rand(-7, 7);
      pos[i * 3 + 1] = rand(-2.2, 5.2);
      pos[i * 3 + 2] = rand(-7, 2.5);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    env.dust = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: U.time,
          uScale: U.scale,
          uOpacity: { value: 0.75 },
          uColA: { value: new THREE.Color('#3ce6ff') },
          uColB: { value: new THREE.Color('#c8ff2e') },
        },
        vertexShader: DUST_VS,
        fragmentShader: DUST_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    env.dust.frustumCulled = false;
    scene.add(env.dust);
  }

  // 가운데가 볼록한 포일 봉투 면
  function pillow(w, hh, bulge) {
    const g = new THREE.PlaneGeometry(w, hh, 28, 34);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (w / 2);
      const y = p.getY(i) / (hh / 2);
      p.setZ(i, bulge * (1 - Math.pow(Math.abs(x), 2.6)) * (1 - Math.pow(Math.abs(y), 3.2)));
    }
    g.computeVertexNormals();
    return g;
  }

  // 팩 위·아래의 톱니 모양 접합부
  function crimpGeometry(w, hh, teeth) {
    const s = new THREE.Shape();
    const x0 = -w / 2;
    const zig = hh * 0.3;
    const stepW = w / teeth;
    s.moveTo(x0, 0);
    s.lineTo(-x0, 0);
    s.lineTo(-x0, hh - zig);
    for (let i = teeth; i > 0; i--) {
      const xr = x0 + i * stepW;
      s.lineTo(xr - stepW / 2, hh);
      s.lineTo(xr - stepW, hh - zig);
    }
    s.closePath();
    const g = new THREE.ShapeGeometry(s);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x0) / w, pos.getY(i) / hh);
    return g;
  }

  function packLogos() {
    return rows.map((r) => logoFor(r.name)).filter(Boolean);
  }

  function paintPackArt() {
    const { art, glow } = P.canvases;
    drawPackArt(art.getContext('2d'), glow.getContext('2d'), 512, 640, N, packLogos());
    P.frontMat.map.needsUpdate = true;
    P.frontMat.emissiveMap.needsUpdate = true;
  }

  function buildPack() {
    const { W, H, CH: CRH } = P;
    P.group = new THREE.Group();
    P.tiltG = new THREE.Group();
    P.group.add(P.tiltG);
    scene.add(P.group);

    const art = makeCanvas(512, 640);
    const glow = makeCanvas(512, 640);
    const backC = makeCanvas(384, 480);
    drawPackBack(backC.getContext('2d'), 384, 480);
    const crimpC = makeCanvas(256, 64);
    drawCrimp(crimpC.getContext('2d'), 256, 64);
    P.canvases = { art, glow, backC };

    P.frontMat = new THREE.MeshPhysicalMaterial({
      map: makeTexture(art, true),
      emissiveMap: makeTexture(glow, true),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.9,
      metalness: 0.6,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.14,
      iridescence: 0.85,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [160, 520],
      envMapIntensity: 1.15,
    });
    paintPackArt();
    const backMat = new THREE.MeshPhysicalMaterial({
      map: makeTexture(backC, true),
      metalness: 0.6,
      roughness: 0.35,
      clearcoat: 0.8,
      iridescence: 0.6,
      iridescenceIOR: 1.4,
      envMapIntensity: 1.0,
    });
    const front = new THREE.Mesh(pillow(W, H, 0.13), P.frontMat);
    const backGeo = pillow(W, H, 0.13);
    backGeo.rotateY(Math.PI);
    const back = new THREE.Mesh(backGeo, backMat);
    P.tiltG.add(front, back);

    const crimpTex = makeTexture(crimpC, true);
    crimpTex.wrapS = THREE.RepeatWrapping;
    crimpTex.repeat.set(3, 1);
    const crimpMat = new THREE.MeshStandardMaterial({ map: crimpTex, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide, envMapIntensity: 1.2 });
    const crimpGeo = crimpGeometry(W, CRH, 22);
    const bottomGeo = crimpGeo.clone();
    bottomGeo.rotateZ(Math.PI);
    const bottom = new THREE.Mesh(bottomGeo, crimpMat);
    bottom.position.y = -H / 2;
    P.tiltG.add(bottom);

    P.flapMat = crimpMat.clone();
    P.flapMat.transparent = true;
    P.flapPivot = new THREE.Group();
    P.flap = new THREE.Mesh(crimpGeo, P.flapMat);
    P.flapPivot.add(P.flap);
    P.tiltG.add(P.flapPivot);
    P.flapVel = new THREE.Vector3();
    P.flapSpin = new THREE.Vector3();
    resetFlap();

    P.seamU = { uColor: { value: new THREE.Color('#fff6d6') }, uOpacity: { value: 0 } };
    P.seam = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.05), glowMaterial(SEAM_FS, P.seamU));
    P.seam.position.set(0, H / 2, 0.03);
    P.tiltG.add(P.seam);

    P.tipU = { uColor: { value: new THREE.Color('#e9ff9a') }, uOpacity: { value: 0 } };
    P.tip = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), glowMaterial(GLOW_FS, P.tipU));
    P.tip.position.set(-W / 2, H / 2, 0.05);
    P.tiltG.add(P.tip);

    P.leakU = { uColor: { value: new THREE.Color('#ffe7a3') }, uOpacity: { value: 0 }, uP: { value: 0 }, uDir: { value: 1 } };
    P.leak = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.1, 0.7), glowMaterial(LEAK_FS, P.leakU));
    P.leak.position.set(0, H / 2, 0.04);
    P.tiltG.add(P.leak);

    P.fanU = { uColor: { value: new THREE.Color('#fff1c4') }, uOpacity: { value: 0 }, uTime: U.time };
    const fanGeo = new THREE.PlaneGeometry(3.4, 4.6);
    fanGeo.translate(0, 2.3, 0);
    P.fan = new THREE.Mesh(fanGeo, glowMaterial(FAN_FS, P.fanU, { side: THREE.DoubleSide }));
    P.fan.position.set(0, H / 2 - 0.05, -0.02);
    P.tiltG.add(P.fan);
  }

  function resetFlap() {
    const pivotX = P.dir > 0 ? P.W / 2 : -P.W / 2;
    P.flapPivot.position.set(pivotX, P.H / 2, 0);
    P.flapPivot.rotation.set(0, 0, 0);
    P.flap.position.set(-pivotX, 0, 0);
    P.flapMat.opacity = 1;
    P.flap.visible = true;
    P.flapFlying = false;
    P.flapVel.set(0, 0, 0);
    P.flapSpin.set(0, 0, 0);
  }

  /* ───────── 3D 축구공 ───────── */

  function buildBall() {
    const tex = makeCanvas(512, 256);
    drawBallTexture(tex.getContext('2d'), 512, 256);
    const mat = new THREE.MeshPhysicalMaterial({
      map: makeTexture(tex, true),
      roughness: 0.42,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.1,
    });
    BALL.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 48, 32), mat);
    BALL.mesh.rotation.set(0.4, 0.2, 0.1);
    BALL.vel = new THREE.Vector3();
    BALL.spin = new THREE.Vector3();
    scene.add(BALL.mesh);
  }

  // 공의 공전 궤도(팩 그림의 궤도 링과 같은 방향으로 기운 타원). 팩 크기를 따라 커지고 작아진다.
  function ballOrbitPos(a, out) {
    const s = L.packScale * P.scaleK;
    out.set(
      P.group.position.x + Math.cos(a) * 1.06 * s,
      P.group.position.y + (0.12 + Math.cos(a) * 0.2 + Math.sin(a) * 0.06) * s,
      Math.sin(a) * 0.58 * s,
    );
    return out;
  }

  function updateBall(dt) {
    const b = BALL;
    if (!b.mesh) return;
    if (b.mode === 'off') {
      b.mesh.visible = false;
      return;
    }
    b.mesh.visible = true;
    if (b.mode === 'orbit') {
      const speed = reduceMotion ? 0 : 0.85 + b.spinBoost;
      b.spinBoost = damp(b.spinBoost, 0, 1.4, dt);
      b.a += dt * speed;
      ballOrbitPos(b.a, b.mesh.position);
      b.mesh.scale.setScalar(Math.max(L.packScale * P.scaleK * b.k, 0.0001));
      if (!reduceMotion) {
        // 궤도를 따라 굴러가듯 회전
        b.mesh.rotation.y -= dt * speed * 2.4;
        b.mesh.rotation.x += dt * (0.5 + b.spinBoost * 2);
        b.trail += dt * (lowPower ? 16 : 34) * (1 + b.spinBoost);
        while (b.trail >= 1) {
          b.trail -= 1;
          const p = b.mesh.position;
          const c = PAL.trail[(Math.random() * PAL.trail.length) | 0];
          sparks.spawn(p.x + rand(-0.04, 0.04), p.y + rand(-0.04, 0.04), p.z, rand(-0.15, 0.15), rand(-0.05, 0.25), rand(-0.1, 0.1), c, rand(0.018, 0.04), rand(0.25, 0.5), 2.6, 0.2);
        }
      }
    } else if (b.mode === 'fly') {
      b.t += dt;
      b.vel.y -= 3.2 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
      const fade = 1 - clamp((b.t - 0.7) / 0.6, 0, 1);
      b.mesh.scale.setScalar(Math.max(L.packScale * fade, 0.0001));
      const p = b.mesh.position;
      for (let k = 0; k < (lowPower ? 2 : 3); k++) {
        const c = PAL.tear[(Math.random() * PAL.tear.length) | 0];
        sparks.spawn(p.x + rand(-0.05, 0.05), p.y + rand(-0.05, 0.05), p.z, rand(-0.2, 0.2), rand(-0.2, 0.2), rand(-0.2, 0.2), c, rand(0.025, 0.06) * fade, rand(0.3, 0.6), 2.2, -1);
      }
      if (fade <= 0) b.mode = 'off';
    }
  }

  // 개봉 순간: 공이 화면 위쪽(관객 쪽)으로 세게 차여 날아간다
  function kickBallAway() {
    const b = BALL;
    if (!b.mesh || b.mode !== 'orbit') return;
    b.mode = 'fly';
    b.t = 0;
    b.vel.set(-b.mesh.position.x * 0.8 + rand(-0.6, 0.6), 4.2, 2.4);
    b.spin.set(rand(8, 14), rand(-6, 6), rand(-6, 6));
  }

  // 봉인 상태에서 공을 탭하면 톡 차서 궤도를 빠르게 돈다
  function tapBall(cx, cy) {
    const b = BALL;
    // 팩 뒤로 돌아간 공은 가려져 있으니 그 자리를 탭하면 팩 뜯기로 처리한다
    if (!b.mesh || b.mode !== 'orbit' || !b.mesh.visible || b.mesh.position.z < 0.05) return false;
    V.ndc.set((cx / stageSize.w) * 2 - 1, -(cy / stageSize.h) * 2 + 1);
    raycaster.setFromCamera(V.ndc, camera);
    // 공이 작아서 손가락으로 맞히기 쉽게 판정 반경을 조금 키운다
    V.c.copy(b.mesh.position);
    const r = 0.15 * b.mesh.scale.x * 1.9;
    if (raycaster.ray.distanceSqToPoint(V.c) > r * r) return false;
    b.spinBoost = reduceMotion ? 0 : 4.5;
    if (!reduceMotion) {
      burst(b.mesh.position, { count: lowPower ? 36 : 90, colors: PAL.trail, speed: [0.8, 2.4], life: [0.3, 0.7], size: [0.02, 0.05], grav: -1, zBias: 0.4 });
    }
    haptic(14);
    kick(1500);
    return true;
  }

  /* ───────── 카드 ───────── */

  function roundedRectShape(w, hh, r) {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -hh / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + hh - r);
    s.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh);
    s.lineTo(x + r, y + hh);
    s.quadraticCurveTo(x, y + hh, x, y + hh - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  function cardUniforms(map, mask, rar, foil) {
    return {
      uMap: { value: map },
      uMask: { value: mask },
      uTime: U.time,
      uTilt: { value: new THREE.Vector2() },
      uFoil: { value: foil },
      uDim: { value: 1 },
      uGlow: { value: 0 },
      uTint: { value: new THREE.Color(rar.accent) },
    };
  }

  function lookOf(row) {
    const meta = metaFor(row.name);
    return { accent: meta?.accent || NEUTRAL.accent, base: meta?.base || NEUTRAL.base, logo: logoFor(row.name) };
  }

  // 카드 한 장의 앞·뒷면 그림을 지금 데이터로 다시 그린다
  function paintCard(c) {
    c.row = rows[c.index];
    c.rar = rarityOf(c.row);
    c.look = lookOf(c.row);
    c.perTeam = model.perTeam;
    c.fixtures = model.fixtures.get(c.row.no) || [];
    drawCardFront(c.canvases.front.getContext('2d'), c);
    drawCardFrontMask(c.canvases.frontMask.getContext('2d'), c);
    drawCardBack(c.canvases.back.getContext('2d'), c, logoFor, model.currentWeek);
    drawCardBackMask(c.canvases.backMask.getContext('2d'));
    for (const u of [c.uniF, c.uniB]) {
      u.uMap.value.needsUpdate = true;
      u.uMask.value.needsUpdate = true;
      u.uTint.value.set(c.rar.accent);
    }
    c.uniF.uFoil.value = c.rar.foil;
    c.uniB.uFoil.value = c.rar.foil * 0.5;
    c.edgeMat.color.set(c.rar.edge);
  }

  function buildCards() {
    if (!cardShared) {
      const shape = roundedRectShape(CARD.w, CARD.h, CARD.r);
      const faceGeo = new THREE.ShapeGeometry(shape, 10);
      const pos = faceGeo.attributes.position;
      const uv = faceGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + CARD.w / 2) / CARD.w, (pos.getY(i) + CARD.h / 2) / CARD.h);
      const backGeo = faceGeo.clone();
      backGeo.rotateY(Math.PI);
      const edgeGeo = new THREE.ExtrudeGeometry(shape, { depth: CARD.t, bevelEnabled: false, curveSegments: 10 });
      edgeGeo.translate(0, 0, -CARD.t / 2);
      cardShared = { faceGeo, backGeo, edgeGeo };
    }
    const { faceGeo, backGeo, edgeGeo } = cardShared;
    rows.forEach((row, i) => {
      const rar = rarityOf(row);
      const canvases = {
        front: makeCanvas(CW, CH),
        frontMask: makeCanvas(128, 192),
        back: makeCanvas(CW, CH),
        backMask: makeCanvas(128, 192),
      };
      const uniF = cardUniforms(makeTexture(canvases.front, true), makeTexture(canvases.frontMask, false), rar, rar.foil);
      const uniB = cardUniforms(makeTexture(canvases.back, true), makeTexture(canvases.backMask, false), rar, rar.foil * 0.5);
      const matF = new THREE.ShaderMaterial({ uniforms: uniF, vertexShader: CARD_VS, fragmentShader: CARD_FS });
      const matB = new THREE.ShaderMaterial({ uniforms: uniB, vertexShader: CARD_VS, fragmentShader: CARD_FS });
      const edgeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(rar.edge), metalness: 0.95, roughness: 0.26 });

      const group = new THREE.Group();
      const inner = new THREE.Group();
      group.add(inner);
      const edge = new THREE.Mesh(edgeGeo, edgeMat);
      const front = new THREE.Mesh(faceGeo, matF);
      front.position.z = CARD.t / 2 + 0.0015;
      const back = new THREE.Mesh(backGeo, matB);
      back.position.z = -CARD.t / 2 - 0.0015;
      inner.add(edge, front, back);
      for (const m of [edge, front, back]) {
        m.userData.cardIndex = i;
        pickables.push(m);
      }
      group.visible = false;
      scene.add(group);
      const c = { index: i, group, inner, row, rar, canvases, uniF, uniB, edgeMat, matF, matB, flip: 0, flipTarget: 0, intro: null, introK: 1, hideK: 0, active: false };
      paintCard(c);
      cards.push(c);
    });
  }

  function disposeCards() {
    for (const c of cards) {
      scene.remove(c.group);
      for (const u of [c.uniF, c.uniB]) {
        u.uMap.value.dispose();
        u.uMask.value.dispose();
      }
      c.matF.dispose();
      c.matB.dispose();
      c.edgeMat.dispose();
    }
    cards.length = 0;
    pickables.length = 0;
  }

  function repaintAll() {
    if (!sceneReady) return;
    for (const c of cards) paintCard(c);
    paintPackArt();
    kick(300);
  }

  /* ───────── 입자 ───────── */

  class SparkField {
    constructor(max) {
      this.max = max;
      this.cursor = 0;
      this.dirty = false;
      this.pos = new Float32Array(max * 3);
      this.vel = new Float32Array(max * 3);
      this.col = new Float32Array(max * 3);
      this.size = new Float32Array(max);
      this.size0 = new Float32Array(max);
      this.alpha = new Float32Array(max);
      this.life = new Float32Array(max);
      this.span = new Float32Array(max);
      this.drag = new Float32Array(max);
      this.grav = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
      this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
      this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
      this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this.aPos);
      geo.setAttribute('aColor', this.aCol);
      geo.setAttribute('aSize', this.aSize);
      geo.setAttribute('aAlpha', this.aAlpha);
      this.points = new THREE.Points(
        geo,
        new THREE.ShaderMaterial({
          uniforms: { uScale: U.scale },
          vertexShader: SPARK_VS,
          fragmentShader: SPARK_FS,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      this.points.frustumCulled = false;
    }

    spawn(x, y, z, vx, vy, vz, color, size, life, drag = 1.6, grav = -3) {
      const i = this.cursor;
      this.cursor = (i + 1) % this.max;
      const j = i * 3;
      this.pos[j] = x;
      this.pos[j + 1] = y;
      this.pos[j + 2] = z;
      this.vel[j] = vx;
      this.vel[j + 1] = vy;
      this.vel[j + 2] = vz;
      this.col[j] = color.r;
      this.col[j + 1] = color.g;
      this.col[j + 2] = color.b;
      this.size0[i] = size;
      this.size[i] = size;
      this.alpha[i] = 1;
      this.life[i] = life;
      this.span[i] = life;
      this.drag[i] = drag;
      this.grav[i] = grav;
      this.dirty = true;
    }

    update(dt) {
      if (!this.dirty) return;
      let alive = 0;
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) continue;
        this.life[i] -= dt;
        if (this.life[i] <= 0) {
          this.alpha[i] = 0;
          continue;
        }
        alive++;
        const j = i * 3;
        const k = Math.exp(-this.drag[i] * dt);
        this.vel[j] *= k;
        this.vel[j + 1] = this.vel[j + 1] * k + this.grav[i] * dt;
        this.vel[j + 2] *= k;
        this.pos[j] += this.vel[j] * dt;
        this.pos[j + 1] += this.vel[j + 1] * dt;
        this.pos[j + 2] += this.vel[j + 2] * dt;
        const t = this.life[i] / this.span[i];
        this.alpha[i] = Math.min(1, t * 2.5) * (0.75 + 0.25 * Math.sin(this.life[i] * 40 + i));
        this.size[i] = this.size0[i] * (0.35 + 0.65 * t);
      }
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aAlpha.needsUpdate = true;
      if (!alive) this.dirty = false;
    }
  }

  // 금속 색종이: 회전할 때 밝기가 바뀌어 반짝인다
  class Confetti {
    constructor(max) {
      this.max = max;
      this.active = false;
      const geo = new THREE.PlaneGeometry(0.05, 0.085);
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
      this.mesh = new THREE.InstancedMesh(geo, mat, max);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.visible = false;
      this.p = new Float32Array(max * 3);
      this.v = new Float32Array(max * 3);
      this.r = new Float32Array(max * 3);
      this.w = new Float32Array(max * 3);
      this.life = new Float32Array(max);
      this.span = new Float32Array(max);
      this.phase = new Float32Array(max);
      this.base = Array.from({ length: max }, () => new THREE.Color(1, 1, 1));
      this.dummy = new THREE.Object3D();
      this.tmp = new THREE.Color();
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      for (let i = 0; i < max; i++) {
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        this.mesh.setColorAt(i, this.tmp.setRGB(1, 1, 1));
      }
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }

    burst(o, n, colors) {
      const count = Math.min(n, this.max);
      for (let i = 0; i < count; i++) {
        const j = i * 3;
        const a = rand(0, Math.PI * 2);
        const sp = rand(1.2, 4.2);
        this.p[j] = o.x + rand(-0.4, 0.4);
        this.p[j + 1] = o.y + rand(-0.05, 0.15);
        this.p[j + 2] = o.z + rand(-0.1, 0.2);
        this.v[j] = Math.cos(a) * sp * 0.75;
        this.v[j + 1] = rand(2.6, 6.8);
        this.v[j + 2] = Math.sin(a) * sp * 0.5 + 0.7;
        for (let k = 0; k < 3; k++) {
          this.r[j + k] = rand(0, Math.PI * 2);
          this.w[j + k] = rand(-11, 11);
        }
        this.life[i] = this.span[i] = rand(1.9, 3.4);
        this.phase[i] = rand(0, Math.PI * 2);
        this.base[i].copy(colors[(Math.random() * colors.length) | 0]);
      }
      this.active = true;
      this.mesh.visible = true;
    }

    update(dt, time) {
      if (!this.active) return;
      let alive = 0;
      const d = this.dummy;
      const drag = Math.exp(-2.4 * dt);
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) continue;
        this.life[i] -= dt;
        const j = i * 3;
        if (this.life[i] <= 0) {
          d.scale.setScalar(0);
          d.updateMatrix();
          this.mesh.setMatrixAt(i, d.matrix);
          continue;
        }
        alive++;
        this.v[j] = this.v[j] * drag + Math.sin(time * 3 + this.phase[i]) * 1.1 * dt;
        this.v[j + 1] = this.v[j + 1] * drag - 3.4 * dt;
        this.v[j + 2] = this.v[j + 2] * drag;
        for (let k = 0; k < 3; k++) {
          this.p[j + k] += this.v[j + k] * dt;
          this.r[j + k] += this.w[j + k] * dt;
        }
        d.position.set(this.p[j], this.p[j + 1], this.p[j + 2]);
        d.rotation.set(this.r[j], this.r[j + 1], this.r[j + 2]);
        d.scale.setScalar(Math.min(1, (this.life[i] / this.span[i]) * 3));
        d.updateMatrix();
        this.mesh.setMatrixAt(i, d.matrix);
        const shine = Math.abs(Math.cos(this.r[j]) * Math.cos(this.r[j + 1]));
        this.tmp.copy(this.base[i]).multiplyScalar(0.35 + shine * 1.2);
        this.mesh.setColorAt(i, this.tmp);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      if (!alive) {
        this.active = false;
        this.mesh.visible = false;
      }
    }
  }

  function buildParticles() {
    sparks = new SparkField(lowPower ? 800 : 2400);
    scene.add(sparks.points);
    confetti = new Confetti(lowPower ? 80 : 220);
    scene.add(confetti.mesh);
  }

  function burst(o, { count, colors, speed = [2, 6], life = [0.8, 1.6], size = [0.03, 0.09], up = 0, drag = 1.6, grav = -3, zBias = 0.3 }) {
    for (let n = 0; n < count; n++) {
      let x = Math.random() * 2 - 1;
      let y = Math.random() * 2 - 1;
      let z = Math.random() * 2 - 1;
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y = y / l + up;
      z = (z / l) * 0.6 + zBias;
      const sp = rand(speed[0], speed[1]);
      const c = colors[(Math.random() * colors.length) | 0];
      sparks.spawn(o.x, o.y, o.z, x * sp, y * sp, z * sp, c, rand(size[0], size[1]), rand(life[0], life[1]), drag, grav);
    }
  }

  function shockwave(p, color) {
    env.shock.position.set(p.x, p.y, p.z - 0.25);
    env.shockMat.color.copy(color);
    env.shock.visible = true;
    tween(
      1.1,
      (k, raw) => {
        env.shock.scale.setScalar(0.3 + k * 4.4);
        env.shockMat.opacity = 0.9 * (1 - raw);
      },
      { done: () => (env.shock.visible = false) },
    );
  }

  /* ───────── 화면 크기·카메라 ───────── */

  // 화면 폭별 배치. 좁은·중간 화면은 제목이 위에 있으므로 팩을 조금 아래로,
  // 넓은 화면(900px~)은 제목이 왼쪽에 있으므로 팩을 오른쪽으로 비켜 둔다.
  const PACK_FRAME = {
    narrow: { hreq: 3.7, wreq: 2.0, lookY: 0.28 },
    mid: { hreq: 3.8, wreq: 2.6, lookY: 0.3 },
    wide: { hreq: 3.55, wreq: 2.6, lookY: 0.06 },
  };
  // 아주 낮은 무대(작은 폰을 카카오톡 안에서 볼 때 등): 제목을 숨기고(style.css data-tiny) 팩을 가운데에 두되,
  // 아래쪽 단추 줄(바로 열기, 약 62px)에 걸리지 않게 위아래를 비워 맞춘다.
  const TINY_STAGE = 340;
  const tinyFrame = { hreq: 3.7, wreq: 2.0, lookY: 0, forH: 0 };
  const packFrame = () => {
    const f = L.narrow ? PACK_FRAME.narrow : L.wide ? PACK_FRAME.wide : PACK_FRAME.mid;
    const hpx = stageSize.h;
    if (!L.narrow || !(hpx > 0 && hpx < TINY_STAGE)) return f;
    if (tinyFrame.forH !== hpx) {
      tinyFrame.forH = hpx;
      tinyFrame.wreq = f.wreq;
      tinyFrame.hreq = Math.max(f.hreq, (2.5 * hpx) / Math.max(hpx - 124, hpx * 0.45));
    }
    return tinyFrame;
  };

  function updateLayout(w, hh) {
    L.narrow = w < 640;
    L.wide = w >= 900;
    if (L.narrow) Object.assign(L, { xNear: 0.98, xFar: 0.3, zNear: 0.85, zFar: 0.4, rot: 1.05, visible: 3, packScale: 0.84 });
    else Object.assign(L, { xNear: 1.42, xFar: 0.62, zNear: 0.9, zFar: 0.42, rot: 0.82, visible: 4.2, packScale: 1 });
    const f = packFrame();
    const aspect = w / Math.max(hh, 1);
    const tanf = Math.tan((32 * Math.PI) / 360);
    const dist = Math.max(f.hreq / (2 * tanf), f.wreq / (2 * tanf * aspect));
    const halfW = dist * tanf * aspect;
    P.offsetX = L.wide ? clamp(halfW - 0.8 - 0.35, 0, 1.1) : 0;
  }

  function resize() {
    if (!renderer) return;
    const r = container.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const w = Math.round(r.width);
    const hh = Math.round(r.height);
    if (w === stageSize.w && hh === stageSize.h) return;
    stageSize.w = w;
    stageSize.h = hh;
    if (ui.state === 'sealed' && !dom.gesture.classList.contains('is-hot')) dom.gestureText.textContent = sealHint();
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    updateLayout(w, hh);
    // 낮은 무대: 가운데 카드 윗변이 안내 문구 자리(위에서 약 85px)에 닿으면 안내를 위쪽 단추 줄 자리로 옮긴다(style.css)
    const viewH = Math.max(carouselViewH(), ((L.narrow ? 1.92 : 4.9) * hh) / w);
    const cardTop = hh / 2 - (1.8 * 1.06 * hh) / viewH / 2;
    container.toggleAttribute('data-short', cardTop < 88);
    // 낮은 무대: 팩 위 제목을 줄이거나(data-low) 숨긴다(data-tiny, 위 packFrame)
    container.toggleAttribute('data-low', hh < 420);
    container.toggleAttribute('data-tiny', L.narrow && hh < TINY_STAGE);
    U.scale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    kick(300);
  }

  // 카드 보기의 세로 시야(월드 단위). 카드(높이 1.8)가 위쪽 단추 줄(번호·뒤집기)과 아래쪽 단추 줄(넘기기·번호)에
  // 걸리지 않도록, 무대가 낮을수록 위아래로 약 62px씩 비워 두고 맞춘다. 높은 무대는 예전처럼 2.4.
  function carouselViewH() {
    const hpx = Math.max(stageSize.h, 1);
    const reserve = 124;
    return Math.max(2.4, (1.8 * 1.04 * hpx) / Math.max(hpx - reserve, hpx * 0.45));
  }

  function updateCamera(dt) {
    const aspect = stageSize.w > 0 && stageSize.h > 0 ? stageSize.w / stageSize.h : 1;
    const tanf = Math.tan((camera.fov * Math.PI) / 360);
    const f = packFrame();
    const hreq = lerp(f.hreq, carouselViewH(), frameK);
    const wreq = lerp(f.wreq, L.narrow ? 1.92 : 4.9, frameK);
    const dist = Math.max(hreq / (2 * tanf), wreq / (2 * tanf * aspect));
    const lookY = lerp(f.lookY, 0.0, frameK);
    const mouse = ptr.type === 'mouse' && !reduceMotion;
    par.x = damp(par.x, mouse ? ptr.nx * 0.22 : 0, 3, dt);
    par.y = damp(par.y, mouse ? ptr.ny * 0.12 : 0, 3, dt);
    shakeAmp *= Math.exp(-dt * 7);
    const sx = (Math.random() - 0.5) * shakeAmp;
    const sy = (Math.random() - 0.5) * shakeAmp;
    camera.position.set(par.x + sx, lookY + 0.34 - par.y + sy, dist);
    camera.lookAt(sx * 0.3, lookY, 0);
    camera.updateMatrixWorld();
  }

  function shake(a) {
    if (!reduceMotion) shakeAmp = Math.max(shakeAmp, a);
  }

  /* ───────── 팩 ───────── */

  function setTear(p) {
    P.progress = clamp(p, 0, 1);
    if (P.progress > 0 && ui.state === 'sealed') {
      dom.gesture.classList.add('is-hot');
      dom.gestureText.textContent = P.progress < 1 ? (narrowUI() ? '조금만 더! 끝까지' : '조금만 더! 끝까지 밀어 주세요') : '열린다!';
    }
  }

  function packTopWorld(out) {
    P.group.updateMatrixWorld(true);
    out.set(0, P.H / 2 + 0.05, 0.05);
    return P.tiltG.localToWorld(out);
  }

  function updatePack(dt) {
    if (!P.group.visible) return;
    const sealed = ui.state === 'sealed';
    const idle = sealed && !reduceMotion ? 1 : 0;
    P.shown = damp(P.shown, P.progress, reduceMotion ? 40 : 12, dt);
    const s = P.shown;

    const ty = (Math.sin(sim.t * 0.55) * 0.24 * idle + (sealed ? tilt.y * 0.55 : 0)) * (1 - P.settle);
    const tx = (Math.sin(sim.t * 0.8) * 0.05 * idle + (sealed ? tilt.x * 0.3 : 0)) * (1 - P.settle);
    P.tiltG.rotation.y = damp(P.tiltG.rotation.y, ty, 5, dt);
    P.tiltG.rotation.x = damp(P.tiltG.rotation.x, tx, 5, dt);
    P.tiltG.position.y = Math.sin(sim.t * 1.3) * 0.06 * idle;
    P.tiltG.position.x = ptr.mode === 'tear' && !reduceMotion ? (Math.random() - 0.5) * 0.012 * (0.4 + s) : 0;
    P.group.scale.setScalar(Math.max(L.packScale * P.scaleK, 0.0001));
    P.group.position.x = P.offsetX;
    P.group.position.y = -P.sinkK * 1.3;
    env.burst.position.x = P.offsetX;

    const start = -P.dir * (P.W / 2);
    P.seam.scale.x = Math.max(s * P.W, 0.0001);
    P.seam.position.x = start + P.dir * s * (P.W / 2);
    P.tip.position.x = start + P.dir * s * P.W;
    P.leakU.uP.value = s;
    P.leakU.uDir.value = P.dir;
    if (sealed) {
      P.seamU.uOpacity.value = s > 0.002 ? 0.6 + s * 0.8 : 0;
      P.tipU.uOpacity.value = s > 0.002 && s < 0.995 ? 0.9 + 0.3 * Math.sin(sim.t * 30) : 0;
      P.tip.scale.setScalar(0.8 + 0.2 * Math.sin(sim.t * 22));
      P.leakU.uOpacity.value = s * 1.2;
      P.fanU.uOpacity.value = s * 0.35;
      env.burst.intensity = s * 8;
      if (!P.flapFlying) P.flapPivot.rotation.z = -P.dir * s * 0.16;
      const adv = s - P.lastShown;
      if (adv > 0.0005 && !reduceMotion) {
        P.tiltG.updateWorldMatrix(true, false);
        V.c.set(P.tip.position.x, P.H / 2, 0.05);
        P.tiltG.localToWorld(V.c);
        const n = Math.min(lowPower ? 16 : 26, Math.ceil(adv * 520));
        for (let k = 0; k < n; k++) {
          const c = PAL.tear[(Math.random() * PAL.tear.length) | 0];
          sparks.spawn(V.c.x, V.c.y, V.c.z, rand(-0.8, 0.8) - P.dir * 0.6, rand(0.4, 2.4), rand(0.2, 1.4), c, rand(0.025, 0.06), rand(0.35, 0.8), 2.2, -4);
        }
      }
    }
    P.lastShown = s;

    if (P.flapFlying) {
      P.flapVel.y -= 6 * dt;
      P.flapPivot.position.addScaledVector(P.flapVel, dt);
      P.flapPivot.rotation.x += P.flapSpin.x * dt;
      P.flapPivot.rotation.y += P.flapSpin.y * dt;
      P.flapPivot.rotation.z += P.flapSpin.z * dt;
      P.flapMat.opacity = Math.max(0, P.flapMat.opacity - dt * 1.1);
      if (P.flapMat.opacity <= 0) {
        P.flap.visible = false;
        P.flapFlying = false;
      }
    }
  }

  // 탭할 때마다 3분의 1씩 뜯긴다(세 번이면 열림). 화면의 뜯긴 선은 updatePack이 부드럽게 따라간다.
  function tapPack() {
    if (ui.state !== 'sealed') return;
    hideTearHint();
    haptic(12);
    kick(1200);
    if (!reduceMotion) {
      tween(
        0.32,
        (k) => {
          const sq = Math.sin(k * Math.PI);
          P.tiltG.scale.set(1 + sq * 0.04, 1 - sq * 0.05, 1);
        },
        { ease: linear, done: () => P.tiltG.scale.set(1, 1, 1) },
      );
    }
    setTear(Math.min(1, P.progress + 0.34));
    if (P.progress >= 0.999 && !P.openQueued) {
      P.openQueued = true;
      after(reduceMotion ? 0 : 0.22, () => {
        P.openQueued = false;
        openPack();
      });
    }
  }

  function openPack() {
    if (ui.state !== 'sealed' || !sceneReady) return;
    setState('opening');
    cb.open();
    hideTearHint();
    ui.pendingOpen = false;
    P.progress = 1;
    P.shown = 1;
    const target = ui.pendingFocus ?? 0;
    car.pos = car.target = 0;
    ui.focus = 0;
    ui.live = 0;
    ui.pendingFocus = target;
    syncDots(0);
    kick(6000);
    if (reduceMotion) {
      flash(0.3, 300);
      P.group.visible = false;
      BALL.mode = 'off';
      frameK = 1;
      raysOn = true;
      finishOpen();
      return;
    }
    haptic([24, 40, 36]);
    const top = packTopWorld(V.a).clone();
    kickBallAway();

    // 1) 뚜껑이 뜯겨 날아가고, 빛과 입자가 터진다
    P.flapFlying = true;
    P.flapVel.set(P.dir * 1.6, 3.8, 0.9);
    P.flapSpin.set(2.2, P.dir * 1.6, -P.dir * 5.0);
    flash(0.9, 760);
    shake(0.12);
    burst(top, {
      count: lowPower ? 340 : 1100,
      colors: PAL.open,
      speed: [1.8, 6.8],
      life: [0.8, 1.9],
      size: [0.03, 0.1],
      up: 0.55,
      drag: 1.5,
      grav: -2.6,
    });
    confetti.burst(top, lowPower ? 80 : 220, PAL.confetti);
    tween(0.3, (k) => (P.settle = k));
    tween(1.5, (k, raw) => (env.burst.intensity = 70 * Math.pow(1 - raw, 2)), { ease: linear });
    tween(
      1.7,
      (k, raw) => {
        P.fanU.uOpacity.value = 1.6 * Math.sin(Math.PI * Math.min(raw * 1.15, 1));
        P.fan.scale.set(1, 0.3 + raw * 0.9, 1);
      },
      { ease: linear },
    );
    tween(0.35, (k) => {
      P.leakU.uOpacity.value = 1.2 * (1 - k);
      P.seamU.uOpacity.value = 1.4 * (1 - k);
      P.tipU.uOpacity.value = 0;
    });
    tween(1.6, (k) => {
      env.floorU.uWave.value = k * 5.5;
      env.floorU.uWaveAmp.value = 1 - k;
    });
    tween(2.0, (k) => (frameK = k), { delay: 0.3, ease: easeInOutCubic });

    // 2) 카드가 아래 순위부터 하나씩 솟아 제자리로 날아간다
    const startY = (P.H / 2) * L.packScale - CARD.h * 0.39 - 0.08;
    const from = new THREE.Vector3(P.offsetX, startY, 0);
    const order = [];
    for (let i = N - 1; i >= 1; i--) order.push(i);
    order.forEach((i, j) => startIntro(i, { delay: 0.35 + j * 0.1, dur: 1.05, from, rise: 1.9 }));

    // 3) 마지막으로 1위 카드가 금빛과 함께 등장
    const leadDelay = 0.35 + order.length * 0.1 + 0.3;
    if (N > 0) startIntro(0, { delay: leadDelay, dur: 1.6, from, rise: 2.3, spin: 1, lead: true });
    after(leadDelay + 0.78, leaderMoment);
    tween(
      0.8,
      (k) => {
        P.scaleK = 1 - k;
        P.sinkK = k;
      },
      { delay: leadDelay + 0.45, ease: easeInBack, done: () => (P.group.visible = false) },
    );
    after(leadDelay + 1.8, finishOpen);
  }

  function startIntro(i, { delay, dur, from, rise, spin = 0, lead = false }) {
    const c = cards[i];
    if (!c) return;
    c.intro = { from: from.clone(), rise, spin, lead };
    c.introK = 0;
    c.hideK = 0;
    c.active = false;
    c.flip = 0;
    c.flipTarget = 0;
    tween(
      dur,
      (k) => {
        c.introK = k;
        c.active = true;
      },
      {
        delay,
        ease: lead ? easeInOutCubic : easeOutCubic,
        done: () => {
          c.introK = 1;
          c.intro = null;
        },
      },
    );
  }

  function leaderMoment() {
    const lead = cards[0];
    raysOn = true;
    if (!lead) return;
    const p = lead.group.position.clone();
    burst(p, {
      count: lowPower ? 220 : 720,
      colors: RAR_C[lead.rar.key].spark,
      speed: [1.4, 5.6],
      life: [0.8, 1.8],
      size: [0.03, 0.09],
      up: 0.15,
      drag: 1.7,
      grav: -1.4,
      zBias: 0.5,
    });
    shockwave(p, RAR_C[lead.rar.key].ray);
    flash(0.35, 520);
    shake(0.06);
    haptic(30);
  }

  function finishOpen() {
    if (ui.state !== 'opening') return;
    P.group.visible = false;
    for (const c of cards) {
      c.active = true;
      c.intro = null;
      c.introK = 1;
    }
    frameK = 1;
    raysOn = true;
    setState('carousel');
    const target = ui.pendingFocus ?? 0;
    ui.pendingFocus = null;
    ui.pendingOpen = false;
    setFocus(target, { silent: true });
    showCarouselHint();
  }

  // 다시 찾아온 사람·움직임 줄이기: 팩 없이 카드만 아래에서 올라온다
  function enterDealt() {
    setState('opening');
    P.group.visible = false;
    BALL.mode = 'off';
    frameK = 1;
    raysOn = true;
    ui.pendingFocus = ui.pendingFocus ?? ui.focus;
    car.pos = car.target = ui.pendingFocus;
    if (reduceMotion) {
      finishOpen();
      return;
    }
    const slotOut = {};
    cards.forEach((c, i) => {
      slot(i - car.pos, slotOut);
      startIntro(i, { delay: 0.2 + i * 0.07, dur: 0.95, from: new THREE.Vector3(slotOut.x, -2.6, slotOut.z + 0.3), rise: 1.4 });
    });
    after(0.2 + N * 0.07 + 0.95, finishOpen);
  }

  function resetPack() {
    if (ui.state !== 'carousel' || !sceneReady) return;
    setState('opening');
    for (const c of cards) c.flipTarget = 0;
    if (ui.flipped >= 0 && rows[ui.flipped]) cb.flip(rows[ui.flipped].no, false);
    ui.flipped = -1;
    syncFlipBtn();
    raysOn = false;
    kick(3000);
    const rm = reduceMotion;
    cards.forEach((c, i) => {
      tween(rm ? 0.05 : 0.5, (k) => (c.hideK = k), {
        delay: rm ? 0 : i * 0.03,
        ease: easeInCubic,
        done: () => {
          c.active = false;
          c.hideK = 0;
        },
      });
    });
    P.progress = 0;
    P.shown = 0;
    P.lastShown = 0;
    P.dir = 1;
    P.settle = 0;
    P.sinkK = 0;
    P.scaleK = 0.0001;
    resetFlap();
    P.seamU.uOpacity.value = 0;
    P.leakU.uOpacity.value = 0;
    P.fanU.uOpacity.value = 0;
    P.fan.scale.set(1, 1, 1);
    P.group.visible = true;
    BALL.mode = 'orbit';
    BALL.k = 0;
    BALL.spinBoost = rm ? 0 : 3;
    tween(rm ? 0.05 : 0.9, (k) => (P.scaleK = Math.max(k, 0.0001)), { delay: rm ? 0 : 0.35, ease: rm ? linear : easeOutBack });
    tween(rm ? 0.05 : 0.7, (k) => (BALL.k = k), { delay: rm ? 0 : 0.9, ease: rm ? linear : easeOutBack });
    tween(rm ? 0.05 : 1.0, (k) => (frameK = 1 - k), { ease: easeInOutCubic });
    after(rm ? 0.1 : 1.05, () => {
      setState('sealed');
      car.pos = car.target = 0;
      ui.focus = 0;
      ui.live = 0;
      syncDots(0);
      dom.gesture.classList.remove('is-hot');
      dom.gestureText.textContent = sealHint();
      dom.tearGuide.classList.add('is-on');
      // 다시 봉인되는 사이에 순위표에서 팀을 골랐다면 바로 연다
      if (ui.pendingOpen || ui.pendingFocus != null) openPack();
    });
  }

  /* ───────── 카드 캐러셀 ───────── */

  function slot(d, o) {
    const ad = Math.abs(d);
    const sg = Math.sign(d);
    const near = Math.min(ad, 1);
    const far = Math.max(ad - 1, 0);
    o.x = sg * (near * L.xNear + far * L.xFar);
    o.y = 0;
    o.z = -near * L.zNear - far * L.zFar;
    o.ry = -sg * near * L.rot;
    o.s = ad > L.visible ? Math.max(0, 1 - (ad - L.visible) / 0.8) : 1;
    o.ad = ad;
    return o;
  }

  const tmpSlot = {};
  function updateCards(dt) {
    const rm = reduceMotion;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      slot(i - car.pos, tmpSlot);
      c.flip = damp(c.flip, c.flipTarget, rm ? 30 : 8, dt);
      const focusW = Math.max(0, 1 - tmpSlot.ad);
      const lift = Math.sin(c.flip * Math.PI) * 0.4;
      let x = tmpSlot.x;
      let y = tmpSlot.y + (rm ? 0 : Math.sin(sim.t * 1.1 + i * 0.9) * 0.025);
      // 길게 눌러 살펴보기(inspect): 가운데 카드가 앞으로 떠오르고 크게 기운다
      const insp = inspectK * focusW;
      let z = tmpSlot.z + lift + focusW * 0.08 + insp * 0.32;
      let ry = tmpSlot.ry;
      let s = tmpSlot.s * (1 + insp * 0.05);
      if (c.intro && c.introK < 1) {
        const k = c.introK;
        const f = c.intro.from;
        const cx = f.x + (x - f.x) * 0.15;
        const cy = f.y + c.intro.rise;
        const cz = f.z + (c.intro.lead ? 1.1 : 0.35);
        const a = (1 - k) * (1 - k);
        const b = 2 * (1 - k) * k;
        const q = k * k;
        x = a * f.x + b * cx + q * x;
        y = a * f.y + b * cy + q * y;
        z = a * f.z + b * cz + q * z;
        ry = ry * k + c.intro.spin * Math.PI * 2 * (1 - k);
        s = lerp(0.78, s, k);
      }
      if (c.hideK > 0) {
        y -= c.hideK * 2.4;
        s *= 1 - c.hideK;
      }
      c.group.visible = c.active && s > 0.002;
      if (!c.group.visible) continue;
      c.group.position.set(x, y, z);
      c.group.rotation.set(0, ry, 0);
      c.group.scale.setScalar(Math.max(s, 0.0001));
      const tX = tilt.x * focusW;
      const tY = tilt.y * focusW;
      c.inner.rotation.set(tX * 0.35, c.flip * Math.PI + tY * 0.5, 0);
      const wob = rm ? 0 : 1;
      const hx = ry + tY * 0.9 + tilt.gx + Math.sin(sim.t * 0.6 + i) * 0.12 * wob;
      const hy = tX * 0.9 + tilt.gy + Math.cos(sim.t * 0.5 + i * 1.7) * 0.08 * wob;
      c.uniF.uTilt.value.set(hx, hy);
      c.uniB.uTilt.value.set(hx, hy);
      const dim = (1 - Math.min(tmpSlot.ad, 1) * 0.42 - Math.min(Math.max(tmpSlot.ad - 1, 0), 3) * 0.08) * (1 - inspectK * (1 - focusW) * 0.4);
      c.uniF.uDim.value = dim;
      c.uniB.uDim.value = dim;
      const glow = focusW * (0.3 + (rm ? 0.2 : 0.2 + 0.2 * Math.sin(sim.t * 2.2))) + insp * 0.35;
      c.uniF.uGlow.value = glow;
      c.uniB.uGlow.value = glow;
    }
  }

  function setFocus(i, { silent = false } = {}) {
    if (!N) return;
    const idx = clamp(Math.round(i), 0, N - 1);
    if (ui.flipped >= 0 && ui.flipped !== idx) {
      if (cards[ui.flipped]) cards[ui.flipped].flipTarget = 0;
      if (rows[ui.flipped]) cb.flip(rows[ui.flipped].no, false);
      ui.flipped = -1;
    }
    ui.focus = idx;
    ui.live = idx;
    car.target = idx;
    syncDots(idx);
    syncFlipBtn();
    cb.select(rows[idx].no, { silent });
    kick(1500);
  }

  function goTo(i) {
    if (ui.state !== 'carousel') return;
    setFocus(i);
  }

  function step1(dir) {
    if (ui.state !== 'carousel') return;
    const next = ui.focus + dir;
    if (next < 0 || next > N - 1) {
      car.pos += dir * 0.18;
      kick(800);
      return;
    }
    goTo(next);
  }

  function syncFlipBtn() {
    const on = ui.flipped >= 0 && ui.flipped === ui.focus;
    dom.flipBtn.setAttribute('aria-pressed', String(on));
    dom.flipBtn.textContent = on ? '앞면 보기' : '뒤집기';
  }

  function toggleFlip(i) {
    const c = cards[i];
    if (!c || ui.state !== 'carousel') return;
    if (i !== ui.focus) {
      goTo(i);
      return;
    }
    c.flipTarget = c.flipTarget > 0.5 ? 0 : 1;
    ui.flipped = c.flipTarget ? i : -1;
    if (!reduceMotion) {
      burst(c.group.position, { count: lowPower ? 44 : 120, colors: RAR_C[c.rar.key].spark, speed: [0.8, 2.6], life: [0.4, 0.9], size: [0.02, 0.05], grav: -1, zBias: 0.6 });
    }
    haptic(10);
    syncFlipBtn();
    cb.flip(rows[i].no, !!c.flipTarget);
    kick(1600);
  }

  // 안내 문구 두 단계: 넘기기·뒤집기 → 홀로그램 기울이기 → 사라짐
  // 안내 문구 보이기·숨기기. data-hint: 낮은 무대에서 안내가 위쪽 단추 줄 자리를 잠깐 빌리는 동안(style.css)
  function setHint(on) {
    dom.carouselHint.classList.toggle('is-gone', !on);
    container.toggleAttribute('data-hint', on);
  }

  function showCarouselHint() {
    dom.carouselHint.textContent = CAROUSEL_HINTS[0];
    setHint(true);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      dom.carouselHint.textContent = CAROUSEL_HINTS[1];
      hintTimer = setTimeout(() => setHint(false), 4200);
    }, 4200);
  }

  function hideTearHint() {
    dom.tearGuide.classList.remove('is-on');
  }

  function positionTearGuide() {
    P.tiltG.updateWorldMatrix(true, false);
    V.a.set(-P.W / 2, P.H / 2, 0.02);
    V.b.set(P.W / 2, P.H / 2, 0.02);
    P.tiltG.localToWorld(V.a).project(camera);
    P.tiltG.localToWorld(V.b).project(camera);
    const ax = ((V.a.x + 1) / 2) * stageSize.w;
    const ay = ((1 - V.a.y) / 2) * stageSize.h;
    const bx = ((V.b.x + 1) / 2) * stageSize.w;
    const by = ((1 - V.b.y) / 2) * stageSize.h;
    const len = Math.hypot(bx - ax, by - ay);
    P.seamPx = Math.max(len, 1);
    dom.tearGuide.style.width = `${len.toFixed(1)}px`;
    dom.tearGuide.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px) rotate(${Math.atan2(by - ay, bx - ax).toFixed(4)}rad)`;
  }

  /* ───────── 주변 연출 ───────── */

  function updateEnv(dt) {
    const row = rows[ui.live];
    const rar = row ? rarityOf(row) : RARITY.neon;
    const target = raysOn && ui.state !== 'sealed' ? rar.rays : 0;
    env.raysU.uOpacity.value = damp(env.raysU.uOpacity.value, target, 3, dt);
    env.raysU.uColor.value.lerp(RAR_C[rar.key].ray, 1 - Math.exp(-dt * 4));
    env.rays.visible = env.raysU.uOpacity.value > 0.003;
    if (!reduceMotion) env.rays.rotation.z += dt * 0.04;
    env.beams.forEach((b, i) => {
      b.rotation.z = b.userData.rz + (reduceMotion ? 0 : Math.sin(sim.t * 0.35 + i * 2.1) * 0.12);
    });
    env.ringMat.opacity = 0.45 + (reduceMotion ? 0 : 0.2 * Math.sin(sim.t * 2.0));
    env.floor.position.x = P.offsetX * (1 - frameK);
    env.ring.position.x = P.offsetX * (1 - frameK);
    env.floorU.uPulse.value = 0.2 + (ui.state === 'carousel' ? 0.15 : 0);
  }

  /* ───────── 루프 ───────── */

  function shouldRun() {
    return sceneReady && !destroyed && !paused && inView && !document.hidden;
  }

  function updateRun() {
    if (shouldRun()) {
      if (!running) {
        running = true;
        lastNow = performance.now();
        rafId = requestAnimationFrame(frame);
      }
    } else if (running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  function kick(ms = 800) {
    activeUntil = Math.max(activeUntil, performance.now() + ms);
    updateRun();
  }

  // 손가락·트윈·타이머·폭죽·넘기기·뒤집기 중 아직 움직이는 것이 있는지(공 꼬리 같은 주변 입자는 빼고)
  function moving() {
    if (ptr.down || tweens.length || timers.length || confetti.active) return true;
    if (Math.abs(car.pos - car.target) > 0.0005) return true;
    return !cards.every((c) => Math.abs(c.flip - c.flipTarget) < 0.001);
  }

  function settled() {
    return !moving() && !sparks.dirty;
  }

  function frame(now) {
    if (!running) return;
    // 손대지 않은 채 4초가 지나고 움직이던 것(트윈·폭죽·넘기기·뒤집기)도 다 멈췄으면 주변 연출(반짝임·도는 공)만 남는다:
    // 초당 30장, 20초가 넘으면 20장만 그린다. 입력이 오면(kick) 바로 제 속도로 돌아온다.
    const idleFor = now - activeUntil;
    if (!reduceMotion && idleFor > IDLE_AFTER_MS && now - lastNow < (idleFor > IDLE_LONG_MS ? 47 : 31) && !moving()) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(Math.max((now - lastNow) / 1000, 0), 0.05);
    lastNow = now;
    step(dt);
    renderer.render(scene, camera);
    // 움직임 줄이기: 할 일이 끝나면 루프를 멈추고, 입력이 오면 다시 깨운다
    if (reduceMotion && now > activeUntil && settled()) {
      running = false;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function step(dt) {
    sim.t += dt;
    if (!reduceMotion) U.time.value = sim.t;
    stepTweens(dt);

    inspectK = damp(inspectK, ptr.mode === 'inspect' ? 1 : 0, reduceMotion ? 30 : 10, dt);
    const tgtY = ptr.nx * (0.5 + inspectK * 0.45);
    const tgtX = ptr.ny * (0.4 + inspectK * 0.4);
    tilt.y = damp(tilt.y, tgtY, 6, dt);
    tilt.x = damp(tilt.x, tgtX, 6, dt);
    tilt.gx = damp(tilt.gx, reduceMotion ? 0 : tilt.gtx, 4, dt);
    tilt.gy = damp(tilt.gy, reduceMotion ? 0 : tilt.gty, 4, dt);

    if (!car.dragging) {
      car.pos = damp(car.pos, car.target, reduceMotion ? 24 : 8, dt);
      if (Math.abs(car.pos - car.target) < 0.0005) car.pos = car.target;
    }
    if (ui.state === 'carousel' && N) {
      const li = clamp(Math.round(car.pos), 0, N - 1);
      if (li !== ui.live) {
        ui.live = li;
        syncDots(li);
        if (ptr.mode === 'swipe' && ptr.type !== 'mouse') haptic(5);
      }
    }

    updateCamera(dt);
    updatePack(dt);
    updateBall(dt);
    updateCards(dt);
    updateEnv(dt);
    sparks.update(dt);
    confetti.update(dt, sim.t);
    if (ui.state === 'sealed' && P.group.visible) positionTearGuide();
  }

  /* ───────── 입력 ───────── */

  function updatePointer(e) {
    const r = container.getBoundingClientRect();
    ptr.cx = e.clientX - r.left;
    ptr.cy = e.clientY - r.top;
    ptr.nx = clamp((ptr.cx / Math.max(r.width, 1)) * 2 - 1, -1, 1);
    ptr.ny = clamp((ptr.cy / Math.max(r.height, 1)) * 2 - 1, -1, 1);
    ptr.type = e.pointerType || 'mouse';
  }

  function rubber(v) {
    if (v < 0) return v * 0.35;
    if (v > N - 1) return N - 1 + (v - (N - 1)) * 0.35;
    return v;
  }

  function pxPerCard() {
    return Math.max(120, stageSize.w * (L.narrow ? 0.5 : 0.22));
  }

  function pickCard(cx, cy) {
    V.ndc.set((cx / stageSize.w) * 2 - 1, -(cy / stageSize.h) * 2 + 1);
    raycaster.setFromCamera(V.ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    for (const hit of hits) {
      const idx = hit.object.userData.cardIndex;
      if (idx != null && cards[idx] && cards[idx].group.visible) return idx;
    }
    return -1;
  }

  function trail(cx, cy) {
    if (reduceMotion) return;
    V.ndc.set((cx / stageSize.w) * 2 - 1, -(cy / stageSize.h) * 2 + 1);
    raycaster.setFromCamera(V.ndc, camera);
    if (!raycaster.ray.intersectPlane(V.plane, V.c)) return;
    for (let k = 0; k < (lowPower ? 1 : 2); k++) {
      const c = PAL.trail[(Math.random() * PAL.trail.length) | 0];
      sparks.spawn(V.c.x + rand(-0.03, 0.03), V.c.y + rand(-0.03, 0.03), V.c.z, rand(-0.3, 0.3), rand(0.1, 0.6), rand(-0.1, 0.3), c, rand(0.02, 0.045), rand(0.3, 0.6), 2.4, 0.3);
    }
  }

  function onDown(e) {
    if (!sceneReady || !e.isPrimary) return;
    if (e.target.closest('button, a')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    updatePointer(e);
    kick(1200);
    ptr.down = true;
    ptr.id = e.pointerId;
    ptr.x0 = e.clientX;
    ptr.y0 = e.clientY;
    ptr.t0 = performance.now();
    ptr.mode = null;
    ptr.lastX = e.clientX;
    ptr.lastT = ptr.t0;
    ptr.vx = 0;
    ptr.pos0 = car.pos;
    ptr.tear0 = P.progress;
    try {
      container.setPointerCapture(e.pointerId);
    } catch {
      /* 무시 */
    }
    // 터치: 가운데 카드를 길게 누르면 살펴보기 모드(손가락 위치로 카드·홀로그램이 크게 기운다)
    clearTimeout(holdTimer);
    if (e.pointerType !== 'mouse' && ui.state === 'carousel') holdTimer = setTimeout(tryInspect, HOLD_MS);
  }

  function tryInspect() {
    if (!ptr.down || ptr.mode || ui.state !== 'carousel') return;
    const hit = pickCard(ptr.cx, ptr.cy);
    if (hit < 0 || hit !== ui.focus || Math.abs(car.pos - hit) > 0.35) return;
    ptr.mode = 'inspect';
    ptr.inspectAt = performance.now();
    haptic(8);
    kick(1500);
    // 숨은 기능을 찾았으니 안내는 거둔다
    clearTimeout(hintTimer);
    setHint(false);
  }

  function onMove(e) {
    if (!sceneReady) return;
    if (e.pointerType === 'mouse' || ptr.down) updatePointer(e);
    kick(600);
    if (!ptr.down || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.x0;
    const dy = e.clientY - ptr.y0;
    // 화면이 버벅여 길게 누르기 타이머가 먼저 돌았어도, 실제로는 그 전에 손가락이 움직였다면 보통 제스처로 되돌린다
    if (ptr.mode === 'inspect' && e.timeStamp && e.timeStamp < ptr.inspectAt - 30 && Math.hypot(dx, dy) > 8) ptr.mode = null;
    // 살펴보기 중이라도 손가락을 위아래로 뚜렷하게 움직이면 페이지 스크롤로 넘긴다(touchmove가 막지 않는다).
    // 잠깐 멈췄다가 스크롤하는 손짓이 카드에 붙잡히지 않게.
    if (ptr.mode === 'inspect' && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.5) ptr.mode = 'none';
    if (!ptr.mode) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        if (ui.state === 'sealed') {
          ptr.mode = 'tear';
          if (P.progress <= 0.0001) {
            P.dir = dx > 0 ? 1 : -1;
            resetFlap();
          }
          hideTearHint();
        } else if (ui.state === 'carousel') {
          ptr.mode = 'swipe';
          car.dragging = true;
          if (dom.carouselHint.textContent === CAROUSEL_HINTS[0]) {
            clearTimeout(hintTimer);
            dom.carouselHint.textContent = CAROUSEL_HINTS[1];
            hintTimer = setTimeout(() => setHint(false), 3600);
          }
        } else {
          ptr.mode = 'none';
        }
      } else if (Math.abs(dy) > 10) {
        ptr.mode = 'none';
      }
    }
    const now = performance.now();
    const dtm = Math.max(now - ptr.lastT, 1);
    ptr.vx = ptr.vx * 0.6 + ((e.clientX - ptr.lastX) / dtm) * 0.4;
    ptr.lastX = e.clientX;
    ptr.lastT = now;
    if (ptr.mode === 'tear') {
      const travel = Math.max(dx * P.dir, 0);
      setTear(ptr.tear0 + travel / Math.max(P.seamPx * 0.85, 120));
      if (P.progress >= 1) {
        ptr.mode = 'none';
        openPack();
      }
    } else if (ptr.mode === 'swipe') {
      car.pos = rubber(ptr.pos0 - dx / pxPerCard());
    }
    if (ptr.mode === 'tear' || ptr.mode === 'swipe' || ptr.mode === 'inspect') trail(ptr.cx, ptr.cy);
  }

  function endPointer(e, cancelled) {
    if (!ptr.down || e.pointerId !== ptr.id) return;
    ptr.down = false;
    clearTimeout(holdTimer);
    const dt = performance.now() - ptr.t0;
    const dx = e.clientX - ptr.x0;
    const dy = e.clientY - ptr.y0;
    if (!cancelled && !ptr.mode && dt < 500 && Math.hypot(dx, dy) < 10) onTap();
    if (ptr.mode === 'swipe') {
      car.dragging = false;
      const velCards = (-ptr.vx * 1000) / pxPerCard();
      const proj = car.pos + clamp(velCards, -12, 12) * 0.16;
      setFocus(clamp(Math.round(proj), 0, N - 1));
    }
    car.dragging = false;
    ptr.mode = null;
    if (e.pointerType !== 'mouse') {
      ptr.nx = 0;
      ptr.ny = 0;
    }
    kick(1200);
  }

  function onTap() {
    if (ui.state === 'sealed') {
      if (tapBall(ptr.cx, ptr.cy)) return;
      tapPack();
      return;
    }
    if (ui.state !== 'carousel') return;
    const hit = pickCard(ptr.cx, ptr.cy);
    if (hit < 0) return;
    if (hit === ui.focus && Math.abs(car.pos - hit) < 0.35) toggleFlip(hit);
    else goTo(hit);
  }

  function onWheel(e) {
    if (ui.state !== 'carousel') return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    wheelAcc += e.deltaX;
    if (Math.abs(wheelAcc) > 50) {
      step1(Math.sign(wheelAcc));
      wheelAcc = 0;
    }
  }

  function onKey(e) {
    if (e.target !== container) return;
    if (e.key === 'ArrowRight') step1(1);
    else if (e.key === 'ArrowLeft') step1(-1);
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(N - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      if (ui.state === 'sealed') openPack();
      else if (ui.state === 'carousel') toggleFlip(ui.focus);
      else return;
    } else return;
    e.preventDefault();
  }

  function bindDom() {
    listen(dom.dots, 'click', (e) => {
      const b = e.target.closest('.dot');
      if (b) goTo(Number(b.dataset.index));
    });
    listen(dom.prevBtn, 'click', () => step1(-1));
    listen(dom.nextBtn, 'click', () => step1(1));
    listen(dom.flipBtn, 'click', () => toggleFlip(ui.focus));
    listen(dom.resealBtn, 'click', () => resetPack());
    listen(dom.openNow, 'click', () => {
      if (ui.state === 'sealed') openPack();
      else if (ui.state === 'loading') ui.pendingOpen = true;
    });
    const onMotion = (e) => {
      reduceMotion = e.matches;
      kick(400);
    };
    if (mqReduce.addEventListener) listen(mqReduce, 'change', onMotion);
  }

  function bindStageInput() {
    const st = container;
    listen(st, 'pointerdown', onDown);
    listen(st, 'pointermove', onMove);
    listen(st, 'pointerup', (e) => endPointer(e, false));
    listen(st, 'pointercancel', (e) => endPointer(e, true));
    listen(st, 'pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !ptr.down) {
        ptr.nx = 0;
        ptr.ny = 0;
      }
    });
    listen(st, 'wheel', onWheel, { passive: false });
    // 우리 제스처(뜯기·넘기기·살펴보기)가 시작된 뒤에만 페이지 스크롤을 막는다. 그 전에는 세로 스크롤이 그대로 된다.
    // 살펴보기는 옆으로 기울일 때만 막고, 위아래로 움직이면 막지 않아 브라우저가 스크롤한다(그러면 살펴보기가 끝난다).
    listen(
      st,
      'touchmove',
      (e) => {
        if (!e.cancelable || !ptr.down) return;
        if (ptr.mode === 'tear' || ptr.mode === 'swipe') {
          e.preventDefault();
        } else if (ptr.mode === 'inspect') {
          const t = e.touches[0];
          if (t && Math.abs(t.clientY - ptr.y0) > Math.abs(t.clientX - ptr.x0)) return;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    listen(st, 'keydown', onKey);
    listen(st, 'contextmenu', (e) => {
      if (ptr.type !== 'mouse') e.preventDefault();
    });
    listen(dom.canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      sceneReady = false;
      updateRun();
      cb.lost(new Error('WebGL 컨텍스트를 잃었습니다.'));
    });

    // 안드로이드: 폰을 기울이면 홀로그램이 따라 움직인다(권한 창이 필요한 iOS는 건드리지 않음)
    const DOE = window.DeviceOrientationEvent;
    if (coarse && DOE && typeof DOE.requestPermission !== 'function') {
      let base = null;
      listen(
        window,
        'deviceorientation',
        (e) => {
          if (e.beta == null || e.gamma == null) return;
          if (!base) base = { b: e.beta, g: e.gamma };
          tilt.gtx = clamp((e.gamma - base.g) / 35, -1, 1) * 0.6;
          tilt.gty = clamp((e.beta - base.b) / 35, -1, 1) * 0.5;
          base.b += (e.beta - base.b) * 0.01;
          base.g += (e.gamma - base.g) * 0.01;
        },
        { passive: true },
      );
    }
  }

  function observeStage() {
    if ('ResizeObserver' in window) {
      resizeObs = new ResizeObserver(() => resize());
      resizeObs.observe(container);
    } else listen(window, 'resize', resize);
    if ('IntersectionObserver' in window) {
      viewObs = new IntersectionObserver(
        (entries) => {
          inView = entries[entries.length - 1].isIntersecting;
          updateRun();
        },
        { threshold: 0.01 },
      );
      viewObs.observe(container);
    }
    listen(document, 'visibilitychange', updateRun);
  }

  /* ───────── 시작·바깥에서 부르는 기능 ───────── */

  async function start(timeoutMs) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('3D 라이브러리를 제때 불러오지 못했습니다.')), timeoutMs);
    });
    const logoJob = loadLogos();
    const libs = Promise.all([import('three'), import('three/addons/environments/RoomEnvironment.js')]);
    libs.catch(noop); // 시간 초과 뒤에 실패해도 처리되지 않은 거부로 남지 않게
    let mods;
    try {
      mods = await Promise.race([libs, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (destroyed) throw new Error('무대를 닫았습니다.');
    THREE = mods[0];
    const pending = await assetsReady(logoJob);
    if (destroyed) throw new Error('무대를 닫았습니다.');
    setupRenderer(mods[1].RoomEnvironment);
    buildEnvironment();
    buildPack();
    buildBall();
    buildCards();
    buildParticles();
    bindDom();
    bindStageInput();
    observeStage();
    resize();
    sceneReady = true;
    if (pending) pending.late.then(() => !destroyed && repaintAll());
    if (ui.pendingFocus != null || ui.pendingOpen) {
      setState('sealed');
      openPack();
    } else if (opts.sealed && !reduceMotion) {
      setState('sealed');
      dom.tearGuide.classList.add('is-on');
    } else {
      enterDealt();
    }
    updateRun();
    kick(1000);
  }

  // 새 데이터: 카드 그림을 다시 그리고, 보고 있던 팀을 계속 가운데에 둔다
  function update(next) {
    const prevNo = rows[ui.focus]?.no;
    const prevOrder = rows.map((r) => r.no).join(',');
    model = next;
    rows = next.rows;
    const countChanged = rows.length !== N;
    N = rows.length;
    dom.heroCount.textContent = `${N}장`;
    const idx = Math.max(0, rows.findIndex((r) => r.no === prevNo));
    ui.focus = ui.live = idx;
    renderDots();
    if (!sceneReady) return;
    loadLogos().then((added) => added && !destroyed && repaintAll());
    if (countChanged) {
      disposeCards();
      buildCards();
      if (ui.state === 'carousel') for (const c of cards) c.active = true;
    } else {
      for (const c of cards) paintCard(c);
      paintPackArt();
    }
    // 순서가 바뀌면 뒤집힌 카드는 앞면으로 돌려 둔다(다른 팀 카드가 그 자리에 올 수 있으므로)
    if (countChanged || prevOrder !== rows.map((r) => r.no).join(',')) {
      for (const c of cards) c.flip = c.flipTarget = 0;
      if (ui.flipped >= 0) cb.flip(prevNo, false);
      ui.flipped = -1;
    }
    if (ui.state === 'carousel') car.pos = car.target = idx;
    else if (ui.pendingFocus != null) ui.pendingFocus = Math.min(ui.pendingFocus, Math.max(N - 1, 0));
    syncFlipBtn();
    kick(600);
  }

  function setActive(no, { open = false } = {}) {
    const idx = rows.findIndex((r) => r.no === no);
    if (idx < 0) return;
    if (ui.state === 'carousel') goTo(idx);
    else {
      ui.pendingFocus = idx;
      if (ui.state === 'sealed' && open) openPack();
      else if (open) ui.pendingOpen = true;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    running = false;
    cancelAnimationFrame(rafId);
    clearTimeout(hintTimer);
    clearTimeout(holdTimer);
    for (const off of cleanups.splice(0)) off();
    resizeObs?.disconnect();
    viewObs?.disconnect();
    if (scene) {
      scene.traverse((obj) => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
          if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture) u.value.dispose();
          m.dispose();
        }
      });
      scene.environment?.dispose();
    }
    if (renderer) {
      renderer.dispose();
      // 이미 잃은 그림판(webglcontextlost 뒤 다시 만들 때)은 또 버릴 필요가 없다
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss?.();
    }
    sceneReady = false;
    container.replaceChildren();
    container.removeAttribute('tabindex');
    for (const a of ['role', 'aria-roledescription', 'aria-label', 'aria-describedby', 'data-short', 'data-hint', 'data-low', 'data-tiny']) {
      container.removeAttribute(a);
    }
    delete container.dataset.state;
  }

  const controller = {
    update,
    setActive,
    reseal: () => resetPack(),
    pause() {
      paused = true;
      updateRun();
    },
    resume() {
      paused = false;
      if (sceneReady) {
        resize();
        kick(800);
      }
    },
    destroy,
    get state() {
      return ui.state;
    },
  };

  return { start, destroy, controller };
}
