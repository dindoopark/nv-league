import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const PIN = 'test-only-pin'; // 시험용. 실제 비밀번호로 쓰지 마세요
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

// 'F:G', 'I:I' 같은 열 표기 → 열 번호 목록
function columnsOf(a1) {
  const [from, to = from] = a1.split(':');
  const n = (s) => s.charCodeAt(0) - 64;
  const out = [];
  for (let c = n(from); c <= n(to); c++) out.push(c);
  return out;
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.formats = [];
    this.textCols = new Set();
    this.frozen = 0;
    this.maxRows = 1000; // 새 시트의 기본 줄 수
  }
  getName() {
    return this.name;
  }
  cell(r, c) {
    return this.rows[r - 1]?.[c - 1] ?? '';
  }
  setCell(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    // 실제 시트처럼, 글자 서식(@)이 아닌 칸에 숫자처럼 보이는 글자를 넣으면 숫자가 된다.
    if (typeof v === 'string' && !this.textCols.has(c) && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
    this.rows[r - 1][c - 1] = v;
  }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if (this.rows[r - 1].some((v) => v !== '' && v != null)) return r;
    }
    return 0;
  }
  getMaxRows() {
    return this.maxRows;
  }
  insertRowsAfter(after, count) {
    if (after < this.rows.length) this.rows.splice(after, 0, ...Array.from({ length: count }, () => []));
    this.maxRows += count;
  }
  deleteRow(r) {
    // 실제 시트는 고정되지 않은 줄을 모두 지우려 하면 오류를 낸다.
    if (this.maxRows - 1 <= this.frozen) throw new Error('고정되지 않은 줄을 모두 지울 수 없습니다');
    this.rows.splice(r - 1, 1);
    this.maxRows -= 1;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') {
      // 'F:G' 같은 열 전체 표기는 서식 지정에만 쓴다.
      return {
        setNumberFormat: (fmt) => {
          this.formats.push([row, fmt]);
          if (fmt === '@') for (const c of columnsOf(row)) this.textCols.add(c);
        },
      };
    }
    if (row + numRows - 1 > this.maxRows) throw new Error('범위가 시트 크기를 벗어났습니다');
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
  const clock = { ms: NOW.getTime() }; // 캐시 만료와 post()의 기본 시각이 이 시계를 따른다
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
      getScriptCache: () => ({
        get: (k) => {
          const entry = cache.get(k);
          return entry && entry.until > clock.ms ? entry.value : null;
        },
        put: (k, v, sec = 600) => {
          if (typeof v !== 'string') throw new Error('캐시 값은 글자여야 합니다');
          cache.set(k, { value: v, until: clock.ms + sec * 1000 });
        },
      }),
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
  return { gs: context, ss, lock, clock };
}

// vm 안에서 만든 객체를 일반 객체로 바꾼다(deepEqual의 프로토타입 비교 때문).
const plain = (v) => JSON.parse(JSON.stringify(v));

function ready(options) {
  const env = load(options);
  env.gs.setup();
  return env;
}

function post(env, body, now = new Date(env.clock.ms)) {
  return plain(env.gs.handlePost_({ postData: { contents: JSON.stringify(body) } }, now));
}

const base = { action: 'save', pin: PIN, by: '조이', a: 1, b: 2 };
const sheet = (env, name) => env.ss.getSheetByName(name);

test('setup은 탭 4개를 만들고 명단을 채우며, 다시 실행해도 겹치지 않는다', () => {
  const env = ready();
  env.gs.setup();
  assert.deepEqual(env.ss.sheets.map((s) => s.name), ['팀', '결과', '기록', '설정']);
  const teams = sheet(env, '팀');
  assert.equal(teams.getLastRow(), 10);
  assert.equal(teams.frozen, 1);
  assert.deepEqual(plain(teams.rows[0]), ['팀번호', '팀이름', '1티어', '2티어', '3티어']);
  assert.deepEqual(plain(teams.rows[1]), [1, '시그니엘', '스톰', '자본', '현우']);
  assert.deepEqual(plain(teams.rows[9]), [9, '대갈장군', '뚝배기', '치노', '수프러차']);
  assert.ok(sheet(env, '기록').formats.some(([range, fmt]) => range === 'F:G' && fmt === '@'));
  assert.deepEqual(plain(sheet(env, '설정').rows[1]), ['결정전 승자 팀 번호', '']);
  assert.deepEqual(plain(sheet(env, '설정').rows[2]), ['운영진 명단', '조이, 병희, 정민, 뚝배기, 하지, 치노']);
  assert.equal(sheet(env, '설정').getLastRow(), 3);
});

