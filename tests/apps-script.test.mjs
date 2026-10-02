import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const PIN = 'nv2468';
const NOW = new Date('2026-10-02T12:00:00Z');

// --- 구글 시트 흉내 ---

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (!(numRows >= 1 && numCols >= 1)) throw new Error(`범위 크기는 1 이상이어야 합니다: ${numRows}x${numCols}`);
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() {
    return this.sheet.cell(this.row, this.col);
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some((line) => line.length !== this.numCols)) {
      throw new Error('setValues 크기가 범위와 다릅니다');
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.setCell(this.row + r, this.col + c, v)));
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet.setCell(this.row + r, this.col + c, '');
    }
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.formats = [];
    this.frozen = 0;
  }
  getName() {
    return this.name;
  }
  cell(r, c) {
    return this.rows[r - 1]?.[c - 1] ?? '';
  }
  setCell(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    this.rows[r - 1][c - 1] = v;
  }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if (this.rows[r - 1].some((v) => v !== '' && v != null)) return r;
    }
    return 0;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') {
      // 'F:G' 같은 열 전체 표기는 서식 지정에만 쓴다.
      return { setNumberFormat: (fmt) => this.formats.push([row, fmt]) };
    }
    return new FakeRange(this, row, col, numRows, numCols);
  }
  setFrozenRows(n) {
    this.frozen = n;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [new FakeSheet('시트1')];
  }
  getSheetByName(name) {
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  getSheets() {
    return [...this.sheets];
  }
  deleteSheet(sheet) {
    this.sheets = this.sheets.filter((s) => s !== sheet);
  }
}

function load({ pin = PIN } = {}) {
  const ss = new FakeSpreadsheet();
  const props = new Map(pin == null ? [] : [['PIN', pin]]);
  const cache = new Map();
  const lock = {
    held: false,
    waitLock() {
      this.held = true;
    },
    releaseLock() {
      this.held = false;
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null) }) },
    CacheService: {
      getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }),
    },
    LockService: { getScriptLock: () => lock },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        mime: null,
        setMimeType(m) {
          this.mime = m;
          return this;
        },
        getContent() {
          return this.text;
        },
      }),
    },
    Logger: { log: () => {} },
  });
  vm.runInContext(CODE, context);
  return { gs: context, ss, lock };
}

// vm 안에서 만든 객체를 일반 객체로 바꾼다(deepEqual의 프로토타입 비교 때문).
const plain = (v) => JSON.parse(JSON.stringify(v));

function ready(options) {
  const env = load(options);
  env.gs.setup();
  return env;
}

function post(env, body, now = NOW) {
  return plain(env.gs.handlePost_({ postData: { contents: JSON.stringify(body) } }, now));
}

const base = { action: 'save', pin: PIN, by: '스톰', a: 1, b: 2 };
const sheet = (env, name) => env.ss.getSheetByName(name);

test('setup은 탭 4개를 만들고 명단을 채우며, 다시 실행해도 겹치지 않는다', () => {
  const env = ready();
  env.gs.setup();
  assert.deepEqual(env.ss.sheets.map((s) => s.name), ['팀', '결과', '기록', '설정']);
  const teams = sheet(env, '팀');
  assert.equal(teams.getLastRow(), 10);
  assert.equal(teams.frozen, 1);
  assert.deepEqual(plain(teams.rows[0]), ['팀번호', '팀이름', '1티어', '2티어', '3티어']);
  assert.deepEqual(plain(teams.rows[1]), [1, '1팀', '스톰', '자본', '현우']);
  assert.deepEqual(plain(teams.rows[9]), [9, '9팀', '뚝배기', '치노', '수프러차']);
  assert.ok(sheet(env, '기록').formats.some(([range, fmt]) => range === 'F:G' && fmt === '@'));
  assert.deepEqual(plain(sheet(env, '설정').rows[1]), ['결정전 승자 팀 번호', '']);
});

