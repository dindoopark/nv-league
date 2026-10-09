// NV 내전 리그 계산 모듈: 팀 순위, 경기표, 개인 기록, 저장할 판 고르기.
// 브라우저와 node 테스트가 같이 쓰므로 DOM·네트워크에 의존하지 않는다.

export const TIERS = [1, 2, 3];
export const MAX_GOALS = 30;

// 팀 번호가 작은 쪽을 a로 맞춘다. 점수(ga/gb)와 선수(pa/pb)도 같이 뒤집는다.
export function normalizeGame(game) {
  if (game.a <= game.b) return { ...game };
  return { ...game, a: game.b, b: game.a, ga: game.gb, gb: game.ga, pa: game.pb, pb: game.pa };
}

function gameKey(a, b, tier) {
  return `${a}-${b}-${tier}`;
}

// 같은 (a, b, tier) 판이 여러 번 있으면 마지막 것만 남긴다.
export function uniqueGames(games) {
  const byKey = new Map();
  for (const raw of games) {
    const g = normalizeGame(raw);
    byKey.set(gameKey(g.a, g.b, g.tier), g);
  }
  return [...byKey.values()];
}

export function totalMatches(teamCount) {
  return (teamCount * (teamCount - 1)) / 2;
}

function emptyRecord() {
  return { w: 0, d: 0, l: 0, pts: 0, scored: 0, conceded: 0, diff: 0 };
}

function addResult(rec, scored, conceded) {
  rec.scored += scored;
  rec.conceded += conceded;
  if (scored > conceded) rec.w += 1;
  else if (scored === conceded) rec.d += 1;
  else rec.l += 1;
  rec.pts = rec.w * 3 + rec.d;
  rec.diff = rec.scored - rec.conceded;
}

// 음수면 x가 앞선다. 승점 → 골득실 → 다득점.
function compareRecords(x, y) {
  return y.pts - x.pts || y.diff - x.diff || y.scored - x.scored;
}

// 공동 순위(1, 2, 2, 4): 확실히 앞선 수 + 1
function assignRanks(rows) {
  for (const row of rows) {
    row.rank = 1 + rows.filter((other) => compareRecords(other, row) < 0).length;
  }
}

export function computeTeamStandings(teams, games, settings = {}) {
  const byNo = new Map(
    teams.map((t) => [t.no, { no: t.no, name: t.name, players: t.players, played: 0, ...emptyRecord() }]),
  );
  const tiersPerPair = new Map();
  let recordedGames = 0;
  for (const g of uniqueGames(games)) {
    const teamA = byNo.get(g.a);
    const teamB = byNo.get(g.b);
    if (!teamA || !teamB || g.a === g.b || !TIERS.includes(g.tier)) continue;
    addResult(teamA, g.ga, g.gb);
    addResult(teamB, g.gb, g.ga);
    recordedGames += 1;
    const pair = `${g.a}-${g.b}`;
    tiersPerPair.set(pair, (tiersPerPair.get(pair) || 0) + 1);
  }

  let completedMatches = 0;
  for (const [pair, count] of tiersPerPair) {
    if (count < TIERS.length) continue;
    const [a, b] = pair.split('-').map(Number);
    byNo.get(a).played += 1;
    byNo.get(b).played += 1;
    completedMatches += 1;
  }

  const rows = [...byNo.values()].sort((x, y) => compareRecords(x, y) || x.no - y.no);
  assignRanks(rows);
  for (const row of rows) {
    row.star = false;
    row.playoff = false;
  }

  const matchCount = totalMatches(teams.length);
  const complete = teams.length > 1 && completedMatches === matchCount;
  let playoffPending = false;
  if (rows.length > 0) {
    const leader = rows[0];
    const top = rows.filter((r) => r.pts === leader.pts && r.diff === leader.diff);
    if (complete && top.length > 1) {
      // 시즌 종료 후 1위 동률(승점·골득실)은 다득점이 아니라 3:3 결정전으로 가린다.
      const winner = top.find((r) => r.no === Number(settings.playoffWinner));
      if (winner) {
        for (const r of top) r.rank = r === winner ? 1 : 2;
        winner.star = true;
        rows.splice(rows.indexOf(winner), 1);
        rows.unshift(winner);
      } else {
        playoffPending = true;
        for (const r of top) {
          r.rank = 1;
          r.playoff = true;
        }
      }
    } else if (rows.filter((r) => r.rank === 1).length === 1) {
      leader.star = true;
    }
  }

  return { rows, complete, playoffPending, completedMatches, totalMatches: matchCount, recordedGames };
}

// cells[행 팀][열 팀] = 행 팀 기준 { count, pts, oppPts, scored, conceded }. 판이 없으면 undefined.
export function computeMatrix(teams, games) {
  const cells = {};
  for (const t of teams) cells[t.no] = {};
  const cell = (x, y) => {
    cells[x][y] ??= { count: 0, pts: 0, oppPts: 0, scored: 0, conceded: 0 };
    return cells[x][y];
  };
  for (const g of uniqueGames(games)) {
    if (!cells[g.a] || !cells[g.b] || g.a === g.b || !TIERS.includes(g.tier)) continue;
    const [ptsA, ptsB] = g.ga > g.gb ? [3, 0] : g.ga === g.gb ? [1, 1] : [0, 3];
    const forA = cell(g.a, g.b);
    forA.count += 1;
    forA.pts += ptsA;
    forA.oppPts += ptsB;
    forA.scored += g.ga;
    forA.conceded += g.gb;
    const forB = cell(g.b, g.a);
    forB.count += 1;
    forB.pts += ptsB;
    forB.oppPts += ptsA;
    forB.scored += g.gb;
    forB.conceded += g.ga;
  }
  return cells;
}

