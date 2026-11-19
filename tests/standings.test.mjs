import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS,
  normalizeGame,
  uniqueGames,
  totalMatches,
  computeTeamStandings,
  computeMatrix,
  gamesBetween,
  parseGoal,
  buildSaveGames,
  applySave,
  computePlayerStats,
  playerRecord,
} from '../standings.js';

const ROSTER = [
  ['스톰', '자본', '현우'],
  ['범수', '하늘', '맹구'],
  ['병희', '콜드', '쟁이'],
  ['태현', '태풍', '로우'],
  ['레오', '로마', '대전'],
  ['크카모', '원형', '정민'],
  ['우설', '환타', '울프'],
  ['하지', '소보루', '레몬'],
  ['뚝배기', '치노', '수프러차'],
];
const TEAMS = ROSTER.map((players, i) => ({ no: i + 1, name: `${i + 1}팀`, players }));

function game(a, b, tier, ga, gb) {
  return { a, b, tier, ga, gb, pa: TEAMS[a - 1].players[tier - 1], pb: TEAMS[b - 1].players[tier - 1] };
}

// 108판이 모두 1:1 무승부인, 끝난 시즌
function allDraws() {
  const games = [];
  for (let a = 1; a <= 9; a++) {
    for (let b = a + 1; b <= 9; b++) {
      for (const tier of TIERS) games.push(game(a, b, tier, 1, 1));
    }
  }
  return games;
}

function withGame(games, a, b, tier, ga, gb) {
  return games.filter((g) => !(g.a === a && g.b === b && g.tier === tier)).concat(game(a, b, tier, ga, gb));
}

const row = (standings, no) => standings.rows.find((r) => r.no === no);

test('normalizeGame은 작은 팀 번호를 a로 맞추고 점수와 선수도 뒤집는다', () => {
  const g = normalizeGame({ a: 5, b: 2, tier: 1, ga: 3, gb: 1, pa: '레오', pb: '범수' });
  assert.deepEqual(g, { a: 2, b: 5, tier: 1, ga: 1, gb: 3, pa: '범수', pb: '레오' });
});

test('uniqueGames는 같은 판이 겹치면 마지막 것만 남긴다', () => {
  const list = uniqueGames([game(1, 2, 1, 0, 0), { a: 2, b: 1, tier: 1, ga: 4, gb: 2, pa: '범수', pb: '스톰' }]);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].a, list[0].b, list[0].ga, list[0].gb], [1, 2, 2, 4]);
});

test('9팀 풀리그는 36경기', () => {
  assert.equal(totalMatches(9), 36);
});

test('공지 예시: 1승 1무 1패는 승점 4점이고 골득실이 순위를 가른다', () => {
  const s = computeTeamStandings(TEAMS, [game(1, 2, 1, 1, 2), game(1, 2, 2, 3, 3), game(1, 2, 3, 4, 2)]);
  const t1 = row(s, 1);
  const t2 = row(s, 2);
  assert.deepEqual([t1.w, t1.d, t1.l, t1.pts, t1.scored, t1.conceded, t1.diff, t1.played], [1, 1, 1, 4, 8, 7, 1, 1]);
  assert.deepEqual([t2.w, t2.d, t2.l, t2.pts, t2.scored, t2.conceded, t2.diff, t2.played], [1, 1, 1, 4, 7, 8, -1, 1]);
  assert.deepEqual(s.rows.slice(0, 2).map((r) => [r.no, r.rank]), [[1, 1], [2, 2]]);
  assert.equal(t1.star, true);
  assert.equal(row(s, 3).rank, 3);
  assert.equal(row(s, 9).rank, 3);
  assert.equal(s.complete, false);
  assert.equal(s.recordedGames, 3);
  assert.equal(s.completedMatches, 1);
});

test('일부 판만 입력된 경기는 경기 수에 안 들어가지만 승점은 반영된다', () => {
  const s = computeTeamStandings(TEAMS, [game(3, 4, 1, 2, 0), game(3, 4, 2, 1, 1)]);
  assert.equal(row(s, 3).played, 0);
  assert.equal(row(s, 3).pts, 4);
  assert.equal(row(s, 4).pts, 1);
  assert.equal(s.completedMatches, 0);
});