test('doGet은 팀 9개와 빈 결과를 JSON으로 돌려준다', () => {
  const env = ready();
  const out = env.gs.doGet({ parameter: {} });
  assert.equal(out.mime, 'application/json');
  const body = JSON.parse(out.getContent());
  assert.equal(body.ok, true);
  assert.equal(body.data.teams.length, 9);
  assert.deepEqual(body.data.teams[8], { no: 9, name: '대갈장군', players: ['뚝배기', '치노', '수프러차'] });
  assert.deepEqual(body.data.games, []);
  assert.deepEqual(body.data.settings, { playoffWinner: null, staff: ['조이', '병희', '정민', '뚝배기', '하지', '치노'] });
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
  const res = post(env, { ...base, by: '하지', a: 2, b: 1, games: [{ tier: 1, ga: 3, gb: 1 }] });
  assert.equal(res.ok, true);
  assert.equal(res.changed, 1);
  assert.deepEqual(res.data.games, [
    { a: 1, b: 2, tier: 1, ga: 1, gb: 3, pa: '스톰', pb: '태현', at: '2026-10-02T12:00:00.000Z', by: '하지' },
  ]);
  assert.deepEqual(plain(sheet(env, '기록').rows[1]), ['2026-10-02T12:00:00.000Z', '하지', 1, 2, 1, '(없음)', '1:3']);
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
    { ...base, by: '정민', games: [{ tier: 1, ga: 4, gb: 2 }, { tier: 2, ga: null, gb: null }] },
    later,
  );
  assert.equal(res.changed, 2);
  assert.deepEqual(res.data.games.map((g) => [g.tier, g.ga, g.gb, g.by, g.at]), [[1, 4, 2, '정민', '2026-10-03T09:30:00.000Z']]);
  const log = plain(sheet(env, '기록').rows.slice(3));
  assert.deepEqual(log.map((r) => r.slice(1)), [
    ['정민', 1, 2, 1, '2:2', '4:2'],
    ['정민', 1, 2, 2, '0:1', '삭제'],
  ]);
  assert.equal(sheet(env, '결과').getLastRow(), 2);
});

test('없는 판을 지우라고 하면 바뀐 판 0', () => {
  const env = ready();
  const res = post(env, { ...base, games: [{ tier: 3, ga: null, gb: null }] });
  assert.equal(res.ok, true);
  assert.equal(res.changed, 0);
});

test('입력자는 운영진 명단에 있는 사람만 된다(그 경기 선수나 공용 "운영진"도 안 됨)', () => {
  const env = ready();
  const g = [{ tier: 1, ga: 1, gb: 0 }];
  for (const by of ['스톰', '범수', '레오', '운영진', '', '조이 ']) {
    const res = post(env, { ...base, by, games: g });
    if (by === '조이 ') assert.equal(res.ok, true, '앞뒤 공백은 무시');
    else assert.equal(res.error, 'INVALID', by);
  }
  assert.equal(post(env, { ...base, by: '치노', games: [{ tier: 2, ga: 1, gb: 0 }] }).ok, true);
});

test('설정 탭의 운영진 명단을 고치면 바로 적용되고, 비우면 기본 명단을 쓴다', () => {
  const env = ready();
  const settings = sheet(env, '설정');
  settings.getRange(3, 2).setValues([['조이 / 새운영진\n하지']]);
  const res = post(env, { ...base, by: '새운영진', games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.settings.staff, ['조이', '새운영진', '하지']);
  assert.equal(post(env, { ...base, by: '병희', games: [{ tier: 2, ga: 1, gb: 0 }] }).error, 'INVALID');
  settings.getRange(3, 2).setValues([['']]);
  assert.equal(post(env, { ...base, by: '병희', games: [{ tier: 2, ga: 1, gb: 0 }] }).ok, true);
});

test('운영진 명단 줄이 없는 예전 시트도 setup을 다시 돌리면 명단 줄이 생긴다', () => {
  const env = ready();
  const settings = sheet(env, '설정');
  settings.getRange(3, 1, 1, 2).setValues([['', '']]);
  assert.equal(settings.getLastRow(), 2);
  assert.deepEqual(JSON.parse(env.gs.doGet({ parameter: {} }).getContent()).data.settings.staff.length, 6);
  env.gs.setup();
  assert.deepEqual(plain(settings.rows[2]), ['운영진 명단', '조이, 병희, 정민, 뚝배기, 하지, 치노']);
  env.gs.setup();
  assert.equal(settings.getLastRow(), 3);
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
  assert.equal(res.data.settings.playoffWinner, 7);
  assert.ok(sheet(env, '결과').rows.some((r) => r[0] === '메모'));
});

test('팀 탭에서 선수를 바꾸면 새 선수가 입력자로 허용되고 판에 그 이름이 저장된다', () => {
  const env = ready();
  sheet(env, '팀').getRange(2, 3).setValues([['대타']]);
  const res = post(env, { ...base, by: '뚝배기', games: [{ tier: 1, ga: 2, gb: 0 }] });
  assert.equal(res.ok, true);
  assert.equal(res.data.games[0].pa, '대타');
  assert.equal(post(env, { ...base, by: '스톰', games: [{ tier: 2, ga: 0, gb: 0 }] }).error, 'INVALID');
});

test('비밀번호를 30번 틀려 잠기면 10분 뒤 풀린다', () => {
  const env = ready();
  for (let i = 0; i < 30; i++) post(env, { ...base, pin: 'x', games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'LOCKED');
  env.clock.ms += 9 * 60 * 1000;
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'LOCKED');
  env.clock.ms += 2 * 60 * 1000;
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).ok, true);
});

