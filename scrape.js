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
 
// ----- 오늘 경기 추출용 -----
const _kst = new Date(Date.now() + 9 * 3600 * 1000);
const _pad = n => String(n).padStart(2, '0');
const TODAY_YMD = `${_kst.getUTCFullYear()}${_pad(_kst.getUTCMonth() + 1)}${_pad(_kst.getUTCDate())}`;
const STADIUMS = ['잠실', '문학', '대구', '광주', '사직', '창원', '대전', '수원', '고척', '포항', '울산', '청주'];
function walkGames(node, found) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walkGames(n, found)); return; }
  if (node.homeTeamName && node.awayTeamName && node.startDate) {
    const home = matchTeam(node.homeTeamName), away = matchTeam(node.awayTeamName);
    if (home && away && home !== away) {
      const st = String(node.startTime || '');
      const time = st.length >= 4 ? st.slice(0, 2) + ':' + st.slice(2, 4) : '';
      const stadium = STADIUMS.find(s => String(node.fieldName || '').includes(s)) || '';
      found.push({ away, home, time, stadium, date: String(node.startDate) });
    }
  }
  for (const k in node) walkGames(node[k], found);
}
function dedupeGames(arr) {
  const seen = {}, out = [];
  for (const g of arr) { const key = g.away + '-' + g.home; if (!seen[key]) { seen[key] = 1; out.push({ away: g.away, home: g.home, time: g.time || '', stadium: g.stadium || '' }); } }
  return out.slice(0, 5);
}
function wltToForm(x) { return x === 'W' ? 'W' : (x === 'L' ? 'L' : 'D'); }
function walkResults(node, out) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => walkResults(n, out)); return; }
  if (node.homeTeamName && node.awayTeamName && node.startDate && node.gameStatus === 'END' && node.homeWlt) {
    const h = matchTeam(node.homeTeamName), a = matchTeam(node.awayTeamName);
    if (h && a) out.push({ id: node.gameId, date: String(node.startDate), seq: node.matchSeq || 0, home: h, away: a, hw: String(node.homeWlt), aw: String(node.awayWlt) });
  }
  for (const k in node) walkResults(node[k], out);
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
 
  // ===== 최근 일정/결과 수집 (오늘 경기 + 최근 끝난 경기) =====
  let games = [], finals = [];
  try {
    jsonBodies.length = 0;
    for (let i = 11; i >= 0; i--) {
      const dt = new Date(_kst.getTime() - i * 86400000);
      const ymd = `${dt.getUTCFullYear()}${_pad(dt.getUTCMonth() + 1)}${_pad(dt.getUTCDate())}`;
      try { await page.goto(`${SCHEDULE_PAGE}?date=${ymd}`, { waitUntil: 'networkidle', timeout: 60000 }); await page.waitForTimeout(1800); } catch (e) {}
    }
    const allG = [];
    for (const body of jsonBodies) { try { const j = JSON.parse(body); walkGames(j, allG); walkResults(j, finals); } catch (e) {} }
    games = dedupeGames(allG.filter(g => g.date === TODAY_YMD));
    const dates = Array.from(new Set(allG.map(g => g.date))).sort();
    console.log('오늘:', TODAY_YMD, '| 수집된 날짜들:', dates.join(','));
    console.log('오늘 경기:', JSON.stringify(games));
  } catch (e) { console.error('경기 수집 실패(무시):', e.message); }
 
  await browser.close();
 
  // ===== 최근 5경기 (끝난 경기 결과로 정확히 계산) =====
  let prevMap = {};
  try {
    if (fs.existsSync('standings.json')) {
      const prev = JSON.parse(fs.readFileSync('standings.json', 'utf8'));
      if (prev && Array.isArray(prev.teams)) prev.teams.forEach(p => { prevMap[p.name] = p; });
    }
  } catch (e) { console.error('이전 standings.json 읽기 실패(무시):', e.message); }
 
  const seenId = {};
  finals = finals.filter(g => { if (seenId[g.id]) return false; seenId[g.id] = 1; return true; });
  const perTeam = {};
  TEAMS10.forEach(t => perTeam[t] = []);
  finals.forEach(g => {
    if (perTeam[g.home]) perTeam[g.home].push({ date: g.date, seq: g.seq, r: wltToForm(g.hw) });
    if (perTeam[g.away]) perTeam[g.away].push({ date: g.date, seq: g.seq, r: wltToForm(g.aw) });
  });
  teams.forEach(t => {
    const arr = (perTeam[t.name] || []).sort((x, y) => x.date === y.date ? x.seq - y.seq : x.date.localeCompare(y.date));
    if (arr.length) t.form = arr.slice(-5).map(e => e.r);
    else { const p = prevMap[t.name]; t.form = (p && Array.isArray(p.form)) ? p.form.slice(-5) : []; }
  });
  console.log('최근전적 계산: 끝난경기', finals.length, '개');
 
  const data = {
    updated: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    teams,
    games
  };
  fs.writeFileSync('standings.json', JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
})();