test('승점이 같으면 골득실, 그다음 다득점, 셋 다 같으면 공동 순위', () => {
  const s = computeTeamStandings(TEAMS, [
    game(1, 2, 1, 3, 0), // 1팀: 3점, +3
    game(3, 4, 1, 1, 0), // 3팀: 3점, +1, 1득점
    game(5, 6, 1, 2, 1), // 5팀: 3점, +1, 2득점
    game(7, 8, 1, 2, 1), // 7팀: 5팀과 완전히 같음
  ]);
  assert.deepEqual(s.rows.slice(0, 4).map((r) => [r.no, r.rank]), [[1, 1], [5, 2], [7, 2], [3, 4]]);
  assert.equal(row(s, 1).star, true);
  assert.equal(row(s, 5).star, false);
});

test('아무 판도 없으면 모두 공동 1위이고 ★는 없다', () => {
  const s = computeTeamStandings(TEAMS, []);
  assert.ok(s.rows.every((r) => r.rank === 1 && !r.star && !r.playoff));
  assert.equal(s.complete, false);
  assert.equal(s.totalMatches, 36);
  assert.equal(s.recordedGames, 0);
});

test('시즌이 끝나고 1위가 단독이면 ★를 붙이고 결정전은 없다', () => {
  const s = computeTeamStandings(TEAMS, withGame(allDraws(), 1, 9, 1, 2, 1));
  assert.equal(s.complete, true);
  assert.equal(s.playoffPending, false);
  assert.equal(s.rows[0].no, 1);
  assert.equal(s.rows[0].star, true);
  assert.ok(s.rows.every((r) => r.played === 8));
  assert.equal(s.recordedGames, 108);
});

test('시즌 종료 후 1위가 승점·골득실 동률이면 다득점과 상관없이 결정전 대기', () => {
  let games = withGame(allDraws(), 1, 9, 1, 2, 1); // 1팀 26점, +1, 25득점
  games = withGame(games, 2, 8, 1, 3, 2); // 2팀 26점, +1, 26득점
  const s = computeTeamStandings(TEAMS, games);
  assert.equal(s.complete, true);
  assert.equal(s.playoffPending, true);
  assert.deepEqual(
    s.rows.slice(0, 2).map((r) => [r.no, r.rank, r.playoff, r.star]),
    [[2, 1, true, false], [1, 1, true, false]],
  );
  assert.equal(row(s, 3).rank, 3);
  assert.equal(row(s, 3).playoff, false);
});

test('결정전 승자를 설정하면 그 팀이 1위(★), 다른 동률 팀은 2위', () => {
  let games = withGame(allDraws(), 1, 9, 1, 2, 1);
  games = withGame(games, 2, 8, 1, 3, 2);
  const s = computeTeamStandings(TEAMS, games, { playoffWinner: 1 });
  assert.equal(s.playoffPending, false);
  assert.deepEqual(s.rows.slice(0, 2).map((r) => [r.no, r.rank, r.star, r.playoff]), [[1, 1, true, false], [2, 2, false, false]]);
});

test('결정전 승자가 동률 팀이 아니면 무시하고 계속 결정전 대기', () => {
  let games = withGame(allDraws(), 1, 9, 1, 2, 1);
  games = withGame(games, 2, 8, 1, 3, 2);
  const s = computeTeamStandings(TEAMS, games, { playoffWinner: 5 });
  assert.equal(s.playoffPending, true);
  assert.ok(s.rows.every((r) => !r.star));
});

test('시즌 중에는 1위 동률도 다득점으로 가른다', () => {
  let games = withGame(allDraws(), 1, 9, 1, 2, 1);
  games = withGame(games, 2, 8, 1, 3, 2);
  games = games.filter((g) => !(g.a === 5 && g.b === 6 && g.tier === 3));
  const s = computeTeamStandings(TEAMS, games, { playoffWinner: 1 });
  assert.equal(s.complete, false);
  assert.equal(s.playoffPending, false);
  assert.deepEqual(s.rows.slice(0, 2).map((r) => [r.no, r.rank, r.star]), [[2, 1, true], [1, 2, false]]);
});