test('10분 창 밖으로 흩어진 비밀번호 실패는 쌓이지 않는다', () => {
  const env = ready();
  for (let i = 0; i < 30; i++) {
    post(env, { ...base, pin: 'x', games: [{ tier: 1, ga: 1, gb: 0 }] });
    env.clock.ms += 5 * 60 * 1000;
  }
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).ok, true);
});

test('선수를 바꾼 뒤 예전 판 점수를 고쳐도 그 판의 선수 이름은 그대로다', () => {
  const env = ready();
  post(env, { ...base, games: [{ tier: 1, ga: 3, gb: 0 }] });
  sheet(env, '팀').getRange(2, 3).setValues([['대타']]);
  const res = post(env, { ...base, by: '하지', games: [{ tier: 1, ga: 3, gb: 1 }] });
  assert.equal(res.changed, 1);
  assert.deepEqual(res.data.games.map((g) => [g.ga, g.gb, g.pa, g.pb]), [[3, 1, '스톰', '태현']]);
});

test('운영자가 큰 팀 번호를 앞에 적은 줄도 페이지에서 고치고 지울 수 있다', () => {
  const env = ready();
  sheet(env, '결과').getRange(2, 1, 1, 9).setValues([[5, 2, 1, 3, 0, '레오', '범수', '', '운영진']]);
  const fixed = post(env, { ...base, by: '하지', a: 2, b: 5, games: [{ tier: 1, ga: 1, gb: 1 }] });
  assert.equal(fixed.changed, 1);
  assert.deepEqual(
    fixed.data.games.map((g) => [g.a, g.b, g.tier, g.ga, g.gb, g.pa, g.pb]),
    [[2, 5, 1, 1, 1, '범수', '레오']],
  );
  assert.deepEqual(plain(sheet(env, '기록').rows[1]).slice(5), ['0:3', '1:1']);
  const removed = post(env, { ...base, by: '하지', a: 2, b: 5, games: [{ tier: 1, ga: null, gb: null }] });
  assert.equal(removed.changed, 1);
  assert.deepEqual(removed.data.games, []);
  assert.equal(sheet(env, '결과').getLastRow(), 1);
});

test('같은 판이 두 줄이면 화면에 보이는 마지막 줄을 기준으로 고치고 나머지 줄은 지운다', () => {
  const env = ready();
  sheet(env, '결과').getRange(2, 1, 2, 9).setValues([
    [1, 2, 1, 0, 3, '스톰', '범수', '', '스톰'],
    [1, 2, 1, 2, 2, '스톰', '범수', '', '운영진'],
  ]);
  const res = post(env, { ...base, games: [{ tier: 1, ga: 4, gb: 2 }] });
  assert.deepEqual(plain(sheet(env, '기록').rows[1]).slice(5), ['2:2', '4:2']);
  assert.deepEqual(res.data.games.map((g) => [g.ga, g.gb]), [[4, 2]]);
  assert.equal(sheet(env, '결과').getLastRow(), 2);
  assert.deepEqual(post(env, { ...base, games: [{ tier: 1, ga: null, gb: null }] }).data.games, []);
});

test('저장해도 다른 판의 줄은 자리를 옮기지 않는다', () => {
  const env = ready();
  post(env, { ...base, a: 3, b: 4, by: '병희', games: [{ tier: 1, ga: 1, gb: 0 }] });
  sheet(env, '결과').getRange(2, 10).setValues([['재경기 예정']]);
  post(env, { ...base, games: [{ tier: 1, ga: 2, gb: 0 }] });
  const rows = plain(sheet(env, '결과').rows);
  assert.deepEqual([rows[1][0], rows[1][1], rows[1][9]], [3, 4, '재경기 예정']);
  assert.deepEqual([rows[2][0], rows[2][1]], [1, 2]);
});

