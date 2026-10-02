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
var MAX_PIN_FAILS = 30;
var PIN_FAIL_WINDOW_SEC = 600;

// 적힌 순서 = 1·2·3티어
var ROSTER = [
  ['스톰', '자본', '현우'],
  ['범수', '하늘', '맹구'],
  ['병희', '콜드', '쟁이'],
  ['태현', '태풍', '로우'],
  ['레오', '로마', '대전'],
  ['크카모', '원형', '정민'],
  ['우설', '환타', '울프'],
  ['하지', '소보로', '레몬'],
  ['뚝배기', '치노', '수프러차']
];

// --- 처음 한 번 실행 ---

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var teams = ensureSheet_(ss, SHEET_TEAMS, ['팀번호', '팀이름', '1티어', '2티어', '3티어']);
  if (teams.getLastRow() < 2) {
    var rows = ROSTER.map(function (players, i) {
      return [i + 1, (i + 1) + '팀', players[0], players[1], players[2]];
    });
    teams.getRange(2, 1, rows.length, 5).setValues(rows);
  }
  ensureSheet_(ss, SHEET_RESULTS, ['팀A', '팀B', '티어', 'A득점', 'B득점', 'A선수', 'B선수', '수정시각', '입력자']);
  var log = ensureSheet_(ss, SHEET_LOG, ['시각', '입력자', '팀A', '팀B', '티어', '이전', '이후']);
  log.getRange('F:G').setNumberFormat('@'); // "3:1"이 시각으로 바뀌지 않게 글자 서식
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
    return { ok: true, data: readData_(SpreadsheetApp.getActiveSpreadsheet()) };
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

  var pinError = checkPin_(req.pin);
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

function checkPin_(pin) {
  var saved = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!saved || !String(saved).trim()) {
    return fail_('SETUP', '비밀번호(PIN)가 아직 설정되지 않았습니다. 운영자에게 알려 주세요.');
  }
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pinFails') || 0);
  if (fails >= MAX_PIN_FAILS) {
    return fail_('LOCKED', '비밀번호가 여러 번 틀려 잠시 저장을 막았습니다. 10분 뒤 다시 시도해 주세요.');
  }
  if (String(pin == null ? '' : pin).trim() !== String(saved).trim()) {
    cache.put('pinFails', String(fails + 1), PIN_FAIL_WINDOW_SEC);
    return fail_('PIN', '비밀번호가 맞지 않습니다.');
  }
  return null;
}

// --- 저장 ---

function save_(ss, req, now) {
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
  var rows = readResultRows_(sheet);
  var logRows = [];
  edits.forEach(function (ed) {
    var idx = findResultRow_(rows, lo.no, hi.no, ed.tier);
    var before = idx >= 0 ? rows[idx][3] + ':' + rows[idx][4] : '';
    if (ed.remove) {
      if (idx < 0) return;
      rows.splice(idx, 1);
      logRows.push([now, by, lo.no, hi.no, ed.tier, before, '삭제']);
      return;
    }
    var goalsLo = swap ? ed.gb : ed.ga;
    var goalsHi = swap ? ed.ga : ed.gb;
    var after = goalsLo + ':' + goalsHi;
    if (before === after) return;
    var row = [lo.no, hi.no, ed.tier, goalsLo, goalsHi, lo.players[ed.tier - 1], hi.players[ed.tier - 1], now, by];
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    logRows.push([now, by, lo.no, hi.no, ed.tier, before || '(없음)', after]);
  });

  if (logRows.length > 0) {
    writeResultRows_(sheet, rows);
    var logSheet = ss.getSheetByName(SHEET_LOG);
    logSheet.getRange(logSheet.getLastRow() + 1, 1, logRows.length, LOG_COLS).setValues(logRows);
  }
  return { ok: true, changed: logRows.length, data: readData_(ss) };
}

// --- 시트 읽기·쓰기 ---

function readData_(ss) {
  var games = readResultRows_(ss.getSheetByName(SHEET_RESULTS))
    .map(toGame_)
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

// 빈 줄을 뺀 결과 탭의 원본 줄. 운영자가 넣은 이상한 줄도 지우지 않도록 그대로 둔다.
function readResultRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, RESULT_COLS)
    .getValues()
    .filter(function (r) {
      return r.some(function (v) {
        return v !== '' && v !== null;
      });
    });
}

function writeResultRows_(sheet, rows) {
  rows.sort(function (x, y) {
    return Number(x[0]) - Number(y[0]) || Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
  });
  var last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, RESULT_COLS).clearContent();
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, RESULT_COLS).setValues(rows);
}

function toGame_(r) {
  var a = Number(r[0]);
  var b = Number(r[1]);
  var tier = Number(r[2]);
  if (!(a >= 1) || !(b >= 1) || a === b || TIERS.indexOf(tier) < 0 || !isGoal_(r[3]) || !isGoal_(r[4])) return null;
  return {
    a: a,
    b: b,
    tier: tier,
    ga: r[3],
    gb: r[4],
    pa: String(r[5]),
    pb: String(r[6]),
    at: toIso_(r[7]),
    by: String(r[8])
  };
}

function findTeam_(teams, no) {
  for (var i = 0; i < teams.length; i++) {
    if (teams[i].no === no) return teams[i];
  }
  return null;
}

function findResultRow_(rows, a, b, tier) {
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i][0]) === a && Number(rows[i][1]) === b && Number(rows[i][2]) === tier) return i;
  }
  return -1;
}

// --- 작은 도우미 ---

function isGoal_(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= MAX_GOALS;
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
