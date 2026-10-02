/**
 * NV 내전 리그 — 구글 시트 저장소 (Apps Script 웹 앱)
 *
 * 비밀번호는 이 코드에 적지 않는다. [프로젝트 설정 → 스크립트 속성]에 PIN으로 넣는다.
 * 처음 한 번 setup()을 실행하면 팀/결과/기록/설정 탭이 만들어진다.
 */

var SHEET_TEAMS = '팀';
var SHEET_RESULTS = '결과';
var SHEET_LOG = '기록';
var SHEET_SETTINGS = '설정';
var TIERS = [1, 2, 3];
var MAX_GOALS = 30;
var ADMIN = '운영진';
var RESULT_COLS = 9;
var LOG_COLS = 7;
var MAX_PIN_FAILS = 30; // 10분 창 안에서 이만큼 틀리면
var PIN_FAIL_WINDOW_SEC = 600;
var PIN_LOCK_SEC = 600; // 이 시간 동안 저장을 막는다

// [팀 이름, 1티어, 2티어, 3티어] — 줄 순서가 팀 번호. sample-data.js의 ROSTER와 같게 둔다.
var ROSTER = [
  ['시그니엘', '스톰', '자본', '현우'],
  ['노인정', '범수', '하늘', '맹구'],
  ['달려라콜여사', '병희', '콜드', '쟁이'],
  ['구육칠즈', '태현', '태풍', '로우'],
  ['사자는어흥', '레오', '로마', '대전'],
  ['크카모원정대', '크카모', '원형', '정민'],
  ['어색즈', '우설', '환타', '울프'],
  ['젊크크', '하지', '소보로', '레몬'],
  ['대갈장군', '뚝배기', '치노', '수프러차']
];

// --- 처음 한 번 실행 (다시 실행해도 안전) ---

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var teams = ensureSheet_(ss, SHEET_TEAMS, ['팀번호', '팀이름', '1티어', '2티어', '3티어']);
  // 닉네임·팀이름이 숫자나 날짜로 바뀌지 않게 글자 서식
  teams.getRange('B:E').setNumberFormat('@');
  if (teams.getLastRow() < 2) {
    var rows = ROSTER.map(function (r, i) {
      return [i + 1, r[0], r[1], r[2], r[3]];
    });
    teams.getRange(2, 1, rows.length, 5).setValues(rows);
  }
  var results = ensureSheet_(ss, SHEET_RESULTS, ['팀A', '팀B', '티어', 'A득점', 'B득점', 'A선수', 'B선수', '수정시각', '입력자']);
  results.getRange('F:G').setNumberFormat('@');
  results.getRange('I:I').setNumberFormat('@');
  var log = ensureSheet_(ss, SHEET_LOG, ['시각', '입력자', '팀A', '팀B', '티어', '이전', '이후']);
  log.getRange('B:B').setNumberFormat('@');
  log.getRange('F:G').setNumberFormat('@'); // "3:1"이 시각으로 바뀌지 않게
  var settings = ensureSheet_(ss, SHEET_SETTINGS, ['항목', '값']);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 1, 2).setValues([['결정전 승자 팀 번호', '']]);
  }
  removeBlankDefaultSheet_(ss);
  var pin = PropertiesService.getScriptProperties().getProperty('PIN');
  Logger.log(pin ? '준비 완료.' : '준비 완료. 이제 프로젝트 설정 → 스크립트 속성에 PIN을 추가하세요.');
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function removeBlankDefaultSheet_(ss) {
  ['시트1', 'Sheet1'].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet);
  });
}

// --- 웹 앱 입구 ---

function doGet(e) {
  return json_(handleGet_(e));
}

function doPost(e) {
  return json_(handlePost_(e, new Date()));
}

function handleGet_(e) {
  var action = (e && e.parameter && e.parameter.action) || 'data';
  if (action !== 'data') return fail_('INVALID', '알 수 없는 요청입니다.');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var missing = missingTabs_(ss, [SHEET_TEAMS, SHEET_RESULTS]);
    if (missing.length) return fail_('SETUP', tabMessage_(missing));
    return { ok: true, data: readData_(ss) };
  } catch (err) {
    return fail_('SERVER', '불러오기 중 오류가 났습니다: ' + errorText_(err));
  }
}