test('숫자처럼 보이는 닉네임도 글자 그대로 저장한다', () => {
  const env = ready();
  sheet(env, '팀').getRange(2, 3).setValues([['0412']]);
  sheet(env, '설정').getRange(3, 2).setValues([['0412, 조이']]);
  const res = post(env, { ...base, by: '0412', games: [{ tier: 1, ga: 2, gb: 0 }] });
  assert.equal(res.ok, true);
  assert.equal(res.data.teams[0].players[0], '0412');
  assert.deepEqual([res.data.games[0].pa, res.data.games[0].by], ['0412', '0412']);
  assert.equal(plain(sheet(env, '기록').rows[1])[1], '0412');
});

test('결과 탭의 빈 점수·범위 밖 점수 줄과 팀 탭의 메모 줄은 내보내지 않고, 글자로 적힌 점수는 숫자로 읽는다', () => {
  const env = ready();
  const results = sheet(env, '결과');
  results.getRange('D:E').setNumberFormat('@'); // 운영자가 점수 칸을 글자 서식으로 바꾼 경우
  results.getRange(2, 1, 3, 9).setValues([
    [1, 2, 1, '', '0', '스톰', '범수', '', '운영진'],
    [1, 2, 2, '3', ' 1', '자본', '하늘', '', '운영진'],
    [1, 2, 3, '31', '0', '현우', '맹구', '', '운영진'],
  ]);
  sheet(env, '팀').getRange(11, 1, 1, 5).setValues([['메모: 5팀 교체 예정', '', '', '', '']]);
  const body = JSON.parse(env.gs.doGet({ parameter: {} }).getContent());
  assert.deepEqual(body.data.games.map((g) => [g.tier, g.ga, g.gb]), [[2, 3, 1]]);
  assert.equal(body.data.teams.length, 9);
});

test('시트 줄이 꽉 차도 줄을 늘려 저장하고, 마지막 남은 판도 지울 수 있다', () => {
  const env = ready();
  sheet(env, '결과').maxRows = 1;
  sheet(env, '기록').maxRows = 1;
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).changed, 1);
  const res = post(env, { ...base, games: [{ tier: 1, ga: null, gb: null }] });
  assert.equal(res.changed, 1);
  assert.deepEqual(res.data.games, []);
  assert.equal(sheet(env, '기록').getLastRow(), 3);
});

test('탭 이름이 바뀌면 그 탭 이름을 알려 주고, 저장은 아무것도 쓰지 않는다', () => {
  const env = ready();
  sheet(env, '기록').name = '기록(옛날)';
  const res = post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] });
  assert.equal(res.error, 'SETUP');
  assert.match(res.message, /"기록"/);
  assert.equal(sheet(env, '결과').getLastRow(), 1);
  sheet(env, '결과').name = '결과2';
  const got = plain(env.gs.handleGet_({ parameter: {} }));
  assert.equal(got.error, 'SETUP');
  assert.match(got.message, /"결과"/);
});

test('글자로 적힌 점수를 고치거나 지울 때 기록에는 화면과 같은 점수로 남는다', () => {
  const env = ready();
  const results = sheet(env, '결과');
  results.getRange('D:E').setNumberFormat('@');
  results.getRange(2, 1, 1, 9).setValues([[1, 2, 1, ' 03', '1 ', '스톰', '범수', '', '운영진']]);
  post(env, { ...base, games: [{ tier: 1, ga: 4, gb: 1 }] });
  assert.deepEqual(plain(sheet(env, '기록').rows[1]).slice(5), ['3:1', '4:1']);
  results.getRange(2, 1, 1, 9).setValues([[1, 2, 1, ' 03', '1 ', '스톰', '범수', '', '운영진']]);
  post(env, { ...base, games: [{ tier: 1, ga: null, gb: null }] });
  assert.deepEqual(plain(sheet(env, '기록').rows[2]).slice(5), ['3:1', '삭제']);
});

test('checkPin은 비밀번호만 확인하고 아무것도 쓰지 않는다', () => {
  const env = ready();
  const ok = post(env, { action: 'checkPin', pin: ` ${PIN} ` });
  assert.deepEqual(ok, { ok: true });
  const wrong = post(env, { action: 'checkPin', pin: '0000' });
  assert.deepEqual([wrong.ok, wrong.error], [false, 'PIN']);
  assert.equal(sheet(env, '결과').getLastRow(), 1);
  assert.equal(sheet(env, '기록').getLastRow(), 1);
  assert.equal(env.lock.held, false);
});

test('checkPin도 틀린 횟수에 들어가 30번이면 잠기고, PIN이 없으면 SETUP', () => {
  const env = ready();
  for (let i = 0; i < 30; i++) post(env, { action: 'checkPin', pin: 'x' });
  assert.equal(post(env, { action: 'checkPin', pin: PIN }).error, 'LOCKED');
  assert.equal(post(env, { ...base, games: [{ tier: 1, ga: 1, gb: 0 }] }).error, 'LOCKED');
  assert.equal(post(ready({ pin: null }), { action: 'checkPin', pin: PIN }).error, 'SETUP');
});
