// NV 내전 리그 화면: 데이터 불러오기·저장과 탭별 그리기.
// 순위 탭의 3D 카드(cards3d.js → three.js)는 순위 탭을 처음 열 때만 불러온다. 다른 탭은 바로 뜬다.
import { API_URL } from './config.js';
import { SAMPLE_DATA } from './sample-data.js';
import {
  TIERS,
  ADMIN,
  computeTeamStandings,
  computeMatrix,
  computePlayerStats,
  gamesBetween,
  buildSaveGames,
  applySave,
} from './standings.js';
import { SCHEDULE, scheduleView, teamFixtures } from './schedule.js';
import { teamMeta } from './teams.js';

const DEMO = !API_URL;
const CACHE_KEY = 'nv-league:data';
const BY_KEY = 'nv-league:by';
const PACK_KEY = 'nv-league:pack-opened'; // 카드 팩을 한 번 연 사람은 다음부터 카드가 바로 깔린다
const LOOK_KEY = 'nv-league:standings-look'; // 순위 탭 보기(카드 / 순위표)
const TABS = ['standings', 'schedule', 'matrix', 'players', 'input'];
const AUTO_REFRESH_MS = 60_000;

const state = {
  data: null,
  loading: false,
  loadError: '',
  loadedAt: 0,
  tab: 'standings',
  dataGen: 0, // 데이터를 바꿀 때마다 올린다. 늦게 도착한 옛 불러오기 결과를 버리는 데 쓴다.
  pick: { a: 1, b: 2 },
  formBase: null, // 입력칸을 채울 때 쓴 판 { a, b, games }. 저장할 때 이것과 비교해 바뀐 판만 보낸다.
  formDirty: false,
  saving: false,
  // 입력 탭은 들어올 때마다 비밀번호를 묻는다. 맞으면 unlocked, 탭을 떠나거나 새로고침하면 다시 잠근다.
  // pin은 메모리에만 두고 저장할 때 같이 보낸다(브라우저 저장소에 남기지 않음).
  unlocked: false,
  pin: '',
  gateChecking: false,
  gateError: '',
  notice: null, // { kind: 'ok' | 'error' | 'info', text }
  look: storageGet(LOOK_KEY) === 'table' ? 'table' : 'cards',
  focusNo: null, // 카드에서 가운데 둔 팀 번호
  flippedNo: null, // 뒤집어 둔 카드의 팀 번호
  scrollWeek: false, // 일정 탭에 들어오면 이번 주로 스크롤
};

const view = document.getElementById('view');
const statusLine = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const hero = document.getElementById('hero');
const stage = document.getElementById('stage');
const progress = document.getElementById('progress');
const cardsLive = document.getElementById('cards-live');
const lookButtons = [...document.querySelectorAll('[data-look]')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// 3D 카드 무대. mode: idle → loading → 3d | fallback(평면 카드)
const cards = { mode: 'idle', ctl: null, data: null, stageState: 'loading', pendingOpen: false };

// --- 도우미 ---

// 요소 만들기. 글자는 항상 텍스트 노드로 넣는다(innerHTML 안 씀).
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, v);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장소를 못 쓰는 환경(사생활 보호 모드 등)은 그냥 넘어간다.
  }
}

function readCache() {
  try {
    const data = JSON.parse(storageGet(CACHE_KEY));
    return data && Array.isArray(data.teams) && Array.isArray(data.games) ? data : null;
  } catch {
    return null;
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // 예: 10월 2일 오후 4:38
  return d.toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  });
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const teamOf = (no) => state.data.teams.find((t) => t.no === no);
const rarityKey = (row) => (row.rank === 1 ? 'prism' : row.rank <= 3 ? 'chrome' : 'neon');
const RARITY_LABEL = { prism: 'SOLAR', chrome: 'FROST', neon: 'VOLT' };
const OUTCOME_LABEL = { w: '승', d: '무', l: '패', todo: '예정', rest: '휴식' };

// 팀 로고. 이름 글자 옆에 붙일 때는 alt를 비운다(이름을 두 번 읽지 않게).
// teams.js에 없는 이름(시트에서 바꾼 팀)은 무채색 번호 배지.
function teamLogo(team, { size = 28, alt = '' } = {}) {
  const meta = team?.name ? teamMeta(team.name) : null;
  const style = { '--s': `${size}px` };
  if (meta) {
    return el('img', { class: 'logo', src: meta.logo, alt, width: size, height: size, decoding: 'async', style });
  }
  return el(
    'span',
    { class: 'logo logo-no', role: alt ? 'img' : null, 'aria-label': alt || null, 'aria-hidden': alt ? null : 'true', style },
    team?.no ?? '?',
  );
}

const accentOf = (name) => teamMeta(name)?.accent ?? '#8d94ad';

// 한 팀의 주차별 일정에 판 수·홈/원정 번호·이번 주 여부를 붙인다.
function fixturesOf(sv, no) {
  return teamFixtures(sv, no).map((f) => {
    const week = sv.weeks.find((w) => w.week === f.week);
    const m = f.rest ? null : week?.matches.find((x) => x.home === no || x.away === no);
    return { ...f, count: m?.count ?? 0, home: m?.home ?? null, away: m?.away ?? null, current: !!week?.current };
  });
}

// 대진표(schedule.js)의 팀 이름과 시트 팀 탭 이름이 어긋났는지. 시트에서 팀 이름만 바꾸면 생긴다.
// missing: 대진표에는 있는데 시트에 없는 이름, unscheduled: 시트에는 있는데 대진표에 없는 이름
function scheduleNameIssues(teams) {
  const known = new Set(teams.map((t) => t.name));
  const named = new Set(SCHEDULE.flatMap((w) => [...w.matches.flat(), w.rest]));
  return {
    missing: [...named].filter((n) => !known.has(n)),
    unscheduled: teams.map((t) => t.name).filter((n) => !named.has(n)),
  };
}

function nameIssueText({ missing, unscheduled }) {
  const quote = (names) => names.map((n) => `'${n}'`).join(', ');
  const head = missing.length
    ? `대진표의 팀 이름 ${quote(missing)}이(가) 구글 시트 팀 탭에 없습니다${unscheduled.length ? `(시트에만 있는 이름: ${quote(unscheduled)})` : ''}.`
    : `시트 팀 탭의 ${quote(unscheduled)}이(가) 대진표에 없습니다.`;
  return `${head} 이 이름이 들어간 경기는 결과가 있어도 '이름 확인 필요'로 보입니다. 운영자가 schedule.js의 SCHEDULE과 teams.js의 TEAM_META 팀 이름을 시트와 같게 고쳐 주세요.`;
}

// 대진표 이름을 시트에서 찾지 못한 팀(일정이 한 줄도 이어지지 않음)
const fixturesLost = (fixtures) => fixtures.length > 0 && fixtures.every((f) => !f.rest && f.opponent == null);
// 상대 팀 이름을 시트에서 찾지 못한 일정 한 줄
const opponentUnknown = (f) => !f.rest && f.opponent == null;
const UNKNOWN_NAME = '이름 확인 필요';
const LOST_FIXTURES = '대진표에서 이 팀 이름을 찾지 못했습니다. 운영자가 대진표 이름을 시트와 맞추면 일정이 나옵니다.';

// 그 팀 기준 결과: w | d | l | partial | todo | rest
function outcomeOf(f) {
  if (f.rest) return 'rest';
  if (f.status !== 'done') return f.status;
  return f.pts > f.oppPts ? 'w' : f.pts < f.oppPts ? 'l' : 'd';
}

function matchStatusText(m) {
  if (m.status === 'todo') return '예정';
  if (m.status === 'partial') return `진행 중 ${m.count}/${TIERS.length}`;
  return '끝';
}

// --- 불러오기 ---