test('doGet은 팀 9개와 빈 결과를 JSON으로 돌려준다', () => {
  const env = ready();
  const out = env.gs.doGet({ parameter: {} });
  assert.equal(out.mime, 'application/json');
  const body = JSON.parse(out.getContent());
  assert.equal(body.ok, true);
  assert.equal(body.data.teams.length, 9);
  assert.deepEqual(body.data.teams[8], { no: 9, name: '9팀', players: ['뚝배기', '치노', '수프러차'] });
  assert.deepEqual(body.data.games, []);
  assert.deepEqual(body.data.settings, { playoffWinner: null });
  assert.equal(typeof body.data.serverTime, 'string');
});

test('알 수 없는 GET action은 INVALID', () => {
  const env = ready();
  assert.equal(plain(env.gs.handleGet_({ parameter: { action: 'drop' } })).error, 'INVALID');
});

test('PIN이 설정되지 않았으면 SETUP 오류', () => {
  const env = ready({ pin: null });
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'SETUP');
});

test('비밀번호가 틀리면 PIN 오류이고 아무것도 쓰지 않는다', () => {
  const env = ready();
  const res = post(env, { ...base, pin: '0000', games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'PIN');
  assert.equal(sheet(env, '결과').getLastRow(), 1);
  assert.equal(sheet(env, '기록').getLastRow(), 1);
});

test('비밀번호 앞뒤 공백은 무시한다', () => {
  const env = ready({ pin: ` ${PIN} ` });
  assert.equal(post(env, { ...base, pin: `${PIN} `, games: [{ tier: 1, ga: 1, gb: 0 }] }).ok, true);
});

test('비밀번호를 30번 틀리면 맞는 비밀번호도 잠시 막는다', () => {
  const env = ready();
  for (let i = 0; i < 30; i++) post(env, { ...base, pin: 'x', games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'LOCKED');
});

test('팀 번호가 큰 쪽이 A로 와도 작은 팀 기준으로 뒤집어 저장하고 기록을 남긴다', () => {
  const env = ready();
  const res = post(env, { ...base, by: '범수', a: 2, b: 1, games: [{ tier: 1, ga: 3, gb: 1 }] });
  assert.equal(res.ok, true);
  assert.equal(res.changed, 1);
  assert.deepEqual(res.data.games, [
    { a: 1, b: 2, tier: 1, ga: 1, gb: 3, pa: '스톰', pb: '범수', at: '2026-10-02T12:00:00.000Z', by: '범수' },
  ]);
  assert.deepEqual(plain(sheet(env, '기록').rows[1]), ['2026-10-02T12:00:00.000Z', '범수', 1, 2, 1, '(없음)', '1:3']);
  assert.equal(env.lock.held, false);
});

test('같은 점수를 다시 저장하면 바뀐 판 0, 기록도 늘지 않는다', () => {
  const env = ready();
  post(env, { ...base, games: [{ tier: 1, ga: 2, gb: 2 }] });
  const res = post(env, { ...base, games: [{ tier: 1, ga: 2, gb: 2 }] });
  assert.equal(res.ok, true);
  assert.equal(res.changed, 0);
  assert.equal(sheet(env, '기록').getLastRow(), 2);
});

test('점수를 고치면 덮어쓰고, null/null이면 그 판을 지운다', () => {
  const env = ready();
  post(env, { ...base, games: [{ tier: 1, ga: 2, gb: 2 }, { tier: 2, ga: 0, gb: 1 }] });
  const later = new Date('2026-10-03T09:30:00Z');
  const res = post(
    env,
    { ...base, by: '운영진', games: [{ tier: 1, ga: 4, gb: 2 }, { tier: 2, ga: null, gb: null }] },
    later,
  );
  assert.equal(res.changed, 2);
  assert.deepEqual(res.data.games.map((g) => [g.tier, g.ga, g.gb, g.by, g.at]), [[1, 4, 2, '운영진', '2026-10-03T09:30:00.000Z']]);
  const log = plain(sheet(env, '기록').rows.slice(3));
  assert.deepEqual(log.map((r) => r.slice(1)), [
    ['운영진', 1, 2, 1, '2:2', '4:2'],
    ['운영진', 1, 2, 2, '0:1', '삭제'],
  ]);
  assert.equal(sheet(env, '결과').getLastRow(), 2);
});

test('없는 판을 지우라고 하면 바뀐 판 0', () => {
  const env = ready();
  const res = post(env, { ...base, games: [{ tier: 3, ga: null, gb: null }] });
  assert.equal(res.ok, true);
  assert.equal(res.changed, 0);
});

test('입력자가 그 경기 6명이나 운영진이 아니면 INVALID', () => {
  const env = ready();
  assert.equal(post(env, { ...base, by: '레오', games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'INVALID');
  assert.equal(post(env, { ...base, by: '', games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'INVALID');
  assert.equal(post(env, { ...base, by: '맹구', games: [{ tier: 1, ga: 1, gb: 0 }] }).ok, true);
});

test('점수·팀·티어가 잘못되면 INVALID이고 아무것도 쓰지 않는다', () => {
  const env = ready();
  const bad = [
    { ...base, games: [{ tier: 1, ga: 31, gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: -1, gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: 1.5, gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: '3', gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: 3, gb: null }] },
    { ...base, games: [{ tier: 4, ga: 1, gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: 1, gb: 0 }, { tier: 1, ga: 2, gb: 0 }] },
    { ...base, games: [{ tier: 1, ga: 1, gb: 0 }, { tier: 2, ga: 31, gb: 0 }] },
    { ...base, games: [] },
    { ...base, games: 'x' },
    { ...base, b: 1, games: [{ tier: 1, ga: 1, gb: 0 }] },
    { ...base, b: 10, games: [{ tier: 1, ga: 1, gb: 0 }] },
  ];
  for (const body of bad) assert.equal(post(env, body).error, 'INVALID', JSON.stringify(body));
  assert.equal(sheet(env, '결과').getLastRow(), 1);
  assert.equal(sheet(env, '기록').getLastRow(), 1);
});

test('본문이 JSON이 아니거나 action이 다르면 INVALID', () => {
  const env = ready();
  assert.equal(plain(env.gs.handlePost_({ postData: { contents: 'not json' } }, NOW)).error, 'INVALID');
  assert.equal(plain(env.gs.handlePost_({}, NOW)).error, 'INVALID');
  assert.equal(post(env, { ...base, action: 'drop' }).error, 'INVALID');
});

test('doPost는 결과를 JSON 텍스트로 돌려준다', () => {
  const env = ready();
  const out = env.gs.doPost({ postData: { contents: JSON.stringify({ ...base, games: [{ tier: 3, ga: 0, gb: 0 }] }) } });
  assert.equal(out.mime, 'application/json');
  assert.equal(JSON.parse(out.getContent()).changed, 1);
});

test('잠금을 못 얻으면 BUSY', () => {
  const env = ready();
  env.lock.waitLock = () => {
    throw new Error('timeout');
  };
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'BUSY');
});

test('운영자가 직접 넣은 이상한 줄은 건너뛰되 지우지 않고, 결정전 승자를 읽는다', () => {
  const env = ready();
  sheet(env, '결과').getRange(2, 1, 1, 9).setValues([['메모', '', '', '', '', '', '', '', '']]);
  sheet(env, '설정').getRange(2, 2).setValues([[7]]);
  const res = post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(res.data.games.length, 1);
  assert.deepEqual(res.data.settings, { playoffWinner: 7 });
  assert.ok(sheet(env, '결과').rows.some((r) => r[0] === '메모'));
});

test('팀 탭에서 선수를 바꾸면 새 선수가 입력자로 허용되고 판에 그 이름이 저장된다', () => {
  const env = ready();
  sheet(env, '팀').getRange(2, 3).setValues([['대타']]);
  const res = post(env, { ...base, by: '대타', games: [{ tier: 1, ga: 2, gb: 0 }] });
  assert.equal(res.ok, true);
  assert.equal(res.data.games[0].pa, '대타');
  assert.equal(post(env, { ...base, by: '스톰', games: [{ tier: 2, ga: 0, gb: 0 }] }).error, 'INVALID');
});