function handlePost_(e, now) {
  var req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return fail_('INVALID', '요청 형식이 올바르지 않습니다.');
  }
  if (!req || req.action !== 'save') return fail_('INVALID', '알 수 없는 요청입니다.');

  var pinError = checkPin_(req.pin, now);
  if (pinError) return pinError;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return fail_('BUSY', '다른 저장이 진행 중입니다. 잠시 뒤 다시 저장해 주세요.');
  }
  try {
    return save_(SpreadsheetApp.getActiveSpreadsheet(), req, now);
  } catch (err) {
    return fail_('SERVER', '저장 중 오류가 났습니다: ' + errorText_(err));
  } finally {
    lock.releaseLock();
  }
}

// --- 비밀번호 ---

// 틀린 비밀번호는 첫 실패부터 10분 창 안에서 센다. 30번이 되면 그때부터 10분 동안 저장을 막는다.
function checkPin_(pin, now) {
  var saved = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!saved || !String(saved).trim()) {
    return fail_('SETUP', '비밀번호(PIN)가 아직 설정되지 않았습니다. 운영자에게 알려 주세요.');
  }
  var cache = CacheService.getScriptCache();
  var fails = readPinFails_(cache);
  if (fails.n >= MAX_PIN_FAILS) {
    return fail_('LOCKED', '비밀번호가 여러 번 틀려 잠시 저장을 막았습니다. 10분 뒤 다시 시도해 주세요.');
  }
  if (String(pin == null ? '' : pin).trim() === String(saved).trim()) return null;

  var nowMs = now.getTime();
  if (!fails.since || nowMs - fails.since >= PIN_FAIL_WINDOW_SEC * 1000) fails = { n: 0, since: nowMs };
  fails.n += 1;
  var ttl =
    fails.n >= MAX_PIN_FAILS ? PIN_LOCK_SEC : Math.ceil((fails.since + PIN_FAIL_WINDOW_SEC * 1000 - nowMs) / 1000);
  cache.put('pinFails', JSON.stringify(fails), Math.max(1, ttl));
  return fail_('PIN', '비밀번호가 맞지 않습니다.');
}

function readPinFails_(cache) {
  try {
    var v = JSON.parse(cache.get('pinFails') || 'null');
    if (v && typeof v.n === 'number' && typeof v.since === 'number') return v;
  } catch (err) {
    // 형식이 이상하면 처음부터 센다.
  }
  return { n: 0, since: 0 };
}

// --- 저장 ---