async function load() {
  if (state.loading) return;
  state.loading = true;
  const gen = ++state.dataGen;
  render();
  try {
    if (DEMO) {
      state.data ??= structuredClone(SAMPLE_DATA);
    } else {
      const res = await fetch(`${API_URL}?action=data`, { cache: 'no-store' });
      const body = await res.json();
      if (!body.ok) throw Object.assign(new Error(body.message || ''), { fromServer: true });
      // 불러오는 사이 저장이 끝났다면 저장 응답이 더 새 데이터이므로 이 결과는 버린다.
      if (gen === state.dataGen) {
        warnIfMatchChanged(body.data);
        state.data = body.data;
        storageSet(CACHE_KEY, JSON.stringify(body.data));
      }
    }
    state.loadError = '';
    state.loadedAt = Date.now();
  } catch (err) {
    state.data ??= readCache();
    const reason = err?.fromServer && err.message ? ` ${err.message}` : '';
    state.loadError = `최신 결과를 불러오지 못했습니다.${reason}`;
  } finally {
    state.loading = false;
  }
  render();
}

function sameScores(x, y) {
  return TIERS.every((t) => (x[t]?.ga ?? null) === (y[t]?.ga ?? null) && (x[t]?.gb ?? null) === (y[t]?.gb ?? null));
}

// 점수를 입력하는 도중 새로 받은 데이터에서 그 경기가 바뀌었으면 알려 준다(입력칸은 그대로 둔다).
// 내가 저장하는 중에는 바뀐 것이 내 저장일 수 있으므로 알리지 않는다.
function warnIfMatchChanged(nextData) {
  const base = state.formBase;
  if (state.tab !== 'input' || !state.formDirty || state.saving || !base) return;
  if (sameScores(gamesBetween(nextData.games, base.a, base.b), base.games)) return;
  showNotice(
    'info',
    '그사이 다른 기기에서 이 경기 결과가 바뀌었습니다. 저장하면 내가 고친 판만 바뀌고, 나머지 판은 새 결과가 그대로 남습니다.',
  );
  state.notice.matchChanged = true; // 입력칸을 새 데이터로 다시 그리면 지운다
}

// --- 그리기 ---

function renderStatus() {
  refreshButton.disabled = state.loading;
  refreshButton.classList.toggle('spinning', state.loading);
  statusLine.className = 'status';
  if (DEMO) {
    statusLine.classList.add('demo');
    statusLine.textContent = '데모 모드: 예시 데이터입니다. 구글 시트를 연결하면 실제 결과가 나옵니다.';
  } else if (state.loadError) {
    statusLine.classList.add('warn');
    statusLine.textContent = state.data
      ? `${state.loadError} 마지막으로 받은 결과(${formatTime(state.data.serverTime)} 기준)를 보여 줍니다.`
      : `${state.loadError} 잠시 뒤 새로고침해 주세요.`;
  } else if (state.data) {
    statusLine.textContent = `${formatTime(state.data.serverTime)} 기준`;
  } else {
    statusLine.textContent = '';
  }
}

function render() {
  renderStatus();
  for (const link of document.querySelectorAll('[data-tab]')) {
    const active = link.dataset.tab === state.tab;
    link.classList.toggle('active', active);
    link.setAttribute('aria-selected', String(active));
  }
  if (!state.data) {
    hero.hidden = true;
    cards.ctl?.pause();
    delete view.dataset.tab;
    view.replaceChildren(
      el('p', { class: 'empty' }, state.loading ? '불러오는 중…' : '표시할 결과가 없습니다. 새로고침해 보세요.'),
    );
    return;
  }
  syncHero();
  // 점수를 입력하는 도중에는 새로 받은 데이터로 입력칸을 갈아엎지 않는다.
  if (state.tab === 'input' && state.formDirty && view.dataset.tab === 'input') return;
  view.dataset.tab = state.tab;
  const panel = {
    standings: renderStandings,
    schedule: renderSchedule,
    matrix: renderMatrix,
    players: renderPlayers,
    input: renderInput,
  };
  view.replaceChildren(...panel[state.tab]().filter(Boolean));
  syncTyping(document.activeElement); // 글자를 넣던 칸이 다시 그려져 사라졌으면 탭 막대를 되돌린다
  if (state.tab === 'schedule') centerCurrentWeekChip();
  if (state.tab === 'schedule' && state.scrollWeek) {
    state.scrollWeek = false;
    // 대진표 이름 경고가 있으면 그것부터 보이게 맨 위에서 시작한다
    const current = view.querySelector('.callout.warn') ? null : view.querySelector('.week-card.is-current');
    if (current) current.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }
}

// 두 번째 열(팀·선수)만 왼쪽 정렬
function headRow(labels) {
  return el(
    'thead',
    {},
    el(
      'tr',
      {},
      labels.map(([label, cls]) => el('th', { scope: 'col', class: cls }, label)),
    ),
  );
}

// --- 순위 탭: 위쪽 카드 무대(다시 그려도 남는다) ---

function standingsModel() {
  const { teams, games, settings } = state.data;
  const s = computeTeamStandings(teams, games, settings);
  const sv = scheduleView(SCHEDULE, teams, games);
  return {
    s,
    sv,
    rows: s.rows,
    perTeam: Math.max(teams.length - 1, 0),
    fixtures: new Map(s.rows.map((r) => [r.no, fixturesOf(sv, r.no)])),
    currentWeek: sv.currentWeek,
  };
}

function syncHero() {
  const show = state.tab === 'standings' && state.data.teams.length > 0;
  hero.hidden = !show;
  if (!show) {
    cards.ctl?.pause();
    return;
  }
  renderProgress();
  for (const b of lookButtons) b.setAttribute('aria-pressed', String(b.dataset.look === state.look));
  const showCards = state.look === 'cards';
  stage.hidden = !showCards;
  if (!showCards) {
    cards.ctl?.pause();
    return;
  }
  measureStage();
  if (state.focusNo == null || !teamOf(state.focusNo)) {
    state.focusNo = computeTeamStandings(state.data.teams, state.data.games, state.data.settings).rows[0]?.no ?? null;
  }
  if (cards.mode === 'idle') {
    startCards();
  } else if (cards.mode === '3d') {
    if (cards.data !== state.data) {
      cards.data = state.data;
      cards.ctl.update(standingsModel());
    }
    cards.ctl.resume();
  } else if (cards.mode === 'fallback' && cards.data !== state.data) {
    cards.data = state.data;
    renderFallback();
  }
}

function renderProgress() {
  const { teams, games, settings } = state.data;
  const s = computeTeamStandings(teams, games, settings);
  const pct = s.totalMatches ? Math.round((s.completedMatches / s.totalMatches) * 100) : 0;
  progress.replaceChildren(
    el(
      'span',
      { class: 'progress-text' },
      el('b', {}, s.completedMatches),
      ` / ${s.totalMatches}경기 끝`,
      el('small', {}, ` · ${s.recordedGames}판`),
    ),
    el('span', { class: 'meter', 'aria-hidden': 'true' }, el('span', { style: { width: `${pct}%` } })),
  );
}

// 무대는 머리글 아래부터 탭 막대 바로 위까지를 채운다(style.css .stage). 머리글 높이는 아이폰 안전 영역,
// 상태 줄 줄바꿈, 글꼴에 따라 달라지므로 무대 위쪽 끝 위치를 재서 CSS 변수로 넘긴다.
let stageTop = -1;
function measureStage() {
  if (hero.hidden || stage.hidden) return;
  const top = Math.round(stage.getBoundingClientRect().top + window.scrollY);
  if (top === stageTop) return;
  stageTop = top;
  document.documentElement.style.setProperty('--stage-top', `${top}px`);
}

async function startCards() {
  cards.mode = 'loading';
  cards.stageState = 'loading';
  cards.data = state.data;
  try {
    const { mountCards3D } = await import('./cards3d.js');
    const ctl = await mountCards3D(stage, {
      model: standingsModel(),
      metaFor: teamMeta,
      sealed: storageGet(PACK_KEY) !== '1' && !reducedMotion.matches,
      focusNo: state.focusNo,
      onSelect: onCardSelect,
      onFlip: onCardFlip,
      onOpen: () => storageSet(PACK_KEY, '1'),
      onState: onStageState,
      onLost: (err) => setTimeout(() => recoverCards(err), 0),
    });
    cards.ctl = ctl;
    cards.mode = '3d';
    if (cards.data !== state.data && state.data) {
      cards.data = state.data;
      ctl.update(standingsModel());
    }
    if (cards.pendingOpen && state.focusNo != null) ctl.setActive(state.focusNo, { open: true });
    cards.pendingOpen = false;
    if (!(state.data && state.tab === 'standings' && state.look === 'cards')) ctl.pause();
  } catch (err) {
    switchToFallback(err);
  }
}

