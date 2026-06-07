// KBO 순위 스크레이퍼 (GitHub Actions에서 매일 자동 실행)
// 진짜 브라우저(Playwright)로 다음 스포츠 순위 페이지를 열어,
// (1) 페이지가 불러오는 JSON 응답을 가로채거나
// (2) 화면에 그려진 표를 직접 읽어
// 10개 구단 승/패/무를 뽑아 standings.json 으로 저장합니다.

const { chromium } = require('playwright');
const fs = require('fs');

const TEAMS10 = ['LG', '두산', '키움', 'KT', 'SSG', 'NC', '삼성', 'KIA', '한화', '롯데'];

const PAGES = [
  'https://sports.daum.net/record/kbo',
  'https://m.sports.naver.com/kbaseball/record/index?category=kbo'
];

function matchTeam(name) {
  name = String(name);
  const up = name.toUpperCase();
  for (const t of TEAMS10) if (up.includes(t.toUpperCase())) return t;
  if (name.includes('기아')) return 'KIA';
  return null;
}
function pick(o, keys) {
  for (const k of keys) if (o[k] != null && !isNaN(o[k])) return Number(o[k]);
  return null;
}
function walk(node, found) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walk(n, found)); return; }
  const name = node.teamName || node.name || node.team || node.teamShortName || node.shortName;
  const w = pick(node, ['win', 'wins', 'w', 'winGame', 'gameWin', 'winCnt']);
  const l = pick(node, ['lose', 'loss', 'losses', 'l', 'loseGame', 'gameLose', 'loseCnt']);
  const m = name ? matchTeam(name) : null;
  if (m && w !== null && l !== null) {
    const d = pick(node, ['draw', 'draws', 'd', 'drawGame', 'gameDraw', 'drawnGame', 'drawCnt', 'tie']);
    found.push({ name: m, w, l, d: d === null ? 0 : d });
  }
  for (const k in node) walk(node[k], found);
}
function dedupe(arr) {
  const seen = {}, out = [];
  for (const t of arr) if (!seen[t.name]) { seen[t.name] = 1; out.push(t); }
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await ctx.newPage();

  const jsonBodies = [];
  page.on('response', async (res) => {
    try {
      const ct = (res.headers()['content-type'] || '');
      if (ct.includes('json')) jsonBodies.push(await res.text());
    } catch (e) {}
  });

  let teams = [];
  for (const url of PAGES) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3500);
    } catch (e) {
      console.error('goto 실패:', url, e.message);
    }

    // (1) 가로챈 JSON 에서 추출
    for (const body of jsonBodies) {
      try {
        const found = [];
        walk(JSON.parse(body), found);
        const d = dedupe(found);
        if (d.length >= 8) { teams = d; break; }
      } catch (e) {}
    }
    if (teams.length >= 8) { console.log('성공(JSON):', url); break; }

    // (2) 화면에 그려진 표를 직접 읽기: 팀명 뒤 정수들 = [경기, 승, 패, 무]
    try {
      const domTeams = await page.evaluate((TEAMS10) => {
        const out = [];
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(c => c.textContent.replace(/\s+/g, '').trim());
          let ti = -1, team = null;
          for (let i = 0; i < cells.length; i++) {
            for (const t of TEAMS10) {
              if (cells[i].toUpperCase().includes(t.toUpperCase())) { team = t; ti = i; break; }
            }
            if (!team && cells[i].includes('기아')) { team = 'KIA'; ti = i; }
            if (team) break;
          }
          if (!team) continue;
          const ints = cells.slice(ti + 1).filter(c => /^\d+$/.test(c)).map(Number);
          if (ints.length >= 3) {
            out.push({ name: team, w: ints[1], l: ints[2], d: ints.length >= 4 ? ints[3] : 0 });
          }
        }
        return out;
      }, TEAMS10);
      const d = dedupe(domTeams);
      if (d.length >= 8) { teams = d; console.log('성공(표 읽기):', url); break; }
    } catch (e) {
      console.error('DOM 파싱 실패:', url, e.message);
    }
  }

  await browser.close();

  if (teams.length < 8) {
    console.error('순위 추출 실패. 페이지 구조가 바뀌었을 수 있습니다.');
    process.exit(1);
  }

  const data = {
    updated: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    teams
  };
  fs.writeFileSync('standings.json', JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
})();
