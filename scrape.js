// KBO 순위 + 오늘 경기 스크레이퍼 (GitHub Actions 자동 실행)
// 진짜 브라우저(Playwright)로 다음 스포츠를 열어
//  - 순위(teams): record 페이지에서 (JSON 가로채기 → 표 읽기)
//  - 오늘 경기(games): schedule 페이지에서 (화면 카드 읽기)
// 를 뽑아 standings.json 으로 저장합니다. 순위는 필수, 경기는 best-effort.

const { chromium } = require('playwright');
const fs = require('fs');

const TEAMS10 = ['LG', '두산', '키움', 'KT', 'SSG', 'NC', '삼성', 'KIA', '한화', '롯데'];
const RECORD_PAGES = [
  'https://sports.daum.net/record/kbo',
  'https://m.sports.naver.com/kbaseball/record/index?category=kbo'
];
const SCHEDULE_PAGE = 'https://sports.daum.net/schedule/kbo';

function matchTeam(name) {
  name = String(name);
  const up = name.toUpperCase();
  for (const t of TEAMS10) if (up.includes(t.toUpperCase())) return t;
  if (name.includes('기아')) return 'KIA';
  return null;
}
function pick(o, keys) { for (const k of keys) if (o[k] != null && !isNaN(o[k])) return Number(o[k]); return null; }
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
function dedupe(arr) { const seen = {}, out = []; for (const t of arr) if (!seen[t.name]) { seen[t.name] = 1; out.push(t); } return out; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await ctx.newPage();
  const jsonBodies = [];
  page.on('response', async (res) => {
    try { const ct = (res.headers()['content-type'] || ''); if (ct.includes('json')) jsonBodies.push(await res.text()); } catch (e) {}
  });

  // ===== 순위 =====
  let teams = [];
  for (const url of RECORD_PAGES) {
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); await page.waitForTimeout(3500); }
    catch (e) { console.error('goto 실패:', url, e.message); }
    for (const body of jsonBodies) {
      try { const f = []; walk(JSON.parse(body), f); const d = dedupe(f); if (d.length >= 8) { teams = d; break; } } catch (e) {}
    }
    if (teams.length >= 8) { console.log('순위 성공(JSON):', url); break; }
    try {
      const domTeams = await page.evaluate((TEAMS10) => {
        const out = [];
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('th,td')).map(c => c.textContent.replace(/\s+/g, '').trim());
          let ti = -1, team = null;
          for (let i = 0; i < cells.length; i++) {
            for (const t of TEAMS10) if (cells[i].toUpperCase().includes(t.toUpperCase())) { team = t; ti = i; break; }
            if (!team && cells[i].includes('기아')) { team = 'KIA'; ti = i; }
            if (team) break;
          }
          if (!team) continue;
          const ints = cells.slice(ti + 1).filter(c => /^\d+$/.test(c)).map(Number);
          if (ints.length >= 3) { var a = ints[2], b = ints.length >= 4 ? ints[3] : 0; out.push({ name: team, w: ints[1], l: Math.max(a, b), d: Math.min(a, b) }); }
        }
        return out;
      }, TEAMS10);
      const d = dedupe(domTeams);
      if (d.length >= 8) { teams = d; console.log('순위 성공(표):', url); break; }
    } catch (e) { console.error('순위 DOM 실패:', e.message); }
  }
  if (teams.length < 8) { await browser.close(); console.error('순위 추출 실패'); process.exit(1); }

  // ===== 오늘 경기 (best-effort) =====
  let games = [];
  try {
    await page.goto(SCHEDULE_PAGE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3500);
    games = await page.evaluate((TEAMS10) => {
      const STAD = ['잠실', '문학', '대구', '광주', '사직', '창원', '대전', '수원', '고척', '포항', '울산', '청주'];
      const els = Array.from(document.querySelectorAll('li, a, tr, div'));
      const seen = {}, out = [];
      for (const el of els) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 70) continue;
        const found = [];
        for (const t of TEAMS10) if (txt.toUpperCase().includes(t.toUpperCase())) found.push(t);
        if (txt.includes('기아') && found.indexOf('KIA') < 0) found.push('KIA');
        const uniq = found.filter((v, i) => found.indexOf(v) === i);
        if (uniq.length !== 2) continue;
        const key = uniq.slice().sort().join('-');
        if (seen[key]) continue;
        seen[key] = 1;
        const tm = txt.match(/\d{1,2}:\d{2}/);
        const std = STAD.find(s => txt.includes(s)) || '';
        out.push({ away: uniq[0], home: uniq[1], time: tm ? tm[0] : '', stadium: std });
      }
      return out.slice(0, 5);
    }, TEAMS10);
    console.log('오늘 경기:', games.length, '개');
  } catch (e) { console.error('경기 수집 실패(무시):', e.message); }

  await browser.close();

  // ===== 최근 5경기 (이전 standings.json 과 비교해 W/L 누적) =====
  let prevMap = {};
  try {
    if (fs.existsSync('standings.json')) {
      const prev = JSON.parse(fs.readFileSync('standings.json', 'utf8'));
      if (prev && Array.isArray(prev.teams)) prev.teams.forEach(p => { prevMap[p.name] = p; });
    }
  } catch (e) { console.error('이전 standings.json 읽기 실패(무시):', e.message); }

  teams.forEach(t => {
    const p = prevMap[t.name];
    let form = (p && Array.isArray(p.form)) ? p.form.slice() : [];
    if (p) {
      const dw = Math.max(0, (t.w || 0) - (p.w || 0));
      const dl = Math.max(0, (t.l || 0) - (p.l || 0));
      const dd = Math.max(0, (t.d || 0) - (p.d || 0));
      for (let i = 0; i < Math.min(dw, 5); i++) form.push('W');
      for (let i = 0; i < Math.min(dl, 5); i++) form.push('L');
      for (let i = 0; i < Math.min(dd, 5); i++) form.push('D');
    }
    t.form = form.slice(-5);
  });

  const data = {
    updated: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    teams,
    games
  };
  fs.writeFileSync('standings.json', JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
})();