// WebGL·three.js를 못 쓰면 같은 정보를 담은 평면(DOM) 카드로 보여 준다.
// reason 'unstable': 3D는 되지만 그래픽 메모리를 자꾸 잃는 기기
function switchToFallback(err, reason = 'unsupported') {
  if (err) console.warn('[NV] 3D 카드를 켜지 못해 평면 카드로 보여 줍니다.', err);
  cards.ctl?.destroy();
  cards.ctl = null;
  cards.mode = 'fallback';
  cards.fallbackReason = reason;
  cards.stageState = 'fallback';
  cards.data = state.data;
  renderFallback();
  updateDock();
}

// 3D 그림판(WebGL 컨텍스트)을 잃었을 때. 아이폰·카카오톡은 메모리가 모자라거나 앱을 뒤로 보내면
// 그림판을 거둬 가는 일이 흔하다. 기기가 3D를 못 하는 것이 아니므로 무대를 새로 만든다.
// 1분 안에 세 번 잃을 때만 평면 카드로 바꾼다.
const LOSS_LIMIT = 3;
const LOSS_WINDOW_MS = 60_000;
function recoverCards(err) {
  if (cards.mode !== '3d') return;
  const now = Date.now();
  cards.losses = (cards.losses || []).filter((t) => now - t < LOSS_WINDOW_MS);
  cards.losses.push(now);
  if (cards.losses.length >= LOSS_LIMIT) {
    switchToFallback(err, 'unstable');
    return;
  }
  console.warn('[NV] 3D 그림판을 잃어 카드 무대를 다시 만듭니다.', err);
  cards.ctl?.destroy();
  cards.ctl = null;
  cards.mode = 'idle';
  stage.dataset.state = 'loading';
  stage.replaceChildren(
    el(
      'div',
      { class: 'loader', 'aria-hidden': 'true' },
      el('span', { class: 'loader-pack' }, el('b', {}, 'NV')),
      el('span', { class: 'loader-text' }, '카드 다시 준비 중…'),
    ),
  );
  if (state.flippedNo != null) {
    state.flippedNo = null; // 새 무대의 카드는 모두 앞면
    updateDock();
  }
  // 순위 탭 카드 보기가 화면에 있을 때 바로 다시 만들고, 아니면 그 화면으로 돌아올 때(syncHero) 만든다.
  if (state.data && !document.hidden) syncHero();
}

function onCardSelect(no, { silent = false } = {}) {
  state.focusNo = no;
  updateDock();
  if (!silent) announceTeam(no);
}

function onCardFlip(no, flipped) {
  if (flipped) state.flippedNo = no;
  else if (state.flippedNo === no) state.flippedNo = null;
  updateDock();
}

function onStageState(next) {
  const before = isTeaser();
  cards.stageState = next;
  if (before !== isTeaser()) updateDock();
}

function announceTeam(no) {
  if (!state.data) return;
  const r = standingsModel().rows.find((x) => x.no === no);
  if (r) cardsLive.textContent = `${r.rank}위 ${r.name}, 승점 ${r.pts}, ${r.w}승 ${r.d}무 ${r.l}패, 득실 ${signed(r.diff)}`;
}

// 팩을 아직 안 열었으면 카드 정보 대신 맛보기 문구(순위는 순위표로 먼저 볼 수 있다)
function isTeaser() {
  if (cards.mode === 'fallback') return false;
  if (cards.stageState === 'sealed' || cards.stageState === 'opening') return true;
  return cards.stageState === 'loading' && storageGet(PACK_KEY) !== '1' && !reducedMotion.matches;
}

function setLook(look) {
  state.look = look;
  storageSet(LOOK_KEY, look);
  render();
}