function save_(ss, req, now) {
  var missing = missingTabs_(ss, [SHEET_TEAMS, SHEET_RESULTS, SHEET_LOG]);
  if (missing.length) return fail_('SETUP', tabMessage_(missing));

  var teams = readTeams_(ss);
  var a = Number(req.a);
  var b = Number(req.b);
  var teamA = findTeam_(teams, a);
  var teamB = findTeam_(teams, b);
  if (!teamA || !teamB || a === b) return fail_('INVALID', '서로 다른 두 팀을 골라 주세요.');

  var by = String(req.by == null ? '' : req.by).trim();
  var allowed = teamA.players.concat(teamB.players).filter(function (p) {
    return p;
  });
  allowed.push(ADMIN);
  if (!by || allowed.indexOf(by) < 0) {
    return fail_('INVALID', '입력자는 그 경기 6명 중 1명이거나 운영진이어야 합니다.');
  }

  if (!Array.isArray(req.games) || req.games.length === 0 || req.games.length > TIERS.length) {
    return fail_('INVALID', '저장할 판이 없습니다.');
  }
  var edits = [];
  var seenTier = {};
  for (var i = 0; i < req.games.length; i++) {
    var item = req.games[i] || {};
    var tier = Number(item.tier);
    if (TIERS.indexOf(tier) < 0 || seenTier[tier]) return fail_('INVALID', '티어 값이 올바르지 않습니다.');
    seenTier[tier] = true;
    var remove = item.ga === null && item.gb === null;
    if (!remove && !(isGoal_(item.ga) && isGoal_(item.gb))) {
      return fail_('INVALID', tier + '티어 점수는 0~' + MAX_GOALS + ' 사이 정수여야 합니다.');
    }
    edits.push({ tier: tier, remove: remove, ga: item.ga, gb: item.gb });
  }

  // 팀 번호가 작은 쪽을 팀A로 저장한다.
  var swap = a > b;
  var lo = swap ? teamB : teamA;
  var hi = swap ? teamA : teamB;

  var sheet = ss.getSheetByName(SHEET_RESULTS);
  var entries = readResultRows_(sheet);
  var updates = [];
  var appends = [];
  var deletes = [];
  var logRows = [];
  edits.forEach(function (ed) {
    // 운영자가 직접 넣은 뒤집힌 줄(큰 팀이 앞)·중복 줄도 같은 판으로 본다.
    var matches = entries.filter(function (en) {
      return sameGame_(en.values, lo.no, hi.no, ed.tier);
    });
    // 화면에 보이는 것은 형식이 맞는 줄 중 마지막 줄이다(standings.js uniqueGames와 같은 규칙).
    var visible = matches.filter(function (en) {
      return toGame_(en.values);
    });
    var shownEntry = visible.length ? visible[visible.length - 1] : null;
    var shown = shownEntry ? orient_(shownEntry.values, lo.no) : null;
    var before = shown ? shown.ga + ':' + shown.gb : '';

    if (ed.remove) {
      if (!matches.length) return;
      matches.forEach(function (en) {
        deletes.push(en.row);
      });
      logRows.push([now, by, lo.no, hi.no, ed.tier, before || '(없음)', '삭제']);
      return;
    }

    var goalsLo = swap ? ed.gb : ed.ga;
    var goalsHi = swap ? ed.ga : ed.gb;
    if (shown && shown.ga === goalsLo && shown.gb === goalsHi) return;
    // 이미 있던 판이면 그 판을 한 선수 이름을 지킨다(선수 교체 뒤 점수를 고쳐도 기록이 옮겨 가지 않게).
    var nameLo = (shown && shown.pa) || lo.players[ed.tier - 1];
    var nameHi = (shown && shown.pb) || hi.players[ed.tier - 1];
    var values = [lo.no, hi.no, ed.tier, goalsLo, goalsHi, nameLo, nameHi, now, by];
    var target = shownEntry || (matches.length ? matches[matches.length - 1] : null);
    if (target) {
      updates.push({ row: target.row, values: values });
      matches.forEach(function (en) {
        if (en !== target) deletes.push(en.row);
      });
    } else {
      appends.push(values);
    }
    logRows.push([now, by, lo.no, hi.no, ed.tier, before || '(없음)', goalsLo + ':' + goalsHi]);
  });

  if (logRows.length > 0) {
    // 다른 판의 줄은 그 자리에 둔다(운영자가 붙인 색·메모가 엉뚱한 판으로 옮겨 가지 않게).
    updates.forEach(function (u) {
      sheet.getRange(u.row, 1, 1, RESULT_COLS).setValues([u.values]);
    });
    appendRows_(sheet, appends);
    deleteRows_(sheet, deletes);
    appendRows_(ss.getSheetByName(SHEET_LOG), logRows);
  }
  return { ok: true, changed: logRows.length, data: readData_(ss) };
}

// --- 시트 읽기·쓰기 ---

function readData_(ss) {
  var games = readResultRows_(ss.getSheetByName(SHEET_RESULTS))
    .map(function (en) {
      return toGame_(en.values);
    })
    .filter(function (g) {
      return g;
    });
  var settings = ss.getSheetByName(SHEET_SETTINGS);
  var winner = settings && settings.getLastRow() >= 2 ? Number(settings.getRange(2, 2).getValue()) : NaN;
  return {
    teams: readTeams_(ss),
    games: games,
    settings: { playoffWinner: winner >= 1 ? winner : null },
    serverTime: new Date().toISOString()
  };
}

function readTeams_(ss) {
  var sheet = ss.getSheetByName(SHEET_TEAMS);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, 5)
    .getValues()
    .map(function (r) {
      var no = Number(r[0]);
      return {
        no: no,
        name: String(r[1]).trim() || no + '팀',
        players: [r[2], r[3], r[4]].map(function (p) {
          return String(p).trim();
        })
      };
    })
    .filter(function (t) {
      return t.no >= 1 && Math.floor(t.no) === t.no;
    });
}

