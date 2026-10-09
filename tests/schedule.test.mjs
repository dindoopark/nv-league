import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULE, checkSchedule, scheduleView, teamFixtures, playerFixtures } from '../schedule.js';
import { TEAM_META, teamMeta } from '../teams.js';
import { SAMPLE_DATA } from '../sample-data.js';

const NAMES = ['구육칠즈', '노인정', '달려라콜여사', '대갈장군', '사자는어흥', '시그니엘', '어색즈', '젊크크', '크카모원정대'];
const TEAMS = NAMES.map((name, i) => ({ no: i + 1, name, players: [`${name}1`, `${name}2`, `${name}3`] }));
const byName = (name) => TEAMS.find((t) => t.name === name).no;

function games(homeName, awayName, scores) {
  return scores.map(([ga, gb], i) => ({ a: byName(homeName), b: byName(awayName), tier: i + 1, ga, gb }));
}

test('대진표는 9팀 단일 풀리그: 36경기가 겹치지 않고 매주 모든 팀이 한 번씩 뛰거나 쉰다', () => {
  assert.deepEqual(checkSchedule(SCHEDULE), []);
  assert.equal(SCHEDULE.length, 9);
  assert.equal(SCHEDULE.flatMap((w) => w.matches).length, 36);
});

test('checkSchedule은 겹친 대진, 한 주에 두 번 나온 팀, 쉬는 팀이 뛰는 경우를 찾아낸다', () => {
  const broken = structuredClone(SCHEDULE);
  broken[1].matches[0] = ['노인정', '어색즈']; // 1주차와 같은 대진, 2주차에 노인정 두 번
  broken[2].rest = '구육칠즈'; // 3주차에 뛰는 팀이 휴식
  const problems = checkSchedule(broken);
  assert.ok(problems.some((p) => p.includes('노인정') && p.includes('어색즈') && p.includes('두 번')));
  assert.ok(problems.some((p) => p.includes('2주차') && p.includes('노인정')));
  assert.ok(problems.some((p) => p.includes('3주차') && p.includes('구육칠즈')));
});

test('scheduleView는 경기마다 진행 상태와 홈 팀 기준 승점을 붙이고, 끝나지 않은 첫 주차를 현재 주차로 둔다', () => {
  const played = [
    ...games('노인정', '어색즈', [[2, 1], [1, 1], [3, 0]]), // 1주차 끝: 노인정 7:1
    ...games('젊크크', '크카모원정대', [[0, 1]]), // 1주차 진행 중 1/3
  ];
  const view = scheduleView(SCHEDULE, TEAMS, played);
  assert.equal(view.currentWeek, 1);
  const w1 = view.weeks[0];
  assert.equal(w1.current, true);
  assert.equal(w1.restNo, byName('구육칠즈'));
  assert.deepEqual(
    w1.matches.map((m) => [m.homeName, m.awayName, m.status, m.pts, m.oppPts, m.count]),
    [
      ['노인정', '어색즈', 'done', 7, 1, 3],
      ['젊크크', '크카모원정대', 'partial', 0, 3, 1],
      ['달려라콜여사', '대갈장군', 'todo', 0, 0, 0],
      ['사자는어흥', '시그니엘', 'todo', 0, 0, 0],
    ],
  );
  assert.deepEqual([w1.done, w1.total], [1, 4]);
  assert.equal(view.weeks[1].current, false);
});

test('scheduleView는 팀 탭에 없는 이름도 멈추지 않고 번호를 null로 둔다', () => {
  const renamed = TEAMS.map((t) => (t.name === '시그니엘' ? { ...t, name: '시그니엘FC' } : t));
  const view = scheduleView(SCHEDULE, renamed, []);
  const m = view.weeks[0].matches[3];
  assert.deepEqual([m.homeName, m.awayName, m.away, m.status], ['사자는어흥', '시그니엘', null, 'todo']);
  assert.equal(view.weeks[2].restNo, null);
});

test('모든 경기가 끝나면 현재 주차는 없다', () => {
  const all = SCHEDULE.flatMap((w) => w.matches.flatMap(([h, a]) => games(h, a, [[1, 0], [1, 0], [1, 0]])));
  const view = scheduleView(SCHEDULE, TEAMS, all);
  assert.equal(view.currentWeek, null);
  assert.ok(view.weeks.every((w) => !w.current && w.done === 4));
});

test('teamFixtures는 한 팀의 9주 일정을 그 팀 기준 승점으로 돌려준다', () => {
  const played = games('노인정', '어색즈', [[2, 1], [1, 1], [3, 0]]);
  const view = scheduleView(SCHEDULE, TEAMS, played);
  const list = teamFixtures(view, byName('어색즈'));
  assert.equal(list.length, 9);
  assert.deepEqual(list[0], { week: 1, rest: false, opponent: byName('노인정'), opponentName: '노인정', status: 'done', pts: 1, oppPts: 7 });
  const restWeek = list.find((f) => f.rest);
  assert.equal(restWeek.week, 6);
});