// 순위표 행에서 팀을 고르면 카드 보기로 돌아가 그 팀 카드를 가운데에 둔다.
function showTeamCard(no) {
  state.focusNo = no;
  state.look = 'cards';
  storageSet(LOOK_KEY, 'cards');
  render();
  if (cards.mode === '3d') cards.ctl.setActive(no, { open: true });
  else if (cards.mode === 'loading') cards.pendingOpen = true;
  else if (cards.mode === 'fallback') syncFallbackCards({ scroll: true });
  hero.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// --- 평면 카드(WebGL 없는 기기) ---

function renderFallback() {
  stage.dataset.state = 'fallback';
  if (!state.data) return;
  const model = standingsModel();
  const why =
    cards.fallbackReason === 'unstable'
      ? '3D 연출이 이 기기에서 자꾸 멈춰 카드를 평면으로 보여 드려요.'
      : '3D 연출을 켤 수 없어 카드를 평면으로 보여 드려요.';
  stage.replaceChildren(
    el('p', { class: 'fallback-note' }, `${why} 옆으로 밀어 보세요.`),
    el('div', { class: 'fb-track', role: 'list', 'aria-label': '팀 카드' }, model.rows.map((r) => fallbackCard(r, model))),
  );
  syncFallbackCards({ scroll: true });
}

function statCell(label, value, cls) {
  return el('div', { class: cls }, el('dt', {}, label), el('dd', {}, value));
}

function playerChips(players, cls = 'chips') {
  return el(
    'ul',
    { class: cls, 'aria-label': '선수' },
    TIERS.map((t) =>
      el(
        'li',
        { class: `chip t${t}` },
        el('i', { 'aria-hidden': 'true' }, `${t}T`),
        el('span', {}, el('span', { class: 'sr-only' }, `${t}티어 `), players[t - 1] || '—'),
      ),
    ),
  );
}

function fallbackCard(r, model) {
  const key = rarityKey(r);
  const fixtures = model.fixtures.get(r.no) || [];
  const front = el(
    'div',
    { class: 'fb-face fb-front' },
    el(
      'div',
      { class: 'fb-top' },
      el('span', { class: 'fb-rank' }, r.rank, el('small', {}, '위')),
      r.star
        ? el('span', { class: 'fb-star' }, '★ 단독 선두')
        : r.playoff
          ? el('span', { class: 'tag' }, '결정전 대기')
          : el('span', { class: 'fb-rar' }, RARITY_LABEL[key]),
    ),
    el('div', { class: 'fb-crest' }, teamLogo(r, { size: 108 })),
    el('p', { class: 'fb-name' }, r.name),
    el(
      'dl',
      { class: 'fb-stats' },
      statCell('승점', r.pts, 'hot'),
      statCell('경기', `${r.played}/${model.perTeam}`),
      statCell('승-무-패', `${r.w}-${r.d}-${r.l}`),
      statCell('득실', signed(r.diff)),
    ),
    playerChips(r.players, 'chips fb-chips'),
  );
  const back = el(
    'div',
    { class: 'fb-face fb-back' },
    el('p', { class: 'fb-back-title' }, el('b', {}, r.name), ` ${r.rank}위 · 일정`),
    fixturesLost(fixtures)
      ? el('p', { class: 'fx-missing' }, LOST_FIXTURES)
      : el(
          'ol',
          { class: 'fx-mini' },
          fixtures.map((f) => {
            const out = outcomeOf(f);
            const unknown = opponentUnknown(f);
            return el(
              'li',
              { class: `o-${unknown ? 'unknown' : out}${f.current ? ' is-current' : ''}` },
              el('span', { class: 'fx-week' }, `${f.week}주`),
              el('span', { class: 'fx-opp' }, f.rest ? '휴식' : f.opponentName || '미정'),
              el(
                'span',
                { class: 'fx-res' },
                unknown
                  ? '확인 필요'
                  : out === 'rest' || out === 'todo'
                    ? out === 'todo'
                      ? '예정'
                      : ''
                    : `${f.pts}:${f.oppPts} ${out === 'partial' ? `${f.count}/${TIERS.length}` : OUTCOME_LABEL[out]}`,
              ),
            );
          }),
        ),
  );
  return el(
    'div',
    {
      class: `fb-card r-${key}`,
      role: 'listitem',
      'data-no': r.no,
      style: { '--accent': accentOf(r.name) },
      onclick: () => onFallbackCardClick(r.no),
    },
    el('div', { class: 'fb-inner' }, front, back),
    el(
      'button',
      {
        type: 'button',
        class: 'fb-flip',
        'aria-pressed': 'false',
        onclick: (event) => {
          event.stopPropagation();
          toggleFallbackFlip(r.no);
        },
      },
      '일정 보기',
    ),
  );
}

function onFallbackCardClick(no) {
  if (state.focusNo === no) {
    toggleFallbackFlip(no);
    return;
  }
  state.focusNo = no;
  syncFallbackCards();
  updateDock();
  announceTeam(no);
}

function toggleFallbackFlip(no) {
  state.focusNo = no;
  state.flippedNo = state.flippedNo === no ? null : no;
  syncFallbackCards();
  updateDock();
}

// 평면 카드의 선택·뒤집힘 표시를 상태에 맞춘다(다시 그리지 않고 클래스만 바꾼다)
function syncFallbackCards({ scroll = false } = {}) {
  for (const card of stage.querySelectorAll('.fb-card')) {
    const no = Number(card.dataset.no);
    const flipped = state.flippedNo === no;
    card.classList.toggle('is-active', state.focusNo === no);
    card.classList.toggle('is-flipped', flipped);
    card.querySelector('.fb-front').setAttribute('aria-hidden', String(flipped));
    card.querySelector('.fb-back').setAttribute('aria-hidden', String(!flipped));
    const button = card.querySelector('.fb-flip');
    button.setAttribute('aria-pressed', String(flipped));
    button.textContent = flipped ? '앞면 보기' : '일정 보기';
    if (scroll && state.focusNo === no) {
      const track = card.parentElement;
      track.scrollLeft = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
    }
  }
}

// --- 순위 탭: 아래쪽 글자 정보 ---

function renderStandings() {
  if (!state.data.teams.length) {
    return [el('p', { class: 'empty' }, '팀 명단이 없습니다. 구글 시트 팀 탭을 확인해 주세요.')];
  }
  const model = standingsModel();
  return [
    el('h2', { class: 'sr-only' }, '팀 순위'),
    model.s.playoffPending
      ? el(
          'p',
          { class: 'callout' },
          '모든 경기가 끝났고 1위가 승점·골득실 동률입니다. 3:3 결정전 뒤 운영자가 구글 시트 설정 탭에 승자 팀 번호를 적으면 반영됩니다.',
        )
      : null,
    state.look === 'cards' ? renderDock(model) : renderStandingsTable(model),
    renderRules(),
  ];
}

function updateDock() {
  if (!state.data || state.tab !== 'standings' || state.look !== 'cards' || view.dataset.tab !== 'standings') return;
  const old = view.querySelector('.dock');
  if (old) old.replaceWith(renderDock(standingsModel()));
}

function renderDock(model) {
  const { rows } = model;
  if (isTeaser()) {
    return el(
      'section',
      { class: 'dock', 'aria-label': '카드 정보' },
      el(
        'div',
        { class: 'dock-inner dock-teaser' },
        el('p', {}, '팩 안에 ', el('b', {}, `팀 카드 ${rows.length}장`), '이 순위대로 들어 있어요.'),
        el('button', { type: 'button', class: 'link-btn', onclick: () => setLook('table') }, '순위표 먼저 보기'),
      ),
    );
  }
  const r = rows.find((x) => x.no === state.focusNo) ?? rows[0];
  const key = rarityKey(r);
  const index = rows.indexOf(r);
  const fixtures = model.fixtures.get(r.no) || [];
  const flipped = state.flippedNo === r.no;
  const hint =
    cards.mode === 'fallback'
      ? '카드의 「일정 보기」로 뒷면에서도 볼 수 있어요'
      : flipped
        ? '카드 뒷면에도 펼쳐져 있어요'
        : '가운데 카드를 탭하면 뒷면에서도 보여요';
  return el(
    'section',
    { class: `dock r-${key}`, 'aria-label': `${r.name} 카드 정보`, style: { '--team': accentOf(r.name) } },
    el(
      'div',
      { class: 'dock-inner' },
      el(
        'div',
        { class: 'dock-id' },
        el('span', { class: 'dock-crest' }, teamLogo(r, { size: 60 })),
        el(
          'div',
          { class: 'dock-name' },
          el(
            'p',
            { class: 'kicker' },
            `${r.rank}위 · ${RARITY_LABEL[key]} card · ${String(index + 1).padStart(2, '0')} / ${String(rows.length).padStart(2, '0')}`,
          ),
          el(
            'h3',
            {},
            el('span', {}, r.name),
            r.star ? el('span', { class: 'star-pill' }, '★ 단독 선두') : null,
            r.playoff ? el('span', { class: 'tag' }, '결정전 대기') : null,
          ),
        ),
        el('span', { class: 'dock-pts' }, el('b', {}, r.pts), el('small', {}, '승점')),
      ),
      playerChips(r.players, 'chips dock-members'),
      el(
        'dl',
        { class: 'dock-stats' },
        statCell('경기', `${r.played}/${model.perTeam}`),
        statCell('승-무-패', `${r.w}-${r.d}-${r.l}`),
        statCell('득실', signed(r.diff), r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : null),
        statCell('득점·실점', `${r.scored} · ${r.conceded}`),
      ),
      el(
        'div',
        { class: `dock-fixtures${flipped ? ' is-flipped' : ''}` },
        el('h4', {}, '주차별 일정', fixturesLost(fixtures) ? null : el('small', {}, hint)),
        fixturesLost(fixtures)
          ? el('p', { class: 'fx-missing' }, LOST_FIXTURES)
          : el(
              'ol',
              { class: 'fx-list' },
              fixtures.map((f) => fixtureItem(f, r)),
            ),
      ),
    ),
  );
}

function fixtureItem(f, team) {
  const out = outcomeOf(f);
  // 상대 이름을 시트에서 못 찾으면 옛 로고·'예정' 대신 물음표 배지와 '이름 확인 필요'
  const unknown = opponentUnknown(f);
  const label = unknown ? UNKNOWN_NAME : out === 'partial' ? `진행 중 ${f.count}/${TIERS.length}` : OUTCOME_LABEL[out];
  const week = el('span', { class: 'fx-week' }, `${f.week}주`, f.current ? el('small', {}, '이번 주') : null);
  if (f.rest) {
    return el('li', { class: `fx o-rest${f.current ? ' is-current' : ''}` }, el('div', { class: 'fx-btn' }, week, el('span', { class: 'fx-opp rest' }, '휴식')));
  }
  const body = [
    week,
    el(
      'span',
      { class: 'fx-opp' },
      el('small', {}, 'vs'),
      teamLogo(unknown ? { no: '?' } : { no: f.opponent, name: f.opponentName }, { size: 24 }),
      el('b', {}, f.opponentName || '미정'),
    ),
    el('span', { class: 'fx-score' }, out === 'todo' ? '' : `${f.pts}:${f.oppPts}`),
    el('span', { class: 'fx-tag' }, label),
  ];
  const canOpen = f.home != null && f.away != null;
  return el(
    'li',
    { class: `fx o-${unknown ? 'unknown' : out}${f.current ? ' is-current' : ''}` },
    canOpen
      ? el(
          'button',
          { type: 'button', class: 'fx-btn', onclick: () => openInput(f.home, f.away) },
          body,
          el('span', { class: 'sr-only' }, `, ${team.name} 경기 결과 입력`),
        )
      : el('div', { class: 'fx-btn' }, body),
  );
}

function renderStandingsTable(model) {
  const { rows, perTeam } = model;
  const body = rows.map((r) => {
    const key = rarityKey(r);
    return el(
      'tr',
      { class: `r-${key}${r.star ? ' is-star' : ''}` },
      el('td', { class: 'c-rank' }, el('span', { class: 'rank' }, r.rank), r.star ? el('span', { class: 'star', title: '단독 선두' }, '★') : null),
      el(
        'th',
        { scope: 'row', class: 'c-team' },
        el(
          'button',
          { type: 'button', class: 'team-link', onclick: () => showTeamCard(r.no) },
          teamLogo(r, { size: 26 }),
          el('span', { class: 'tname' }, r.name),
          el('span', { class: 'sr-only' }, ' 카드 보기'),
        ),
        r.playoff ? el('span', { class: 'tag' }, '결정전 대기') : null,
        el(
          'span',
          { class: 'members' },
          TIERS.map((t) => el('span', { class: `m t${t}` }, r.players[t - 1] || '—')),
        ),
      ),
      el('td', { class: 'c-num' }, r.played, el('small', {}, `/${perTeam}`)),
      el('td', { class: 'c-wdl' }, `${r.w}-${r.d}-${r.l}`),
      el('td', { class: 'c-num c-wide' }, r.scored),
      el('td', { class: 'c-num c-wide' }, r.conceded),
      el('td', { class: `c-num ${r.diff > 0 ? 'pos' : r.diff < 0 ? 'neg' : ''}` }, signed(r.diff)),
      el('td', { class: 'c-pts' }, r.pts),
    );
  });
  return el(
    'section',
    { class: 'panel standings-panel', 'aria-labelledby': 'table-title' },
    el(
      'header',
      { class: 'panel-head' },
      el('h3', { id: 'table-title' }, '전체 순위'),
      el('span', { class: 'muted' }, `${model.s.recordedGames}/${model.s.totalMatches * TIERS.length}판 진행`),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'standings' },
        el('caption', { class: 'sr-only' }, '팀 순위. 승점, 골득실, 다득점 순.'),
        headRow([
          ['순위', 'c-rank'],
          ['팀 · 선수', 'c-team'],
          ['경기', 'c-num'],
          ['승-무-패', 'c-wdl'],
          ['득점', 'c-num c-wide'],
          ['실점', 'c-num c-wide'],
          ['득실', 'c-num'],
          ['승점', 'c-pts'],
        ]),
        el('tbody', {}, body),
      ),
    ),
    el(
      'p',
      { class: 'note' },
      '팀 이름을 누르면 그 팀 카드로 갑니다. 승-무-패와 득실은 판 기준이고, 경기는 3판이 모두 입력된 경기만 셉니다.',
    ),
  );
}