// 결과 탭에서 빈 줄이 아닌 줄을 시트 줄 번호와 함께 돌려준다. 운영자가 넣은 이상한 줄도 지우지 않는다.
function readResultRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, RESULT_COLS)
    .getValues()
    .map(function (values, i) {
      return { row: i + 2, values: values };
    })
    .filter(function (en) {
      return en.values.some(function (v) {
        return v !== '' && v !== null;
      });
    });
}

// 맨 아래에 줄을 붙인다. 시트 줄이 모자라면 먼저 늘린다.
function appendRows_(sheet, rows) {
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  var need = start + rows.length - 1 - sheet.getMaxRows();
  if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

// 아래 줄부터 지운다. 고정되지 않은 줄이 하나도 안 남으면 시트가 오류를 내므로 빈 줄을 하나 남긴다.
function deleteRows_(sheet, rowNumbers) {
  if (!rowNumbers.length) return;
  if (sheet.getMaxRows() <= sheet.getLastRow()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  rowNumbers
    .slice()
    .sort(function (x, y) {
      return y - x;
    })
    .forEach(function (row) {
      sheet.deleteRow(row);
    });
}

function toGame_(r) {
  var a = Number(r[0]);
  var b = Number(r[1]);
  var tier = Number(r[2]);
  var ga = cellGoal_(r[3]);
  var gb = cellGoal_(r[4]);
  if (!isTeamNo_(a) || !isTeamNo_(b) || a === b || TIERS.indexOf(tier) < 0 || !isGoal_(ga) || !isGoal_(gb)) {
    return null;
  }
  return {
    a: a,
    b: b,
    tier: tier,
    ga: ga,
    gb: gb,
    pa: String(r[5]).trim(),
    pb: String(r[6]).trim(),
    at: toIso_(r[7]),
    by: String(r[8]).trim()
  };
}

// 결과 줄이 (lo, hi, tier) 판인지. 큰 팀이 앞에 적힌 줄도 같은 판으로 본다.
function sameGame_(r, lo, hi, tier) {
  var a = Number(r[0]);
  var b = Number(r[1]);
  return Number(r[2]) === tier && ((a === lo && b === hi) || (a === hi && b === lo));
}

// 결과 줄을 lo 팀 기준 { ga, gb, pa, pb }로 돌려 읽는다. 점수는 화면과 같은 숫자로 읽는다.
function orient_(r, lo) {
  var flip = Number(r[0]) !== lo;
  return {
    ga: cellGoal_(flip ? r[4] : r[3]),
    gb: cellGoal_(flip ? r[3] : r[4]),
    pa: String(flip ? r[6] : r[5]).trim(),
    pb: String(flip ? r[5] : r[6]).trim()
  };
}

function missingTabs_(ss, names) {
  return names.filter(function (name) {
    return !ss.getSheetByName(name);
  });
}

function tabMessage_(missing) {
  var names = missing.map(function (name) {
    return '"' + name + '"';
  });
  return '구글 시트에 ' + names.join(', ') + ' 탭이 없습니다. 탭 이름을 바꾸거나 지우지 마세요.';
}

function findTeam_(teams, no) {
  for (var i = 0; i < teams.length; i++) {
    if (teams[i].no === no) return teams[i];
  }
  return null;
}

// --- 작은 도우미 ---

// 칸 값 → 점수. 운영자가 글자 서식 칸에 적은 "3"도 숫자로 읽는다. 아니면 NaN.
function cellGoal_(v) {
  if (typeof v === 'number') return v;
  var s = String(v == null ? '' : v).trim();
  return /^[0-9]+$/.test(s) ? Number(s) : NaN;
}

function isGoal_(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= MAX_GOALS;
}

function isTeamNo_(n) {
  return n >= 1 && Math.floor(n) === n;
}

function toIso_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === '' || v == null ? '' : String(v);
}

function fail_(code, message) {
  return { ok: false, error: code, message: message };
}

function errorText_(err) {
  return err && err.message ? err.message : String(err);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
