# -*- coding: utf-8 -*-
"""
standings.json을 읽어 KBO 일일 글을 만들어 블로거에 자동 발행한다.
필요한 환경변수(깃허브 시크릿):
  BLOGGER_CLIENT_ID, BLOGGER_CLIENT_SECRET, BLOGGER_REFRESH_TOKEN, BLOGGER_BLOG_ID
"""
import os, json, datetime, sys

# ---------- 데이터 로드 ----------
def load_data(path="standings.json"):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def kst_today():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=9)

# ---------- 계산 헬퍼 ----------
def pct(t):
    g = t["w"] + t["l"]
    return t["w"] / g if g else 0.0

def games_behind(a, b):
    return ((a["w"] - b["w"]) + (b["l"] - a["l"])) / 2.0

def recent_win_rate(t):
    f = t.get("form", []) or []
    wins = sum(1 for x in f if x == "W")
    return wins / len(f) if f else 0.0

def strength(t):
    return pct(t) * 0.7 + recent_win_rate(t) * 0.3

def home_win_prob(home, away):
    sa, sb = strength(home), strength(away)
    if sa + sb == 0:
        return 50
    raw = 50 + ((sa / (sa + sb)) * 100 - 50) * 1.8
    return max(15, min(85, round(raw)))

FORM_KO = {"W": "승", "L": "패", "D": "무", "T": "무"}
def form_html(f):
    color = {"W": "#1a7f37", "L": "#cf222e", "D": "#8b949e", "T": "#8b949e"}
    spans = []
    for x in (f or []):
        spans.append(
            f'<span style="display:inline-block;width:22px;height:22px;line-height:22px;'
            f'text-align:center;border-radius:5px;color:#fff;font-size:12px;font-weight:700;'
            f'margin:0 1px;background:{color.get(x,"#8b949e")}">{FORM_KO.get(x,x)}</span>'
        )
    return "".join(spans)

