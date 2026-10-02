// NV 내전 리그 화면: 데이터 불러오기·저장과 탭별 그리기.
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

const DEMO = !API_URL;
const CACHE_KEY = 'nv-league:data';
const BY_KEY = 'nv-league:by';
const TABS = ['standings', 'matrix', 'players', 'input'];
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
  pin: '',
  notice: null, // { kind: 'ok' | 'error' | 'info', text }
};

const view = document.getElementById('view');
const statusLine = document.getElementById('status');
const refreshButton = document.getElementById('refresh');

// --- 도우미 ---

// 요소 만들기. 글자는 항상 텍스트 노드로 넣는다(innerHTML 안 씀).
function el(tag, attrs = {}, ...children) {
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
function warnIfMatchChanged(nextData) {
  const base = state.formBase;
  if (state.tab !== 'input' || !state.formDirty || !base) return;
  if (sameScores(gamesBetween(nextData.games, base.a, base.b), base.games)) return;
  showNotice(
    'info',
    '그사이 다른 기기에서 이 경기 결과가 바뀌었습니다. 저장하면 내가 고친 판만 바뀌고, 나머지 판은 새 결과가 그대로 남습니다.',
  );
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
    delete view.dataset.tab;
    view.replaceChildren(
      el('p', { class: 'empty' }, state.loading ? '불러오는 중…' : '표시할 결과가 없습니다. 새로고침해 보세요.'),
    );
    return;
  }
  // 점수를 입력하는 도중에는 새로 받은 데이터로 입력칸을 갈아엎지 않는다.
  if (state.tab === 'input' && state.formDirty && view.dataset.tab === 'input') return;
  view.dataset.tab = state.tab;
  const panel = { standings: renderStandings, matrix: renderMatrix, players: renderPlayers, input: renderInput };
  view.replaceChildren(...panel[state.tab]());
}

// 두 번째 열(팀·선수)만 왼쪽 정렬
function headRow(labels) {
  return el(
    'thead',
    {},
    el('tr', {}, labels.map((label, i) => el('th', { scope: 'col', class: i === 1 ? 'left' : null }, label))),
  );
}

function renderStandings() {
  const { teams, games, settings } = state.data;
  const s = computeTeamStandings(teams, games, settings);
  const body = s.rows.map((r) =>
    el(
      'tr',
      { class: r.star ? 'leader' : null },
      el('td', { class: 'rank' }, r.rank, r.star ? el('span', { class: 'star', title: '1위' }, '★') : null),
      el(
        'td',
        { class: 'team' },
        el('strong', {}, r.name),
        r.playoff ? el('span', { class: 'badge' }, '결정전 대기') : null,
        el('span', { class: 'members' }, r.players.join(' · ')),
      ),
      el('td', {}, `${r.played}/${teams.length - 1}`),
      el('td', {}, `${r.w}-${r.d}-${r.l}`),
      el('td', { class: 'pts' }, r.pts),
      el('td', {}, r.scored),
      el('td', {}, r.conceded),
      el('td', {}, signed(r.diff)),
    ),
  );
  return [
    el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', {}, '팀 순위'),
        el('span', { class: 'muted' }, `${s.recordedGames}/${s.totalMatches * TIERS.length}판 진행`),
      ),
      s.playoffPending
        ? el(
            'p',
            { class: 'callout' },
            '모든 경기가 끝났고 1위가 승점·골득실 동률입니다. 3:3 결정전 뒤 운영자가 구글 시트 설정 탭에 승자 팀 번호를 적으면 반영됩니다.',
          )
        : null,
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'standings' },
          headRow(['순위', '팀', '경기', '승-무-패', '승점', '득점', '실점', '득실']),
          el('tbody', {}, body),
        ),
      ),
      el(
        'p',
        { class: 'note' },
        '승-무-패와 득실은 판 기준입니다. 경기는 3판이 모두 입력된 경기만 셉니다. 순위는 승점 → 골득실 → 다득점.',
      ),
    ),
  ];
}

function renderMatrix() {
  const { teams, games } = state.data;
  const cells = computeMatrix(teams, games);
  const head = el(
    'thead',
    {},
    el('tr', {}, el('th', { scope: 'col' }, ''), teams.map((t) => el('th', { scope: 'col', title: t.name }, t.no))),
  );
  const rows = teams.map((rowTeam) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row', title: rowTeam.players.join(' · ') }, rowTeam.name),
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
              class: `cell ${outcome}`,
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
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, '경기표'), el('span', { class: 'muted' }, '행 팀 기준 승점')),
      el('div', { class: 'table-wrap' }, el('table', { class: 'matrix' }, head, el('tbody', {}, rows))),
      el(
        'p',
        { class: 'note' },
        '칸을 누르면 그 경기 결과를 입력하거나 고칩니다. 작은 숫자 2/3은 3판 중 2판만 입력된 경기입니다.',
      ),
    ),
  ];
}