function renderRules() {
  return el(
    'section',
    { class: 'rules', 'aria-labelledby': 'rules-title' },
    el('h3', { id: 'rules-title' }, '리그 규칙'),
    el(
      'ol',
      { class: 'rule-steps', 'aria-hidden': 'true' },
      el('li', {}, el('b', {}, '판마다'), el('span', {}, '승 3 · 무 1 · 패 0')),
      el('li', {}, el('b', {}, '팀 승점'), el('span', {}, '3판 승점의 합')),
      el('li', {}, el('b', {}, '순위'), el('span', {}, '승점 → 골득실 → 다득점')),
    ),
    el(
      'p',
      {},
      '판마다 승 3 · 무 1 · 패 0. 팀 승점은 팀원 3명이 판마다 얻은 승점을 더한 값입니다(예: 2승 1무 → 7점, 상대 1점). 순위는 승점 → 골득실 → 다득점.',
    ),
    el(
      'p',
      { class: 'muted' },
      '시즌이 끝났을 때 1위가 승점·골득실까지 같으면 3:3 결정전으로 가립니다. 결정전 승자는 운영자가 구글 시트에 적으면 반영됩니다.',
    ),
  );
}

// --- 일정 탭 ---

function renderSchedule() {
  const { teams, games } = state.data;
  const sv = scheduleView(SCHEDULE, teams, games);
  const issues = scheduleNameIssues(teams);
  return [
    el(
      'header',
      { class: 'sec-head' },
      el('p', { class: 'kicker' }, 'Schedule'),
      el('h2', {}, '일정'),
      el(
        'p',
        { class: 'sec-note' },
        sv.currentWeek
          ? `지금은 ${sv.currentWeek}주차입니다. 경기를 누르면 결과를 입력합니다.`
          : '모든 주차 경기가 끝났습니다. 경기를 누르면 결과를 고칠 수 있습니다.',
      ),
    ),
    issues.missing.length || issues.unscheduled.length
      ? el('p', { class: 'callout warn', role: 'note' }, nameIssueText(issues))
      : null,
    el(
      'nav',
      { class: 'week-strip', 'aria-label': '주차로 이동' },
      sv.weeks.map((w) =>
        el(
          'button',
          {
            type: 'button',
            class: `week-chip${w.current ? ' is-current' : ''}${w.done === w.total ? ' is-done' : ''}`,
            'aria-label': `${w.week}주차로 이동${w.current ? ', 이번 주' : ''}`,
            onclick: () => scrollToWeek(w.week),
          },
          w.week,
        ),
      ),
    ),
    el(
      'ol',
      { class: 'weeks' },
      sv.weeks.map((w) => weekCard(w)),
    ),
  ];
}