# ---------- 글 만들기 ----------
def build_post(data):
    d = kst_today()
    M, D = d.month, d.day
    teams = sorted(data["teams"], key=lambda t: (-pct(t), -t["w"]))
    games = data.get("games", []) or []

    leader = teams[0]
    second = teams[1] if len(teams) > 1 else None
    gb = games_behind(leader, second) if second else 0

    hot = max(teams, key=lambda t: (recent_win_rate(t), pct(t)))
    cold = min(teams, key=lambda t: (recent_win_rate(t), pct(t)))

    title = f"[{M}월 {D}일] KBO 프로야구 순위 · 오늘 경기 일정 & AI 승부예측"

    H = []
    H.append('<div style="font-size:16px;line-height:1.8;color:#24292f;">')

    # 상단 배너 이미지 (블로거가 이걸 썸네일로 사용)
    H.append(
        '<p style="text-align:center;margin-bottom:20px;">'
        '<img src="https://i.ibb.co/GfPD89NQ/kbo-thumb-v2.png" '
        'alt="KBO 순위 오늘 경기 AI 승부예측" '
        'style="max-width:100%;height:auto;border-radius:10px;"/></p>'
    )

    # 인트로
    gb_txt = "단독 선두" if gb == 0 else f"2위 {second['name']}에 {gb:.1f}경기 차로 앞선 선두"
    intro = (
        f"<p>{M}월 {D}일 현재 KBO 리그 순위와 오늘 열리는 경기 일정을 한눈에 정리했습니다. "
        f"현재 <b>{leader['name']}</b>가 {leader['w']}승 {leader['l']}패(승률 {pct(leader):.3f})로 {gb_txt} 자리를 지키고 있습니다. "
    )
    if games:
        intro += f"오늘은 총 <b>{len(games)}경기</b>가 펼쳐집니다.</p>"
    else:
        intro += "오늘은 예정된 경기가 없는 휴식일입니다.</p>"
    H.append(intro)

    # 오늘의 경기 + AI 예측
    if games:
        H.append(f'<h2 style="margin-top:28px;">⚾ {M}월 {D}일 오늘의 경기 일정</h2>')
        tmap = {t["name"]: t for t in teams}
        H.append('<table style="width:100%;border-collapse:collapse;font-size:15px;">')
        H.append('<thead><tr style="background:#f6f8fa;">'
                 '<th style="padding:10px;border:1px solid #d0d7de;">시간</th>'
                 '<th style="padding:10px;border:1px solid #d0d7de;">맞대결</th>'
                 '<th style="padding:10px;border:1px solid #d0d7de;">구장</th>'
                 '<th style="padding:10px;border:1px solid #d0d7de;">AI 승부예측</th></tr></thead><tbody>')
        for g in games:
            home = tmap.get(g["home"]); away = tmap.get(g["away"])
            if home and away:
                p = home_win_prob(home, away)
                pred = f'{g["home"]} {p}% vs {g["away"]} {100-p}%'
            else:
                pred = "-"
            stadium = g.get("stadium") or "-"
            H.append('<tr>'
                     f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{g.get("time","-")}</td>'
                     f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;"><b>{g["away"]}</b> (원정) vs <b>{g["home"]}</b> (홈)</td>'
                     f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{stadium}</td>'
                     f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{pred}</td></tr>')
        H.append('</tbody></table>')
        H.append('<p style="font-size:13px;color:#8b949e;">※ AI 승부예측은 팀 승률과 최근 5경기 흐름을 바탕으로 한 참고용 수치이며, 실제 결과와 다를 수 있습니다.</p>')

    # 현재 순위표
    H.append('<h2 style="margin-top:28px;">📊 KBO 실시간 순위표</h2>')
    H.append('<table style="width:100%;border-collapse:collapse;font-size:15px;">')
    H.append('<thead><tr style="background:#f6f8fa;">'
             '<th style="padding:10px;border:1px solid #d0d7de;">순위</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">팀</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">승</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">패</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">무</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">승률</th>'
             '<th style="padding:10px;border:1px solid #d0d7de;">최근 5경기</th></tr></thead><tbody>')
    for i, t in enumerate(teams, 1):
        bg = "#fffbe6" if i == 1 else "#fff"
        H.append('<tr>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;background:{bg};font-weight:700;">{i}</td>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;font-weight:700;">{t["name"]}</td>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{t["w"]}</td>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{t["l"]}</td>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{t.get("d",0)}</td>'
                 f'<td style="padding:10px;border:1px solid #d0d7de;text-align:center;">{pct(t):.3f}</td>'
                 f'<td style="padding:8px;border:1px solid #d0d7de;text-align:center;">{form_html(t.get("form"))}</td></tr>')
    H.append('</tbody></table>')

    # 최근 흐름 분석
    H.append('<h2 style="margin-top:28px;">🔥 최근 흐름 분석</h2>')
    hw = sum(1 for x in hot.get("form", []) if x == "W")
    cw = sum(1 for x in cold.get("form", []) if x == "W")
    H.append(
        f"<p>최근 5경기 기준 가장 상승세인 팀은 <b>{hot['name']}</b>입니다(최근 5경기 {hw}승). "
        f"반대로 <b>{cold['name']}</b>는 최근 흐름이 가장 좋지 않아(최근 5경기 {cw}승) 반등이 필요한 상황입니다. "
        f"순위 싸움이 치열한 만큼, 오늘 경기 결과에 따라 판도가 바뀔 수 있습니다.</p>"
    )

    # 마무리
    H.append('<h2 style="margin-top:28px;">📱 실시간 순위·중계 한 곳에서 보기</h2>')
    H.append(
        '<p>실시간으로 갱신되는 KBO 순위와 오늘 경기 일정, 내 팀 AI 승부예측은 아래에서 한 번에 확인할 수 있습니다.</p>'
        '<p style="text-align:center;margin:20px 0;">'
        '<a href="https://kbo.hibestmoney.com" target="_blank" '
        'style="display:inline-block;background:#ff3b30;color:#fff;font-weight:700;font-size:17px;'
        'padding:14px 28px;border-radius:10px;text-decoration:none;">⚾ KBO 실시간 순위·중계 보러가기 →</a></p>'
    )
    H.append('<p style="font-size:13px;color:#8b949e;">본 콘텐츠는 정보 제공을 목적으로 하며, 순위·일정 데이터는 매일 갱신됩니다.</p>')
    H.append('</div>')

    return title, "".join(H)

# ---------- 블로거 발행 ----------
def publish(title, content):
    import requests
    cid = os.environ["BLOGGER_CLIENT_ID"]
    csec = os.environ["BLOGGER_CLIENT_SECRET"]
    rtok = os.environ["BLOGGER_REFRESH_TOKEN"]
    blog = os.environ["BLOGGER_BLOG_ID"]

    # 1) access token 갱신
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": cid, "client_secret": csec,
        "refresh_token": rtok, "grant_type": "refresh_token",
    })
    r.raise_for_status()
    access = r.json()["access_token"]

    # 2) 글 발행
    url = f"https://www.googleapis.com/blogger/v3/blogs/{blog}/posts/"
    body = {"kind": "blogger#post", "blog": {"id": blog},
            "title": title, "content": content,
            "labels": ["KBO", "프로야구", "야구", "프로야구순위"]}
    r = requests.post(url, headers={"Authorization": f"Bearer {access}"}, json=body)
    r.raise_for_status()
    print("발행 완료:", r.json().get("url"))

if __name__ == "__main__":
    data = load_data()
    title, content = build_post(data)
    if "--dry" in sys.argv:
        with open("sample.html", "w", encoding="utf-8") as f:
            f.write(f"<h1>{title}</h1>\n{content}")
        print("제목:", title)
        print("샘플 저장: sample.html")
    else:
        publish(title, content)