// a팀 기준으로 본 두 팀의 티어별 판. 없으면 null.
export function gamesBetween(games, a, b) {
  const out = Object.fromEntries(TIERS.map((t) => [t, null]));
  for (const g of uniqueGames(games)) {
    if (!TIERS.includes(g.tier)) continue;
    if (g.a === a && g.b === b) out[g.tier] = { ga: g.ga, gb: g.gb, pa: g.pa, pb: g.pb };
    else if (g.a === b && g.b === a) out[g.tier] = { ga: g.gb, gb: g.ga, pa: g.pb, pb: g.pa };
  }
  return out;
}

// 입력칸 글자 → 점수. 빈칸은 null, 0~30 정수가 아니면 NaN.
export function parseGoal(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  if (!/^[0-9]+$/.test(s)) return NaN;
  const n = Number(s);
  return n <= MAX_GOALS ? n : NaN;
}

// 불러온 판(existing, gamesBetween 결과)과 입력칸(inputs[tier] = { ga, gb } 글자)을 비교해
// 서버에 보낼 판만 고른다. 기존 판의 두 칸을 모두 비우면 삭제(null, null) 요청이 된다.
export function buildSaveGames(existing, inputs) {
  const games = [];
  const errors = [];
  for (const tier of TIERS) {
    const before = existing[tier];
    const ga = parseGoal(inputs[tier]?.ga);
    const gb = parseGoal(inputs[tier]?.gb);
    if (Number.isNaN(ga) || Number.isNaN(gb)) {
      errors.push({ tier, message: `점수는 0~${MAX_GOALS} 사이 정수로 넣어 주세요.` });
      continue;
    }
    if (ga === null && gb === null) {
      if (before) games.push({ tier, ga: null, gb: null });
      continue;
    }
    if (ga === null || gb === null) {
      errors.push({ tier, message: '두 칸을 모두 채우거나 모두 비워 주세요.' });
      continue;
    }
    if (before && before.ga === ga && before.gb === gb) continue;
    games.push({ tier, ga, gb });
  }
  return { games, errors };
}

// 데모 모드에서 서버 저장을 흉내 낸다. 규칙은 apps-script/Code.gs의 save_와 같다.
export function applySave(games, teams, request, nowIso) {
  const team = (no) => teams.find((t) => t.no === no);
  const next = new Map(uniqueGames(games).map((g) => [gameKey(g.a, g.b, g.tier), g]));
  for (const item of request.games) {
    const g = normalizeGame({
      a: request.a,
      b: request.b,
      tier: item.tier,
      ga: item.ga,
      gb: item.gb,
      pa: team(request.a).players[item.tier - 1],
      pb: team(request.b).players[item.tier - 1],
      at: nowIso,
      by: request.by,
    });
    const key = gameKey(g.a, g.b, g.tier);
    const prev = next.get(key);
    if (item.ga === null && item.gb === null) next.delete(key);
    // 이미 있던 판이면 그 판을 한 선수 이름을 지킨다(선수 교체 뒤 점수를 고쳐도 기록이 옮겨 가지 않게).
    else next.set(key, prev ? { ...g, pa: prev.pa || g.pa, pb: prev.pb || g.pb } : g);
  }
  return [...next.values()];
}

// 티어별 개인 기록. 판에 저장된 선수 이름(pa/pb) 기준으로 모으고,
// 명단에 있지만 아직 판이 없는 선수도 0으로 넣는다.
export function computePlayerStats(teams, games) {
  const team = (no) => teams.find((t) => t.no === no);
  const result = {};
  for (const tier of TIERS) {
    const records = new Map();
    const ensure = (name, teamNo) => {
      if (!records.has(name)) records.set(name, { name, teamNo, ...emptyRecord() });
      return records.get(name);
    };
    for (const t of teams) {
      const name = t.players[tier - 1];
      if (name) ensure(name, t.no);
    }
    for (const g of uniqueGames(games)) {
      // 팀 순위·경기표와 같은 판만 센다(명단에 없는 팀과의 판은 뺀다).
      if (g.tier !== tier || g.a === g.b || !team(g.a) || !team(g.b)) continue;
      const nameA = g.pa || team(g.a)?.players[tier - 1];
      const nameB = g.pb || team(g.b)?.players[tier - 1];
      if (nameA) addResult(ensure(nameA, g.a), g.ga, g.gb);
      if (nameB) addResult(ensure(nameB, g.b), g.gb, g.ga);
    }
    const rows = [...records.values()].sort((x, y) => compareRecords(x, y) || x.teamNo - y.teamNo);
    assignRanks(rows);
    result[tier] = rows;
  }
  return result;
}

// 한 사람의 판 기록. 개인 기록 탭과 같은 기준(판에 기록된 이름)이라, 중간에 교체됐거나
// 팀·티어를 옮겼어도 그 사람이 실제로 뛴 판만 모인다. 여러 티어에서 뛰었으면 모두 더한다.
export function playerRecord(teams, games, name) {
  const total = emptyRecord();
  const stats = computePlayerStats(teams, games);
  for (const tier of TIERS) {
    const row = stats[tier].find((r) => r.name === name);
    if (row) for (const key of Object.keys(total)) total[key] += row[key];
  }
  return total;
}