// 좁은 화면에서 주차 단추 줄이 옆으로 넘치면 이번 주 단추가 보이도록 그 줄만 가로로 옮긴다.
function centerCurrentWeekChip() {
  const strip = view.querySelector('.week-strip');
  const chip = strip?.querySelector('.week-chip.is-current');
  if (!chip || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
}

function scrollToWeek(week) {
  view.querySelector(`#week-${week}`)?.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function weekCard(w) {
  const restTeam = w.restNo != null ? teamOf(w.restNo) : null;
  return el(
    'li',
    { class: `week-card${w.current ? ' is-current' : ''}`, id: `week-${w.week}` },
    el(
      'div',
      { class: 'week-head' },
      el('h3', {}, `${w.week}주차`),
      w.current ? el('span', { class: 'now-badge' }, '이번 주') : null,
      el('span', { class: 'week-count' }, w.done === w.total ? '모두 끝' : `${w.done}/${w.total}경기 끝`),
    ),
    el(
      'ul',
      { class: 'matches' },
      w.matches.map((m) => el('li', {}, matchButton(w, m))),
    ),
    el(
      'p',
      { class: 'rest' },
      el('span', { class: 'rest-label' }, '휴식'),
      teamLogo(restTeam ?? { no: '?' }, { size: 22 }),
      el('span', {}, w.rest),
      restTeam ? null : el('span', { class: 'name-warn' }, UNKNOWN_NAME),
    ),
  );
}

function matchButton(w, m) {
  const winner = m.status === 'done' ? (m.pts > m.oppPts ? 'home' : m.pts < m.oppPts ? 'away' : 'draw') : null;
  // 대진표 이름을 시트에서 못 찾은 쪽이 있으면 결과를 이어 붙일 수 없다: '예정' 대신 '이름 확인 필요'
  const unknown = m.home == null || m.away == null;
  const statusText = unknown ? UNKNOWN_NAME : matchStatusText(m);
  const side = (no, name, cls) =>
    el(
      'span',
      { class: `m-side ${cls}${winner === cls ? ' win' : ''}${winner && winner !== 'draw' && winner !== cls ? ' lose' : ''}` },
      teamLogo(no != null ? teamOf(no) : { no: '?' }, { size: 34 }),
      el('b', {}, name),
    );
  const center = unknown
    ? el('span', { class: 'm-center' }, el('span', { class: 'm-status todo warn' }, UNKNOWN_NAME))
    : m.status === 'todo'
      ? el('span', { class: 'm-center' }, el('span', { class: 'm-status todo' }, '예정'))
      : el(
          'span',
          { class: 'm-center' },
          el(
            'span',
            { class: 'm-score' },
            el('b', { class: winner === 'home' ? 'w' : null }, m.pts),
            el('i', {}, ':'),
            el('b', { class: winner === 'away' ? 'w' : null }, m.oppPts),
          ),
          el('span', { class: `m-status ${m.status}` }, statusText),
        );
  const canOpen = m.home != null && m.away != null;
  const score = m.status === 'todo' ? '' : ` 승점 ${m.pts} 대 ${m.oppPts}`;
  return el(
    'button',
    {
      type: 'button',
      class: `match s-${m.status}${unknown ? ' is-unknown' : ''}`,
      disabled: !canOpen,
      'aria-label': `${w.week}주차 ${m.homeName} 대 ${m.awayName}, ${statusText}${score}${canOpen ? ', 결과 입력' : ''}`,
      onclick: () => openInput(m.home, m.away),
    },
    side(m.home, m.homeName, 'home'),
    center,
    side(m.away, m.awayName, 'away'),
  );
}

// --- 경기표 탭 ---

function renderMatrix() {
  const { teams, games } = state.data;
  const cells = computeMatrix(teams, games);
  const head = el(
    'thead',
    {},
    el(
      'tr',
      {},
      el('th', { scope: 'col', class: 'corner' }, el('span', { class: 'sr-only' }, '행 팀 기준')),
      teams.map((t) => el('th', { scope: 'col', title: t.name }, teamLogo(t, { size: 24, alt: t.name }))),
    ),
  );
  const rows = teams.map((rowTeam) =>
    el(
      'tr',
      {},
      el(
        'th',
        { scope: 'row', title: `${rowTeam.name} · ${rowTeam.players.join(' · ')}` },
        el('span', { class: 'row-team' }, teamLogo(rowTeam, { size: 26 }), el('span', { class: 'row-name' }, rowTeam.name)),
      ),
      teams.map((colTeam) => {
        if (rowTeam.no === colTeam.no) return el('td', { class: 'self', 'aria-hidden': 'true' });
        const c = cells[rowTeam.no][colTeam.no];
        const label = `${rowTeam.name} 대 ${colTeam.name}`;
        const open = () => openInput(rowTeam.no, colTeam.no);
        if (!c) {
          return el(
            'td',
            {},
            el('button', { type: 'button', class: 'cell blank', 'aria-label': `${label} 결과 입력`, onclick: open }, '·'),
          );
        }
        const outcome = c.pts > c.oppPts ? 'win' : c.pts < c.oppPts ? 'loss' : 'draw';
        const partial = c.count < TIERS.length;
        return el(
          'td',
          {},
          el(
            'button',
            {
              type: 'button',
              class: `cell ${outcome}${partial ? ' partial' : ''}`,
              'aria-label': `${label} 승점 ${c.pts} 대 ${c.oppPts}${partial ? `, ${c.count}판 입력` : ''}`,
              onclick: open,
            },
            `${c.pts}:${c.oppPts}`,
            partial ? el('small', {}, `${c.count}/${TIERS.length}`) : null,
          ),
        );
      }),
    ),
  );
  return [
    el(
      'section',
      { class: 'panel' },
      el(
        'header',
        { class: 'panel-head' },
        el('h2', {}, '경기표'),
        el('span', { class: 'muted' }, '행 팀 기준 승점'),
      ),
      el('div', { class: 'matrix-wrap' }, el('table', { class: 'matrix' }, head, el('tbody', {}, rows))),
      el(
        'ul',
        { class: 'team-legend', 'aria-label': '로고 안내' },
        teams.map((t) => el('li', {}, teamLogo(t, { size: 22 }), el('span', {}, t.name))),
      ),
      el(
        'p',
        { class: 'note' },
        '칸을 누르면 그 경기 결과를 입력하거나 고칩니다. 작은 숫자 2/3은 3판 중 2판만 입력된 경기입니다.',
      ),
    ),
  ];
}

// --- 개인 탭 ---

function renderPlayers() {
  const { teams, games } = state.data;
  const stats = computePlayerStats(teams, games);
  return [
    el('header', { class: 'sec-head' }, el('p', { class: 'kicker' }, 'Players'), el('h2', {}, '개인 기록'), el('p', { class: 'sec-note' }, '같은 티어끼리 붙은 판만 모은 기록입니다.')),
    ...TIERS.map((tier) =>
      el(
        'section',
        { class: `panel tier-panel t${tier}`, 'aria-labelledby': `tier-${tier}` },
        el(
          'header',
          { class: 'tier-head' },
          el('span', { class: 'tier-badge', 'aria-hidden': 'true' }, `${tier}T`),
          el('h3', { id: `tier-${tier}` }, `${tier}티어`),
          el('span', { class: 'tier-metal' }, ['GOLD', 'SILVER', 'BRONZE'][tier - 1]),
        ),
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'players' },
            headRow([
              ['순위', 'c-rank'],
              ['선수', 'c-team'],
              ['승-무-패', 'c-wdl'],
              ['승점', 'c-pts'],
              ['득점', 'c-num'],
              ['실점', 'c-num'],
              ['득실', 'c-num'],
            ]),
            el(
              'tbody',
              {},
              stats[tier].map((p) => {
                const team = teamOf(p.teamNo);
                return el(
                  'tr',
                  {},
                  el('td', { class: 'c-rank' }, el('span', { class: `medal m${p.rank}` }, p.rank)),
                  el(
                    'th',
                    { scope: 'row', class: 'c-team' },
                    el('strong', {}, p.name),
                    el(
                      'span',
                      { class: 'p-team' },
                      teamLogo(team ?? { no: p.teamNo, name: '' }, { size: 16 }),
                      team?.name ?? `${p.teamNo}팀`,
                    ),
                  ),
                  el('td', { class: 'c-wdl' }, `${p.w}-${p.d}-${p.l}`),
                  el('td', { class: 'c-pts' }, p.pts),
                  el('td', { class: 'c-num' }, p.scored),
                  el('td', { class: 'c-num' }, p.conceded),
                  el('td', { class: `c-num ${p.diff > 0 ? 'pos' : p.diff < 0 ? 'neg' : ''}` }, signed(p.diff)),
                );
              }),
            ),
          ),
        ),
      ),
    ),
  ];
}

// --- 입력 탭 ---

function fixPick() {
  const nos = state.data.teams.map((t) => t.no);
  if (!nos.includes(state.pick.a)) state.pick.a = nos[0];
  if (!nos.includes(state.pick.b) || state.pick.b === state.pick.a) {
    state.pick.b = nos.find((n) => n !== state.pick.a) ?? state.pick.a;
  }
}

// 고른 두 팀이 대진표 몇 주차 경기인지
function pairWeek(sv, a, b) {
  for (const w of sv.weeks) {
    for (const m of w.matches) {
      if ((m.home === a && m.away === b) || (m.home === b && m.away === a)) return { w, m };
    }
  }
  return null;
}

// 이번 주 경기를 한 번에 고르는 단추
function quickPicks(sv) {
  const week = sv.weeks.find((w) => w.current);
  if (!week) return null;
  const chips = week.matches
    .filter((m) => m.home != null && m.away != null)
    .map((m) => {
      const on =
        (state.pick.a === m.home && state.pick.b === m.away) || (state.pick.a === m.away && state.pick.b === m.home);
      const status = matchStatusText(m);
      return el(
        'button',
        {
          type: 'button',
          class: `quick-chip s-${m.status}`,
          'aria-pressed': String(on),
          'aria-label': `${m.homeName} 대 ${m.awayName} 고르기, ${status}`,
          disabled: state.saving,
          onclick: () => pickPair(m.home, m.away),
        },
        el(
          'span',
          { class: 'qc-logos' },
          teamLogo(teamOf(m.home), { size: 26 }),
          el('i', {}, 'vs'),
          teamLogo(teamOf(m.away), { size: 26 }),
          el('em', { class: `qc-status ${m.status}` }, m.status === 'done' ? `${m.pts}:${m.oppPts}` : m.status === 'partial' ? `${m.count}/${TIERS.length}` : '예정'),
        ),
        el('span', { class: 'qc-names' }, `${m.homeName} · ${m.awayName}`),
      );
    });
  return el(
    'div',
    { class: 'quick' },
    el('p', { class: 'quick-label' }, `이번 주 경기 · ${week.week}주차`),
    el('div', { class: 'quick-chips' }, chips),
  );
}

function versusSide(team) {
  return el('div', { class: 'vs-side', style: { '--team': accentOf(team.name) } }, teamLogo(team, { size: 64 }), el('span', {}, team.name));
}

