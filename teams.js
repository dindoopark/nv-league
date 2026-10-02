// 팀 이름별 로고와 색. 팀 번호·선수 명단은 구글 시트 팀 탭(데모는 sample-data.js)이 정하고,
// 화면은 팀 이름으로 여기서 로고와 색을 찾는다. 시트에서 팀 이름을 바꾸면 로고 대신 번호 배지가 나온다.

export const TEAM_META = {
  구육칠즈: { logo: 'logos/9697s.webp', accent: '#e0b351', base: '#0b3a16' },
  노인정: { logo: 'logos/noinjeong.webp', accent: '#d4ad62', base: '#0a1d3f' },
  달려라콜여사: { logo: 'logos/kol-yeosa.webp', accent: '#8fd18a', base: '#0c3a1d' },
  대갈장군: { logo: 'logos/daegal-janggun.webp', accent: '#e2453c', base: '#3a0707' },
  사자는어흥: { logo: 'logos/saja-eoheung.webp', accent: '#f08a24', base: '#1b0c05' },
  시그니엘: { logo: 'logos/signiel.webp', accent: '#a9c3ea', base: '#0a1f3d' },
  어색즈: { logo: 'logos/eosaekz.webp', accent: '#57cedc', base: '#08202a' },
  젊크크: { logo: 'logos/jeomkk.webp', accent: '#a78bfa', base: '#1c0840' },
  크카모원정대: { logo: 'logos/kkamo-wonjeongdae.webp', accent: '#e1c899', base: '#141b26' },
};

export function teamMeta(name) {
  return TEAM_META[name] ?? null;
}