function renderPlayers() {
  const { teams, games } = state.data;
  const stats = computePlayerStats(teams, games);
  return TIERS.map((tier) =>
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, `${tier}티어`)),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'players' },
          headRow(['순위', '선수', '승-무-패', '승점', '득점', '실점', '득실']),
          el(
            'tbody',
            {},
            stats[tier].map((p) =>
              el(
                'tr',
                {},
                el('td', { class: 'rank' }, p.rank),
                el(
                  'td',
                  { class: 'team' },
                  el('strong', {}, p.name),
                  el('span', { class: 'members' }, teamOf(p.teamNo)?.name ?? `${p.teamNo}팀`),
                ),
                el('td', {}, `${p.w}-${p.d}-${p.l}`),
                el('td', { class: 'pts' }, p.pts),
                el('td', {}, p.scored),
                el('td', {}, p.conceded),
                el('td', {}, signed(p.diff)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function fixPick() {
  const nos = state.data.teams.map((t) => t.no);
  if (!nos.includes(state.pick.a)) state.pick.a = nos[0];
  if (!nos.includes(state.pick.b) || state.pick.b === state.pick.a) {
    state.pick.b = nos.find((n) => n !== state.pick.a) ?? state.pick.a;
  }
}

function renderInput() {
  if (!state.data.teams.length) {
    return [el('p', { class: 'empty' }, '팀 명단이 없습니다. 구글 시트 팀 탭을 확인해 주세요.')];
  }
  fixPick();
  const { teams, games } = state.data;
  const { a, b } = state.pick;
  const teamA = teamOf(a);
  const teamB = teamOf(b);
  const sameTeam = a === b;
  const existing = sameTeam ? null : gamesBetween(games, a, b);
  // 입력칸이 이 값으로 채워진다. 저장할 때 이것과 비교하므로, 그사이 새로 받은 데이터 때문에
  // 손대지 않은 판이 지워지거나 되돌아가지 않는다.
  state.formBase = existing ? { a, b, games: existing } : null;

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
      { class: 'score-row' },
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

  const pinInput = el('input', {
    name: 'pin',
    type: 'password',
    autocomplete: 'off',
    placeholder: DEMO ? '데모 모드는 확인 안 함' : '클럽 공용 비밀번호',
    'aria-label': '비밀번호',
    value: state.pin,
    oninput: (event) => {
      state.pin = event.target.value;
    },
  });

  return [
    el(
      'form',
      { class: 'card input-form', onsubmit: onSave, novalidate: true },
      el('div', { class: 'card-head' }, el('h2', {}, '결과 입력')),
      el('div', { class: 'pick' }, teamSelect('a', a), el('span', { class: 'vs' }, 'vs'), teamSelect('b', b)),
      sameTeam
        ? el('p', { class: 'notice error' }, '서로 다른 두 팀을 골라 주세요.')
        : el('div', { class: 'scores' }, scoreRows),
      el('div', { class: 'who' }, bySelect, pinInput),
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
    ),
  ];
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
  for (const select of form.querySelectorAll('select[name="a"], select[name="b"]')) select.disabled = saving;
}

// 저장 실패 처리. 저장하는 사이 화면이 다시 그려졌으면(탭 이동 등) 지금 보이는 폼을 풀어 준다.
function saveFailed(submittedForm, message) {
  state.saving = false;
  const live = view.querySelector('form.input-form');
  if (live) setSaving(live, false);
  const kept = live === submittedForm;
  showNotice('error', kept ? message : `${message} 점수를 다시 넣어 주세요.`);
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
  const pin = form.elements.pin.value.trim();
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
  if (!DEMO && !pin) {
    showNotice('error', '비밀번호를 넣어 주세요.');
    return;
  }

  storageSet(BY_KEY, by);
  state.pin = pin;
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
        saveFailed(form, body.message || '저장하지 못했습니다.');
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
    state.formDirty = false;
    state.notice = changed
      ? { kind: 'ok', text: `${changed}판 저장했습니다.${DEMO ? ' 데모 모드라 이 화면에만 반영됩니다.' : ''}` }
      : { kind: 'info', text: '이미 같은 점수로 저장돼 있습니다.' };
    render();
  } catch {
    saveFailed(form, '연결에 실패했습니다. 다시 저장해 주세요.');
  }
}

// --- 시작 ---

function tabFromHash() {
  const name = location.hash.slice(1);
  return TABS.includes(name) ? name : 'standings';
}

window.addEventListener('hashchange', () => {
  state.tab = tabFromHash();
  if (state.tab !== 'input') state.formDirty = false;
  render();
});

refreshButton.addEventListener('click', () => load());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !DEMO && Date.now() - state.loadedAt > AUTO_REFRESH_MS) load();
});

state.tab = tabFromHash();
load();