test('playerFixtures는 한 선수(팀·티어)의 9주 일정을 그 판 기준으로 돌려준다(홈·원정 모두 내 점수가 앞)', () => {
  const played = [
    ...games('노인정', '어색즈', [[2, 1], [1, 1], [3, 0]]), // 1주차: 어색즈가 원정
    ...games('구육칠즈', '어색즈', [[0, 0], [4, 2]]), // 2주차: 어색즈 원정, 3티어는 아직
  ];
  const view = scheduleView(SCHEDULE, TEAMS, played);
  const list = playerFixtures(view, TEAMS, played, byName('어색즈'), 2);
  assert.equal(list.length, 9);
  assert.deepEqual(list[0], {
    week: 1,
    current: true, // 1주차의 다른 경기가 아직 안 끝났다
    rest: false,
    opponent: byName('노인정'),
    opponentName: '노인정',
    home: byName('노인정'),
    away: byName('어색즈'),
    oppPlayer: '노인정2',
    playedBy: '',
    ga: 1,
    gb: 1,
    outcome: 'd',
  });
  assert.deepEqual([list[1].ga, list[1].gb, list[1].outcome], [2, 4, 'l']);
  // 3주차는 아직: 점수 없음, 상대는 지금 명단의 같은 티어
  assert.deepEqual([list[2].ga, list[2].gb, list[2].outcome, list[2].oppPlayer], [null, null, 'todo', '대갈장군2']);
  assert.deepEqual(list.filter((f) => f.current).map((f) => f.week), [1]);
  const rest = list.find((f) => f.rest);
  assert.deepEqual([rest.week, rest.outcome, rest.opponent, rest.oppPlayer], [6, 'rest', null, '']);
});

test('playerFixtures: 그 판을 아직 안 했으면 같은 경기의 다른 티어가 끝났어도 예정, 이긴 판은 승', () => {
  const played = games('노인정', '어색즈', [[2, 1], [1, 1]]);
  const view = scheduleView(SCHEDULE, TEAMS, played);
  assert.equal(playerFixtures(view, TEAMS, played, byName('어색즈'), 3)[0].outcome, 'todo');
  const home = playerFixtures(view, TEAMS, played, byName('노인정'), 1)[0];
  assert.deepEqual([home.ga, home.gb, home.outcome, home.oppPlayer], [2, 1, 'w', '어색즈1']);
});

test('playerFixtures: 치른 판은 기록된 이름을 쓰고, 지금 명단과 다르면 playedBy에 그 판을 한 사람을 남긴다', () => {
  const played = [{ a: byName('노인정'), b: byName('어색즈'), tier: 1, ga: 0, gb: 3, pa: '옛노인', pb: '옛어색' }];
  const view = scheduleView(SCHEDULE, TEAMS, played);
  const mine = playerFixtures(view, TEAMS, played, byName('어색즈'), 1)[0];
  assert.deepEqual([mine.oppPlayer, mine.playedBy, mine.outcome], ['옛노인', '옛어색', 'w']);
  const same = [{ ...played[0], pb: '어색즈1' }];
  assert.equal(playerFixtures(scheduleView(SCHEDULE, TEAMS, same), TEAMS, same, byName('어색즈'), 1)[0].playedBy, '');
});

test('playerFixtures: 상대 팀 이름을 시트에서 못 찾으면 opponent는 null이고 예정으로 둔다', () => {
  const renamed = TEAMS.map((t) => (t.name === '노인정' ? { ...t, name: '노인정FC' } : t));
  const view = scheduleView(SCHEDULE, renamed, []);
  const first = playerFixtures(view, renamed, [], byName('어색즈'), 1)[0];
  assert.deepEqual([first.opponent, first.opponentName, first.oppPlayer, first.outcome], [null, '노인정', '', 'todo']);
});

test('팀 이름마다 로고와 색이 있고, 없는 이름은 null', () => {
  assert.deepEqual(Object.keys(TEAM_META).sort(), [...NAMES].sort());
  for (const meta of Object.values(TEAM_META)) {
    assert.match(meta.logo, /^logos\/[a-z0-9-]+\.webp$/);
    assert.match(meta.accent, /^#[0-9a-f]{6}$/);
    assert.match(meta.base, /^#[0-9a-f]{6}$/);
  }
  assert.equal(teamMeta('없는팀'), null);
});

test('예시 데이터의 팀 이름은 대진표 이름과 같고, 예시 결과는 대진표에 있는 경기뿐이다', () => {
  assert.deepEqual(SAMPLE_DATA.teams.map((t) => t.name).sort(), [...NAMES].sort());
  const pairs = new Set(
    SCHEDULE.flatMap((w) =>
      w.matches.map(([h, a]) => {
        const no = (n) => SAMPLE_DATA.teams.find((t) => t.name === n).no;
        return [no(h), no(a)].sort((x, y) => x - y).join('-');
      }),
    ),
  );
  for (const g of SAMPLE_DATA.games) assert.ok(pairs.has([g.a, g.b].sort((x, y) => x - y).join('-')), `${g.a}-${g.b}`);
});