test('여러 팀이 1위 동률이어도 결정전 승자 한 팀만 1위', () => {
  const pending = computeTeamStandings(TEAMS, allDraws());
  assert.equal(pending.playoffPending, true);
  assert.ok(pending.rows.every((r) => r.rank === 1 && r.playoff && !r.star));
  const decided = computeTeamStandings(TEAMS, allDraws(), { playoffWinner: '3' });
  assert.equal(decided.rows[0].no, 3);
  assert.equal(decided.rows[0].star, true);
  assert.ok(decided.rows.slice(1).every((r) => r.rank === 2 && !r.star && !r.playoff));
});

test('명단에 없는 팀이나 잘못된 티어의 판은 무시한다', () => {
  const s = computeTeamStandings(TEAMS, [
    { a: 1, b: 10, tier: 1, ga: 5, gb: 0 },
    { a: 1, b: 2, tier: 4, ga: 5, gb: 0 },
  ]);
  assert.equal(row(s, 1).pts, 0);
  assert.equal(s.recordedGames, 0);
});

test('경기표 칸은 행 팀 기준 승점과 입력된 판 수를 담는다', () => {
  const cells = computeMatrix(TEAMS, [
    game(1, 2, 1, 1, 2),
    game(1, 2, 2, 3, 3),
    { a: 2, b: 1, tier: 3, ga: 2, gb: 4, pa: '맹구', pb: '현우' },
    game(3, 4, 1, 2, 0),
  ]);
  assert.deepEqual(cells[1][2], { count: 3, pts: 4, oppPts: 4, scored: 8, conceded: 7 });
  assert.deepEqual(cells[2][1], { count: 3, pts: 4, oppPts: 4, scored: 7, conceded: 8 });
  assert.deepEqual(cells[4][3], { count: 1, pts: 0, oppPts: 3, scored: 0, conceded: 2 });
  assert.equal(cells[1][3], undefined);
});

test('gamesBetween은 요청한 팀 순서 기준으로 점수와 선수를 돌려준다', () => {
  const games = [game(1, 2, 1, 1, 2), game(1, 2, 3, 4, 2), game(1, 3, 2, 5, 5)];
  assert.deepEqual(gamesBetween(games, 2, 1), {
    1: { ga: 2, gb: 1, pa: '범수', pb: '스톰' },
    2: null,
    3: { ga: 2, gb: 4, pa: '맹구', pb: '현우' },
  });
});

test('parseGoal은 0~30 정수만 받고 빈칸은 null', () => {
  assert.equal(parseGoal(''), null);
  assert.equal(parseGoal('  '), null);
  assert.equal(parseGoal(undefined), null);
  assert.equal(parseGoal('0'), 0);
  assert.equal(parseGoal(' 07 '), 7);
  assert.equal(parseGoal('30'), 30);
  for (const bad of ['31', '-1', '1.5', 'a', '1e1', '３']) assert.ok(Number.isNaN(parseGoal(bad)), bad);
});