function renderInput() {
  if (!state.data.teams.length) {
    return [el('p', { class: 'empty' }, '팀 명단이 없습니다. 구글 시트 팀 탭을 확인해 주세요.')];
  }
  fixPick();
  // 입력칸을 최신 데이터로 새로 채우므로 "그사이 바뀌었습니다" 알림은 더 이상 맞지 않다.
  if (state.notice?.matchChanged) state.notice = null;
  const { teams, games } = state.data;
  const { a, b } = state.pick;
  const teamA = teamOf(a);
  const teamB = teamOf(b);
  const sameTeam = a === b;
  const existing = sameTeam ? null : gamesBetween(games, a, b);
  // 입력칸이 이 값으로 채워진다. 저장할 때 이것과 비교하므로, 그사이 새로 받은 데이터 때문에
  // 손대지 않은 판이 지워지거나 되돌아가지 않는다.
  state.formBase = existing ? { a, b, games: existing } : null;
  const sv = scheduleView(SCHEDULE, teams, games);
  const found = sameTeam ? null : pairWeek(sv, a, b);

  const teamSelect = (side, value) =>
    el(
      'select',
      { name: side, 'aria-label': side === 'a' ? '팀 A' : '팀 B', onchange: onPickChange, disabled: state.saving },
      teams.map((t) => el('option', { value: t.no, selected: t.no === value }, `${t.name} (${t.players.join('·')})`)),
    );

  const goalInput = (name, value, label) =>
    el('input', {
      class: 'goal',
      name,
      type: 'text',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: 2,
      autocomplete: 'off',
      'aria-label': label,
      value: value ?? '',
      oninput: markDirty,
    });

  const scoreRows = TIERS.map((tier) => {
    const before = existing?.[tier];
    const nameA = before?.pa || teamA.players[tier - 1] || '';
    const nameB = before?.pb || teamB.players[tier - 1] || '';
    return el(
      'div',
      { class: `score-row t${tier}` },
      el('span', { class: 'tier' }, `${tier}티어`),
      el('span', { class: 'name a', title: nameA }, nameA),
      goalInput(`ga${tier}`, before?.ga, `${tier}티어 ${nameA} 득점`),
      el('span', { class: 'colon', 'aria-hidden': 'true' }, ':'),
      goalInput(`gb${tier}`, before?.gb, `${tier}티어 ${nameB} 득점`),
      el('span', { class: 'name b', title: nameB }, nameB),
    );
  });

  const savedBy = storageGet(BY_KEY);
  const people = [...teamA.players, ...teamB.players].filter(Boolean);
  const bySelect = el(
    'select',
    { name: 'by', 'aria-label': '입력자', onchange: markDirty },
    el('option', { value: '' }, '입력자 선택'),
    [...people, ADMIN].map((p) => el('option', { value: p, selected: p === savedBy }, p)),
  );

  const locked = !state.unlocked;
  const form = el(
      'form',
      { class: `panel input-form${locked ? ' is-locked' : ''}`, onsubmit: onSave, novalidate: true, inert: locked },
      el(
        'header',
        { class: 'panel-head' },
        el('h2', {}, '결과 입력'),
        found
          ? el(
              'span',
              { class: `pair-week${found.w.current ? ' is-current' : ''}` },
              `${found.w.week}주차 대진${found.w.current ? ' · 이번 주' : ''} · ${matchStatusText(found.m)}`,
            )
          : null,
      ),
      quickPicks(sv),
      sameTeam
        ? null
        : el('div', { class: 'versus', 'aria-hidden': 'true' }, versusSide(teamA), el('span', { class: 'vs-mark' }, 'VS'), versusSide(teamB)),
      el('div', { class: 'pick' }, teamSelect('a', a), el('span', { class: 'vs' }, 'vs'), teamSelect('b', b)),
      sameTeam
        ? el('p', { class: 'notice error' }, '서로 다른 두 팀을 골라 주세요.')
        : el('div', { class: 'scores' }, scoreRows),
      el('div', { class: 'who' }, bySelect),
      el(
        'button',
        { type: 'submit', class: 'primary', disabled: state.saving || sameTeam },
        state.saving ? '저장 중…' : '저장',
      ),
      el(
        'div',
        { class: 'notice-slot', 'aria-live': 'polite' },
        state.notice ? el('p', { class: `notice ${state.notice.kind}` }, state.notice.text) : null,
      ),
      el(
        'p',
        { class: 'note' },
        '판마다 따로 저장됩니다. 아직 안 한 판은 비워 두세요. 잘못 넣은 판은 두 칸을 모두 지우고 저장하면 삭제됩니다.',
      ),
    );
  return [el('div', { class: 'input-wrap' }, form, locked ? pinGate() : null)];
}

// --- 입력 탭 비밀번호 ---

// 입력판 위에 덮는 비밀번호 창. 맞히면 unlockInput, 틀리면 서버 안내를 보여 준다.
function pinGate() {
  const input = el('input', {
    name: 'gate-pin',
    type: 'password',
    autocomplete: 'off',
    enterkeyhint: 'go',
    'aria-label': '클럽 비밀번호',
    placeholder: DEMO ? '데모 모드: 아무거나 넣으면 열려요' : '클럽 비밀번호',
  });
  const message = el('p', { class: 'gate-msg', 'aria-live': 'polite' }, state.gateError);
  const button = el('button', { type: 'submit', class: 'primary' }, '확인');
  setTimeout(() => {
    if (input.isConnected) input.focus({ preventScroll: true });
  }, 50);
  return el(
    'form',
    {
      class: 'pin-gate',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'gate-title',
      novalidate: true,
      onsubmit: (event) => onGateSubmit(event, { input, message, button }),
    },
    el('div', { class: 'gate-icon', 'aria-hidden': 'true' }),
    el('h3', { id: 'gate-title' }, '비밀번호를 넣어 주세요'),
    el('p', { class: 'gate-sub' }, '결과 입력은 클럽 비밀번호가 있어야 열립니다. 입력 탭에 들어올 때마다 물어봅니다.'),
    input,
    button,
    message,
  );
}

async function onGateSubmit(event, { input, message, button }) {
  event.preventDefault();
  if (state.gateChecking) return;
  const pin = input.value.trim();
  if (!pin) {
    message.textContent = '비밀번호를 넣어 주세요.';
    return;
  }
  state.gateChecking = true;
  button.disabled = true;
  button.textContent = '확인 중…';
  message.textContent = '';
  try {
    let result = { ok: true };
    if (!DEMO) {
      const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: 'checkPin', pin }) });
      result = await res.json();
    }
    // 확인하는 사이 다른 탭으로 갔으면 열지 않는다(돌아오면 다시 묻는다).
    if (!input.isConnected || state.tab !== 'input') return;
    if (!result.ok) {
      state.gateError = result.message || '비밀번호를 확인하지 못했습니다.';
      message.textContent = state.gateError;
      input.value = '';
      input.focus();
      return;
    }
    unlockInput(pin);
  } catch {
    message.textContent = '연결에 실패했습니다. 다시 시도해 주세요.';
  } finally {
    state.gateChecking = false;
    button.disabled = false;
    button.textContent = '확인';
  }
}

// 입력판을 연다. 비밀번호는 저장할 때 쓰도록 메모리에만 둔다.
function unlockInput(pin) {
  state.unlocked = true;
  state.pin = pin;
  state.gateError = '';
  const form = view.querySelector('form.input-form');
  if (form) {
    form.removeAttribute('inert');
    form.classList.remove('is-locked');
  }
  view.querySelector('.pin-gate')?.remove();
  document.body.classList.remove('is-typing');
}

// 입력판을 잠근다. 적어 둔 점수는 그대로 두고 비밀번호 창만 다시 덮는다(저장 중 비밀번호가 바뀐 경우 등).
function lockInput(reason = '') {
  state.unlocked = false;
  state.pin = '';
  state.gateError = reason;
  const form = view.querySelector('form.input-form');
  if (!form) return;
  form.setAttribute('inert', '');
  form.classList.add('is-locked');
  if (!view.querySelector('.pin-gate')) form.after(pinGate());
}

// --- 입력 동작 ---

