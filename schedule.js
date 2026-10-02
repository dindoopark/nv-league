// 주차별 대진표(팀 이름). 일정이 바뀌면 SCHEDULE만 고친다. 날짜는 정하지 않고 주차로만 둔다.
import { TIERS, computeMatrix } from './standings.js';

export const SCHEDULE = [
  { week: 1, matches: [['노인정', '어색즈'], ['젊크크', '크카모원정대'], ['달려라콜여사', '대갈장군'], ['사자는어흥', '시그니엘']], rest: '구육칠즈' },
  { week: 2, matches: [['구육칠즈', '어색즈'], ['노인정', '대갈장군'], ['젊크크', '시그니엘'], ['달려라콜여사', '사자는어흥']], rest: '크카모원정대' },
  { week: 3, matches: [['구육칠즈', '크카모원정대'], ['어색즈', '대갈장군'], ['노인정', '사자는어흥'], ['젊크크', '달려라콜여사']], rest: '시그니엘' },
  { week: 4, matches: [['구육칠즈', '대갈장군'], ['크카모원정대', '시그니엘'], ['어색즈', '사자는어흥'], ['노인정', '젊크크']], rest: '달려라콜여사' },
  { week: 5, matches: [['구육칠즈', '시그니엘'], ['대갈장군', '사자는어흥'], ['크카모원정대', '달려라콜여사'], ['어색즈', '젊크크']], rest: '노인정' },
  { week: 6, matches: [['구육칠즈', '사자는어흥'], ['시그니엘', '달려라콜여사'], ['대갈장군', '젊크크'], ['크카모원정대', '노인정']], rest: '어색즈' },
  { week: 7, matches: [['구육칠즈', '달려라콜여사'], ['사자는어흥', '젊크크'], ['시그니엘', '노인정'], ['크카모원정대', '어색즈']], rest: '대갈장군' },
  { week: 8, matches: [['구육칠즈', '젊크크'], ['달려라콜여사', '노인정'], ['시그니엘', '어색즈'], ['대갈장군', '크카모원정대']], rest: '사자는어흥' },
  { week: 9, matches: [['구육칠즈', '노인정'], ['달려라콜여사', '어색즈'], ['사자는어흥', '크카모원정대'], ['시그니엘', '대갈장군']], rest: '젊크크' },
];

// 대진표가 풀리그 규칙을 지키는지 본다. 문제를 한국어 문장 목록으로 돌려준다(없으면 빈 배열).
export function checkSchedule(schedule) {
  const problems = [];
  const names = new Set(schedule.flatMap((w) => [...w.matches.flat(), w.rest]));
  const seen = new Map();
  for (const w of schedule) {
    const playing = w.matches.flat();
    const counts = new Map();
    for (const name of playing) counts.set(name, (counts.get(name) || 0) + 1);
    for (const [name, n] of counts) if (n > 1) problems.push(`${w.week}주차에 ${name} 팀이 ${n}번 나옵니다.`);
    if (playing.includes(w.rest)) problems.push(`${w.week}주차 휴식 팀 ${w.rest}이(가) 경기에도 나옵니다.`);
    for (const name of names) {
      if (!counts.has(name) && name !== w.rest) problems.push(`${w.week}주차에 ${name} 팀이 빠졌습니다.`);
    }
    for (const [h, a] of w.matches) {
      const key = [h, a].sort().join(' vs ');
      if (seen.has(key)) problems.push(`${key} 대진이 ${seen.get(key)}주차와 ${w.week}주차에 두 번 있습니다.`);
      else seen.set(key, w.week);
    }
  }
  const expected = (names.size * (names.size - 1)) / 2;
  if (seen.size !== expected) problems.push(`서로 다른 대진이 ${seen.size}개입니다(풀리그면 ${expected}개).`);
  return problems;
}

// 대진표에 경기 결과를 붙인다. 승점은 홈(앞에 적힌) 팀 기준.
// 팀 탭에 없는 이름은 번호를 null로 두고 '예정'으로 본다.
export function scheduleView(schedule, teams, games) {
  const byName = new Map(teams.map((t) => [t.name, t]));
  const cells = computeMatrix(teams, games);
  const weeks = schedule.map((w) => {
    const matches = w.matches.map(([homeName, awayName]) => {
      const home = byName.get(homeName) ?? null;
      const away = byName.get(awayName) ?? null;
      const c = home && away ? cells[home.no][away.no] : undefined;
      const count = c?.count ?? 0;
      return {
        homeName,
        awayName,
        home: home?.no ?? null,
        away: away?.no ?? null,
        count,
        pts: c?.pts ?? 0,
        oppPts: c?.oppPts ?? 0,
        status: count === 0 ? 'todo' : count < TIERS.length ? 'partial' : 'done',
      };
    });
    const done = matches.filter((m) => m.status === 'done').length;
    return { week: w.week, rest: w.rest, restNo: byName.get(w.rest)?.no ?? null, matches, done, total: matches.length };
  });
  const currentWeek = weeks.find((w) => w.done < w.total)?.week ?? null;
  for (const w of weeks) w.current = w.week === currentWeek;
  return { weeks, currentWeek };
}

// 한 팀의 주차별 일정. 승점은 그 팀 기준. 휴식 주차는 rest: true.
export function teamFixtures(view, teamNo) {
  return view.weeks.map((w) => {
    if (w.restNo === teamNo) {
      return { week: w.week, rest: true, opponent: null, opponentName: '', status: 'rest', pts: 0, oppPts: 0 };
    }
    const m = w.matches.find((x) => x.home === teamNo || x.away === teamNo);
    if (!m) return { week: w.week, rest: false, opponent: null, opponentName: '', status: 'todo', pts: 0, oppPts: 0 };
    const isHome = m.home === teamNo;
    return {
      week: w.week,
      rest: false,
      opponent: isHome ? m.away : m.home,
      opponentName: isHome ? m.awayName : m.homeName,
      status: m.status,
      pts: isHome ? m.pts : m.oppPts,
      oppPts: isHome ? m.oppPts : m.pts,
    };
  });
}
