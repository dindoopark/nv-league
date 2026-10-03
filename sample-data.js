// 데모 모드(config.js의 API_URL이 빈 경우)에서 보여 주는 예시 데이터. 실제 결과가 아니다.
// 팀 번호·이름·명단은 apps-script/Code.gs의 ROSTER와 같게 둔다.

const ROSTER = [
  ['시그니엘', '스톰', '자본', '현우'],
  ['노인정', '범수', '하늘', '맹구'],
  ['달려라콜여사', '병희', '콜드', '쟁이'],
  ['구육칠즈', '태현', '태풍', '로우'],
  ['사자는어흥', '레오', '로마', '대전'],
  ['크카모원정대', '크카모', '원형', '정민'],
  ['어색즈', '우설', '환타', '울프'],
  ['젊크크', '하지', '소보로', '레몬'],
  ['대갈장군', '뚝배기', '치노', '수프러차'],
];

// 대진표 1~2주차는 모두 끝났고 3주차는 진행 중인 예시.
// [홈 팀 이름, 원정 팀 이름, 1티어 [홈, 원정], 2티어, 3티어, 주차] — null은 아직 안 한 판
const RESULTS = [
  ['노인정', '어색즈', [2, 1], [1, 1], [0, 2], 1],
  ['젊크크', '크카모원정대', [3, 1], [2, 0], [1, 1], 1],
  ['달려라콜여사', '대갈장군', [1, 2], [0, 0], [2, 1], 1],
  ['사자는어흥', '시그니엘', [4, 2], [1, 0], [2, 2], 1],
  ['구육칠즈', '어색즈', [1, 0], [2, 2], [3, 1], 2],
  ['노인정', '대갈장군', [0, 1], [1, 3], [2, 2], 2],
  ['젊크크', '시그니엘', [2, 2], [1, 0], [0, 1], 2],
  ['달려라콜여사', '사자는어흥', [1, 1], [0, 2], [2, 3], 2],
  ['구육칠즈', '크카모원정대', [2, 1], null, null, 3],
  ['어색즈', '대갈장군', [1, 1], [2, 0], [0, 0], 3],
];

const teams = ROSTER.map(([name, ...players], i) => ({ no: i + 1, name, players }));
const teamByName = (name) => teams.find((t) => t.name === name);

export const SAMPLE_DATA = {
  teams,
  games: RESULTS.flatMap(([homeName, awayName, ...rest]) => {
    const week = rest.pop();
    const home = teamByName(homeName);
    const away = teamByName(awayName);
    const at = `2026-10-${String(week * 7 - 2).padStart(2, '0')}T12:00:00.000Z`;
    return rest.flatMap((score, i) =>
      score
        ? [
            {
              a: home.no,
              b: away.no,
              tier: i + 1,
              ga: score[0],
              gb: score[1],
              pa: home.players[i],
              pb: away.players[i],
              at,
              by: '조이',
            },
          ]
        : [],
    );
  }),
  // 결과를 입력할 수 있는 운영진(실제 명단은 구글 시트 설정 탭)
  settings: { playoffWinner: null, staff: ['조이', '병희', '정민', '뚝배기', '하지', '치노'] },
  serverTime: '2026-10-19T12:00:00.000Z',
};