function markDirty() {
  state.formDirty = true;
}

function openInput(a, b) {
  state.pick = { a, b };
  state.formDirty = false;
  state.notice = null;
  if (location.hash === '#input') {
    state.tab = 'input';
    render();
  } else {
    location.hash = '#input';
  }
}

// 한쪽을 상대 팀과 같은 팀으로 고르면 두 팀 자리를 바꾼다.
function onPickChange(event) {
  const value = Number(event.target.value);
  const { a, b } = state.pick;
  if (event.target.name === 'a') state.pick = value === b ? { a: value, b: a } : { a: value, b };
  else state.pick = value === a ? { a: b, b: value } : { a, b: value };
  state.formDirty = false;
  state.notice = null;
  render();
}

// 이번 주 경기 단추: 그 두 팀(홈 팀이 A)으로 입력칸을 다시 채운다. 팀 선택을 바꿀 때와 같다.
// 이미 고른 경기를 다시 누르면 아무것도 하지 않는다(적어 둔 점수를 지우지 않게).
// 같은 두 팀을 A·B만 바꿔 골라 둔 채 점수를 적고 있었다면 그대로 둔다.
function pickPair(a, b) {
  if (state.saving) return;
  const cur = state.pick;
  if (cur.a === a && cur.b === b) return;
  if (state.formDirty && cur.a === b && cur.b === a) return;
  state.pick = { a, b };
  state.formDirty = false;
  state.notice = null;
  render();
}

// 입력칸을 그대로 둔 채 알림만 바꾼다.
function showNotice(kind, text) {
  state.notice = { kind, text };
  view.querySelector('.notice-slot')?.replaceChildren(el('p', { class: `notice ${kind}` }, text));
}

function setSaving(form, saving) {
  state.saving = saving;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = saving;
  button.textContent = saving ? '저장 중…' : '저장';
  for (const select of form.querySelectorAll('select[name="a"], select[name="b"], .quick-chip')) select.disabled = saving;
}

// 저장 실패 처리. 저장하는 사이 화면이 다시 그려졌으면(탭 이동, 다른 경기 열기) 지금 보이는 폼을 풀어 주고,
// 입력값이 사라졌으니 어느 경기가 실패했는지 알려 준다.
function saveFailed(submittedForm, message, pairLabel, retryHint = false) {
  state.saving = false;
  const live = view.querySelector('form.input-form');
  if (live) setSaving(live, false);
  if (live === submittedForm) showNotice('error', retryHint ? `${message} 다시 저장해 주세요.` : message);
  else showNotice('error', `${pairLabel} 결과를 저장하지 못했습니다. ${message} 그 경기를 다시 열어 점수를 넣어 주세요.`);
}

async function onSave(event) {
  event.preventDefault();
  if (state.saving) return;
  const form = event.currentTarget;
  const { a, b } = state.pick;
  if (a === b) return;

  const inputs = Object.fromEntries(
    TIERS.map((t) => [t, { ga: form.elements[`ga${t}`].value, gb: form.elements[`gb${t}`].value }]),
  );
  const base =
    state.formBase?.a === a && state.formBase?.b === b ? state.formBase.games : gamesBetween(state.data.games, a, b);
  const { games, errors } = buildSaveGames(base, inputs);
  const by = form.elements.by.value;
  const pin = state.pin;
  if (!state.unlocked) {
    lockInput('비밀번호를 다시 넣어 주세요.');
    return;
  }
  if (errors.length) {
    showNotice('error', errors.map((e) => `${e.tier}티어: ${e.message}`).join(' '));
    return;
  }
  if (!games.length) {
    showNotice('info', '바뀐 점수가 없습니다.');
    return;
  }
  if (!by) {
    showNotice('error', '입력자를 골라 주세요.');
    return;
  }
  storageSet(BY_KEY, by);
  const pairLabel = `${teamOf(a).name} 대 ${teamOf(b).name}`;
  setSaving(form, true);
  showNotice('info', '저장 중…');
  try {
    let changed;
    if (DEMO) {
      const next = applySave(state.data.games, state.data.teams, { a, b, by, games }, new Date().toISOString());
      state.data = { ...state.data, games: next };
      changed = games.length;
    } else {
      const res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify({ action: 'save', pin, by, a, b, games }),
      });
      const body = await res.json();
      if (!body.ok) {
        saveFailed(form, body.message || '저장하지 못했습니다.', pairLabel);
        // 그사이 비밀번호가 바뀌었거나 잠겼으면 적어 둔 점수는 두고 비밀번호 창만 다시 띄운다.
        if ((body.error === 'PIN' || body.error === 'LOCKED') && state.tab === 'input') lockInput(body.message);
        return;
      }
      state.dataGen += 1; // 저장 전에 시작된 불러오기 결과가 이 데이터를 덮지 않게
      state.data = body.data;
      storageSet(CACHE_KEY, JSON.stringify(body.data));
      state.loadError = '';
      state.loadedAt = Date.now();
      changed = body.changed;
    }
    state.saving = false;
    // 저장하는 사이 다른 경기를 열었으면 그 폼의 입력은 건드리지 않고, 어느 경기를 저장했는지 붙여 알린다.
    const samePair = state.pick.a === a && state.pick.b === b;
    if (samePair) state.formDirty = false;
    const prefix = samePair ? '' : `${pairLabel} `;
    const notice = changed
      ? { kind: 'ok', text: `${prefix}${changed}판 저장했습니다.${DEMO ? ' 데모 모드라 이 화면에만 반영됩니다.' : ''}` }
      : { kind: 'info', text: `${prefix}이미 같은 점수로 저장돼 있습니다.` };
    const live = view.querySelector('form.input-form');
    if (live) setSaving(live, false);
    showNotice(notice.kind, notice.text);
    render();
  } catch {
    saveFailed(form, '연결에 실패했습니다.', pairLabel, true);
  }
}

// --- 시작 ---

function tabFromHash() {
  const name = location.hash.slice(1);
  return TABS.includes(name) ? name : 'standings';
}

window.addEventListener('hashchange', () => {
  const previous = state.tab;
  state.tab = tabFromHash();
  if (state.tab !== 'input') state.formDirty = false;
  const moved = state.tab !== previous;
  // 입력 탭을 떠나면 다시 잠근다. 돌아오면 비밀번호를 또 묻는다.
  if (moved && previous === 'input') {
    state.unlocked = false;
    state.pin = '';
    state.gateError = '';
  }
  if (moved) state.scrollWeek = state.tab === 'schedule';
  render();
  // 탭을 옮기면 맨 위에서 시작한다(일정 탭은 render가 이번 주로 스크롤).
  if (moved && state.tab !== 'schedule') window.scrollTo(0, 0);
});

refreshButton.addEventListener('click', () => load());

for (const button of lookButtons) button.addEventListener('click', () => setLook(button.dataset.look));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !DEMO && Date.now() - state.loadedAt > AUTO_REFRESH_MS) load();
  // 뒤로 가 있는 사이 3D 그림판을 잃었으면(recoverCards) 돌아왔을 때 무대를 다시 만든다.
  if (document.visibilityState === 'visible' && state.data && cards.mode === 'idle') syncHero();
});

// 무대 크기: 머리글 높이가 바뀌거나(상태 줄 줄바꿈·글꼴) 화면 크기가 바뀌면 다시 잰다.
if ('ResizeObserver' in window) new ResizeObserver(() => measureStage()).observe(document.querySelector('.topbar'));
window.addEventListener('resize', () => measureStage());

// 폰에서 점수·비밀번호 칸에 글자를 넣는 동안(화면 키보드가 떠 있는 동안)은 아래 탭 막대를 치워
// 입력칸을 가리지 않게 한다(style.css body.is-typing).
function syncTyping(target) {
  const typing = !!target?.matches?.('.input-form input, .pin-gate input');
  document.body.classList.toggle('is-typing', typing);
}
document.addEventListener('focusin', (event) => syncTyping(event.target));
document.addEventListener('focusout', (event) => syncTyping(event.relatedTarget));

state.tab = tabFromHash();
state.scrollWeek = state.tab === 'schedule';
load();