test('buildSaveGames는 바뀐 판만 보내고, 기존 판을 비우면 삭제 요청한다', () => {
  const existing = { 1: { ga: 2, gb: 1 }, 2: { ga: 0, gb: 0 }, 3: null };
  const { games, errors } = buildSaveGames(existing, {
    1: { ga: '2', gb: '1' }, // 그대로
    2: { ga: '', gb: '' }, // 삭제
    3: { ga: '4', gb: '3' }, // 새 판
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(games, [{ tier: 2, ga: null, gb: null }, { tier: 3, ga: 4, gb: 3 }]);
});

test('buildSaveGames는 한 칸만 채우거나 범위를 벗어난 점수를 오류로 돌려준다', () => {
  const existing = { 1: null, 2: null, 3: null };
  const { games, errors } = buildSaveGames(existing, {
    1: { ga: '3', gb: '' },
    2: { ga: '31', gb: '0' },
    3: { ga: '', gb: '' },
  });
  assert.deepEqual(games, []);
  assert.deepEqual(errors.map((e) => e.tier), [1, 2]);
});

test('applySave는 서버와 같은 규칙으로 추가·수정·삭제한다', () => {
  const start = [game(1, 2, 1, 1, 0), game(1, 2, 2, 2, 2), game(3, 4, 1, 1, 1)];
  const next = applySave(
    start,
    TEAMS,
    {
      a: 2,
      b: 1,
      by: '범수',
      games: [
        { tier: 1, ga: 3, gb: 1 }, // 2팀 기준 3:1 → 1팀 기준 1:3
        { tier: 2, ga: null, gb: null }, // 삭제
        { tier: 3, ga: 0, gb: 0 }, // 추가
      ],
    },
    '2026-10-02T00:00:00.000Z',
  );
  const between = gamesBetween(next, 1, 2);
  assert.deepEqual([between[1].ga, between[1].gb], [1, 3]);
  assert.equal(between[2], null);
  assert.deepEqual(between[3], { ga: 0, gb: 0, pa: '현우', pb: '맹구' });
  const saved = next.find((g) => g.a === 1 && g.b === 2 && g.tier === 3);
  assert.deepEqual([saved.by, saved.at], ['범수', '2026-10-02T00:00:00.000Z']);
  assert.equal(next.length, 3);
});

test('개인 기록은 티어별로 모든 명단 선수를 넣고 판 결과를 선수 이름 기준으로 모은다', () => {
  const stats = computePlayerStats(TEAMS, [
    game(1, 2, 1, 3, 1), // 스톰 승
    game(1, 3, 1, 0, 0), // 스톰 무
    game(4, 5, 1, 2, 2), // 태현 무
  ]);
  assert.equal(stats[1].length, 9);
  const storm = stats[1].find((p) => p.name === '스톰');
  assert.deepEqual(
    [storm.rank, storm.w, storm.d, storm.l, storm.pts, storm.scored, storm.conceded, storm.diff, storm.teamNo],
    [1, 1, 1, 0, 4, 3, 1, 2, 1],
  );
  assert.deepEqual(storm.inherited, []);
  assert.equal(stats[1].find((p) => p.name === '태현').d, 1);
  assert.equal(stats[1].find((p) => p.name === '우설').d, 0);
  assert.equal(stats[2].length, 9);
  assert.equal(stats[3].length, 9);
});

test('개인 기록: 명단에서 빠진 선수(탈퇴)의 판은 그 자리를 이어받은 지금 선수 줄에 합치고 inherited에 남긴다', () => {
  // 3팀 3티어: 쟁이가 1·2번째 판을 뛰고 탈퇴, 감성이 이어받음
  const teams = TEAMS.map((t) => (t.no === 3 ? { ...t, players: ['병희', '콜드', '감성'] } : t));
  const stats = computePlayerStats(teams, [
    { ...game(3, 9, 3, 3, 4), pa: '쟁이' }, // 쟁이 패
    { ...game(5, 3, 3, 0, 1), pb: '쟁이' }, // 쟁이 승(3팀이 원정)
    { ...game(3, 8, 3, 2, 2), pa: '감성' }, // 감성 무
  ]);
  assert.equal(stats[3].length, 9);
  assert.equal(stats[3].find((p) => p.name === '쟁이'), undefined);
  const gs = stats[3].find((p) => p.name === '감성');
  assert.deepEqual([gs.teamNo, gs.w, gs.d, gs.l, gs.pts, gs.scored, gs.conceded], [3, 1, 1, 1, 4, 6, 6]);
  assert.deepEqual(gs.inherited, [
    { name: '쟁이', opponent: 9 },
    { name: '쟁이', opponent: 5 },
  ]);
  // 상대 쪽은 그대로
  assert.equal(stats[3].find((p) => p.name === '수프러차').w, 1);
  assert.deepEqual(playerRecord(teams, [{ ...game(3, 9, 3, 3, 4), pa: '쟁이' }], '감성'), {
    w: 0, d: 0, l: 1, pts: 0, scored: 3, conceded: 4, diff: -1,
  });
});

test('개인 기록: 그 자리 선수 칸이 비어 있으면 명단에 없는 이름도 자기 줄로 남긴다', () => {
  const teams = TEAMS.map((t) => (t.no === 4 ? { ...t, players: ['', t.players[1], t.players[2]] } : t));
  const stats = computePlayerStats(teams, [{ ...game(4, 5, 1, 2, 2), pa: '대타' }]);
  const sub = stats[1].find((p) => p.name === '대타');
  assert.deepEqual([sub.teamNo, sub.d, sub.pts, sub.inherited.length], [4, 1, 1, 0]);
});

test('applySave는 선수가 바뀐 뒤 예전 판을 고쳐도 그 판의 선수 이름을 지킨다', () => {
  const teamsAfterSwap = TEAMS.map((t) => (t.no === 1 ? { ...t, players: ['대타', t.players[1], t.players[2]] } : t));
  const next = applySave(
    [game(1, 2, 1, 3, 0)],
    teamsAfterSwap,
    { a: 2, b: 1, by: '범수', games: [{ tier: 1, ga: 1, gb: 3 }, { tier: 2, ga: 0, gb: 0 }] },
    '2026-10-02T00:00:00.000Z',
  );
  const byTier = Object.fromEntries(next.map((g) => [g.tier, [g.a, g.b, g.ga, g.gb, g.pa, g.pb]]));
  assert.deepEqual(byTier[1], [1, 2, 3, 1, '스톰', '범수']);
  assert.deepEqual(byTier[2], [1, 2, 0, 0, '자본', '하늘']);
});

test('명단에 없는 팀·잘못된 티어·같은 팀끼리의 판은 경기표와 개인 기록에서도 무시한다', () => {
  const bad = [
    { a: 1, b: 12, tier: 1, ga: 5, gb: 0, pa: '스톰', pb: '유령' },
    { a: 1, b: 2, tier: 4, ga: 5, gb: 0, pa: '스톰', pb: '범수' },
    { a: 3, b: 3, tier: 1, ga: 5, gb: 0, pa: '병희', pb: '병희' },
  ];
  const cells = computeMatrix(TEAMS, bad);
  assert.ok(TEAMS.every((t) => Object.keys(cells[t.no]).length === 0));
  const stats = computePlayerStats(TEAMS, bad);
  assert.equal(stats[1].length, 9);
  assert.ok(stats[1].every((p) => p.w + p.d + p.l === 0));
  assert.equal(computeTeamStandings(TEAMS, bad).recordedGames, 0);
});

test('개인 기록은 판당 평균 승점 → 판당 득실 → 판당 득점 순이며, 미경기는 마지막에 순위 없이 둔다', () => {
  const stats = computePlayerStats(TEAMS, [
    game(1, 2, 1, 3, 0),
    game(3, 4, 1, 1, 0),
    game(5, 6, 1, 2, 1),
    game(7, 8, 1, 2, 1),
  ]);
  assert.deepEqual(
    stats[1].map((p) => [p.name, p.rank]),
    [['스톰', 1], ['레오', 2], ['우설', 2], ['병희', 4], ['크카모', 5], ['하지', 5], ['태현', 7], ['범수', 8], ['뚝배기', null]],
  );
});

test('playerRecord는 개인 탭과 같은 기준: 티어를 옮겨도 사람 기준, 탈퇴한 앞 선수의 판은 이어받은 사람에게', () => {
  const games = [
    { ...game(7, 4, 1, 2, 0), pb: '태현', pa: '옛우설' }, // 7팀 1티어 자리에서 (명단에 없는) 옛우설이 뛴 판
    game(7, 1, 1, 1, 1), // 지금 명단의 우설이 뛴 판
    { ...game(4, 2, 2, 3, 1), pa: '태현' }, // 태현이 2티어로 옮겨 뛴 판(태현은 명단에 있으니 태풍에게 안 감)
  ];
  // 옛우설의 승리 + 우설의 무승부
  assert.deepEqual(playerRecord(TEAMS, games, '우설'), { w: 1, d: 1, l: 0, pts: 4, scored: 3, conceded: 1, diff: 2 });
  assert.deepEqual(playerRecord(TEAMS, games, '옛우설'), { w: 0, d: 0, l: 0, pts: 0, scored: 0, conceded: 0, diff: 0 });
  // 1티어에서 진 판과 2티어에서 이긴 판을 더한다
  assert.deepEqual(playerRecord(TEAMS, games, '태현'), { w: 1, d: 0, l: 1, pts: 3, scored: 3, conceded: 3, diff: 0 });
  assert.deepEqual(playerRecord(TEAMS, games, '태풍'), { w: 0, d: 0, l: 0, pts: 0, scored: 0, conceded: 0, diff: 0 });
  assert.deepEqual(playerRecord(TEAMS, games, '없는사람'), { w: 0, d: 0, l: 0, pts: 0, scored: 0, conceded: 0, diff: 0 });
});

test('개인 평균 승점: 누적 4점인 2판 선수가 누적 6점인 4판 선수보다 앞선다', () => {
  const rows = computePlayerStats(TEAMS, [
    game(1, 7, 1, 1, 0),
    game(1, 8, 1, 0, 0), // 스톰: 1승 1무, 2판 4점, 평균 2.00
    game(3, 2, 1, 1, 0),
    game(3, 4, 1, 1, 0),
    game(3, 5, 1, 0, 1),
    game(3, 6, 1, 0, 1), // 병희: 2승 2패, 4판 6점, 평균 1.50
  ])[1];
  assert.deepEqual(rows.filter((p) => ['스톰', '병희'].includes(p.name)).map((p) => p.name), ['스톰', '병희']);
  const storm = rows.find((p) => p.name === '스톰');
  const bh = rows.find((p) => p.name === '병희');
  assert.deepEqual([storm.played, storm.pts, storm.avgPts], [2, 4, 2]);
  assert.deepEqual([bh.played, bh.pts, bh.avgPts], [4, 6, 1.5]);
});

test('개인 평균 승점이 같으면 누적 득실보다 판당 득실을 먼저 비교한다', () => {
  const rows = computePlayerStats(TEAMS, [
    game(1, 2, 1, 2, 0),
    game(1, 4, 1, 2, 0), // 스톰: 2판 +4, 판당 +2
    game(3, 5, 1, 3, 0), // 병희: 1판 +3, 판당 +3
  ])[1];
  assert.deepEqual(rows.slice(0, 2).map((p) => [p.name, p.rank, p.avgPts, p.played, p.diff]), [
    ['병희', 1, 3, 1, 3],
    ['스톰', 2, 3, 2, 4],
  ]);
});

test('개인 평균 승점과 평균 득실이 같으면 판당 득점으로 가른다', () => {
  const rows = computePlayerStats(TEAMS, [
    game(1, 2, 1, 3, 2),
    game(1, 4, 1, 3, 2), // 스톰: 판당 3점, +1, 3득점(누적 6득점)
    game(3, 5, 1, 4, 3), // 병희: 판당 3점, +1, 4득점(누적 4득점)
  ])[1];
  assert.deepEqual(rows.slice(0, 2).map((p) => [p.name, p.rank, p.played, p.scored, p.diff]), [
    ['병희', 1, 1, 4, 1],
    ['스톰', 2, 2, 6, 2],
  ]);
});

test('개인 세 평균이 정확히 같으면 판수가 달라도 공동 2위이고 다음은 4위다', () => {
  // 입력 명단을 뒤집어도 같은 순위 안에서는 팀번호 순서로 표시한다.
  const rows = computePlayerStats([...TEAMS].reverse(), [
    game(1, 2, 1, 4, 0), // 1위: 평균 승점 3, 득실 +4
    game(3, 4, 1, 3, 1), // 병희: 1판 3점, +2, 3득점
    game(5, 6, 1, 3, 1),
    game(5, 7, 1, 3, 1), // 레오: 2판 6점, +4, 6득점 — 병희와 세 평균 동일
    game(8, 9, 1, 2, 1), // 4위: 평균 승점 3, 득실 +1
  ])[1];
  assert.deepEqual(rows.slice(0, 4).map((p) => [p.name, p.rank]), [
    ['스톰', 1], ['병희', 2], ['레오', 2], ['하지', 4],
  ]);
  assert.deepEqual(rows.filter((p) => ['병희', '레오'].includes(p.name)).map((p) => [p.played, p.pts, p.diff, p.scored]), [
    [1, 3, 2, 3], [2, 6, 4, 6],
  ]);
});

test('개인 평균 승점은 두 자리 표시가 같아도 반올림 전 비율로 정렬한다', () => {
  // 17팀 예시는 1/8=0.125와 2/15=0.13333...를 만들기 위한 독립 자료다.
  const teams = Array.from({ length: 17 }, (_, i) => ({
    no: i + 1,
    name: `예시팀${i + 1}`,
    players: [`예시${i + 1}-1`, `예시${i + 1}-2`, `예시${i + 1}-3`],
  }));
  const makeGame = (a, b, ga, gb) => ({
    a, b, tier: 1, ga, gb,
    pa: teams[a - 1].players[0], pb: teams[b - 1].players[0],
  });
  const rows = computePlayerStats(teams, [
    ...Array.from({ length: 8 }, (_, i) => makeGame(1, i + 3, 0, i === 0 ? 0 : 1)),
    ...Array.from({ length: 15 }, (_, i) => makeGame(2, i + 3, 0, i < 2 ? 0 : 2)),
  ])[1];
  const lower = rows.find((p) => p.name === '예시1-1');
  const higher = rows.find((p) => p.name === '예시2-1');
  assert.deepEqual([lower.played, lower.pts, lower.avgPts], [8, 1, 0.125]);
  assert.deepEqual([higher.played, higher.pts, higher.avgPts], [15, 2, 0.13333333333333333]);
  assert.deepEqual([lower.avgPts.toFixed(2), higher.avgPts.toFixed(2)], ['0.13', '0.13']);
  // 평균 득실은 1팀(-7/8)이 더 좋아도, 평균 승점이 높은 2팀이 먼저다.
  assert.deepEqual(rows.filter((p) => ['예시1-1', '예시2-1'].includes(p.name)).map((p) => p.name), ['예시2-1', '예시1-1']);
  assert.ok(higher.rank < lower.rank);
});

test('개인 0점 출전자는 미경기보다 앞서며 미경기의 평균과 순위는 null이다', () => {
  const rows = computePlayerStats(TEAMS, [game(2, 3, 1, 0, 1)])[1];
  assert.deepEqual(rows.slice(0, 3).map((p) => [p.name, p.rank, p.played, p.avgPts]), [
    ['병희', 1, 1, 3], ['범수', 2, 1, 0], ['스톰', null, 0, null],
  ]);
  assert.deepEqual(rows.slice(2).map((p) => p.teamNo), [1, 4, 5, 6, 7, 8, 9]);
  assert.ok(rows.slice(2).every((p) => p.rank === null && p.played === 0 && p.avgPts === null));
});

test('개인 전원 미경기는 명단을 유지하고 0분모 평균과 순위를 만들지 않는다', () => {
  const stats = computePlayerStats(TEAMS, []);
  for (const tier of TIERS) {
    assert.equal(stats[tier].length, 9);
    assert.deepEqual(stats[tier].map((p) => p.teamNo), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(stats[tier].every((p) => p.played === 0 && p.avgPts === null && p.rank === null));
  }
});

test('개인 평균의 판수에는 앞선 선수가 뛴 판도 들어가고 개인 일정 합계는 그대로다', () => {
  const teams = TEAMS.map((t) => t.no === 3 ? { ...t, players: ['일도', ...t.players.slice(1)] } : t);
  const games = [
    game(3, 1, 1, 3, 0), // 병희 승
    game(2, 3, 1, 1, 1), // 병희 무
    { ...game(3, 4, 1, 0, 2), pa: '일도' }, // 일도 패
  ];
  const rows = computePlayerStats(teams, games)[1];
  assert.equal(rows.find((p) => p.name === '병희'), undefined);
  const ido = rows.find((p) => p.name === '일도');
  assert.deepEqual([ido.w, ido.d, ido.l, ido.played, ido.pts, ido.avgPts], [1, 1, 1, 3, 4, 1.3333333333333333]);
  assert.deepEqual(ido.inherited, [{ name: '병희', opponent: 1 }, { name: '병희', opponent: 2 }]);
  assert.deepEqual(playerRecord(teams, games, '일도'), { w: 1, d: 1, l: 1, pts: 4, scored: 4, conceded: 3, diff: 1 });
  assert.deepEqual(games.map((g) => [g.pa, g.pb]), [['병희', '스톰'], ['범수', '병희'], ['일도', '태현']]);
});
