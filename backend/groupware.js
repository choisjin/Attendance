// ──────────────────────────────────────────────────────────────────────────
// 그룹웨어(nhr) 근태 수집 + 지각/초과근무 계산 로직
//  - 로그인 흐름과 근태 JSON API는 실제 사이트 탐색으로 확인한 값:
//      로그인:  https://gw.linkgenesis.co.kr/ngw/app/#/sign
//        · 아이디  #log-userid
//        · 비밀번호 iframe(#iframeLoginPassword) 내부 #p
//        · 로그인  #btn-log
//      근태:    GET /nhr/api/timecard/user/schedule/calendar?day=YYYY-MM (세션 쿠키 필요)
//        · data[일자].events[] 중
//            type=process  "출근|지각|퇴근|조퇴 HH:MM"   ← 실제 출퇴근 기록
//            type=schedule "13:30 (+4) - 고정출퇴근제"   ← 반차가 반영된 기준 출근시각
//            type=vacation "연차휴가(개정) - 오전 반차"  ← 이벤트(반차/연차)
//            type=setting  "휴무|휴일|공휴일"            ← 비근무일
// ──────────────────────────────────────────────────────────────────────────

const LOGIN_URL = 'https://gw.linkgenesis.co.kr/ngw/app/#/sign';
const ORIGIN = 'https://gw.linkgenesis.co.kr';
const CAL_API = '/nhr/api/timecard/user/schedule/calendar?day='; // + YYYY-MM

// 표준 근무 기준 (사용자 확정 규칙)
const STD_START = '08:30';
const STD_END = '17:30';
const AM_HALF_START = '13:30'; // 오전 반차 → 오후 출근 기준
const PM_HALF_END = '12:30';   // 오후 반차 → 오전 퇴근 기준

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMin = (t) => {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (s) => {
  const m = String(s || '').match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
};
// "9시간 32분" / "40분" / "0시간" → 분
const labelToMin = (s) => {
  if (!s) return 0;
  s = String(s);
  let total = 0;
  const h = s.match(/(\d+)\s*시간/);
  const m = s.match(/(\d+)\s*분/);
  if (h) total += parseInt(h[1], 10) * 60;
  if (m) total += parseInt(m[1], 10);
  return total;
};

// 하루치 events(+status/day analysis) → 정규화된 근태 레코드
//   지각: 출퇴근 기록으로 계산
//   초과근무: 그룹웨어가 인정한 "연장근무/야간근무"가 있을 때만 인정.
//            (퇴근시각이 17:30 이후라도 연장/야간근무 값이 없으면 추가근무 아님)
function parseDay(date, events, analysis) {
  events = events || [];
  const titleOf = (e) => (e && e.title) || '';

  // 비근무일(휴일/휴무/공휴일)
  const holidayEv = events.find(
    (e) => e.type === 'setting' && /(휴일|휴무|공휴일)/.test(titleOf(e))
  );

  // 이벤트(반차/연차/외출/출장 등)
  const vacationEv = events.find((e) => e.type === 'vacation');
  const eventTitle = vacationEv ? titleOf(vacationEv).replace(/\s+/g, ' ').trim() : '';
  const isAmHalf = /오전\s*반차/.test(eventTitle);
  const isPmHalf = /오후\s*반차/.test(eventTitle);

  // 링크데이(회사 행사) 여부: 그날 이벤트 객체 전체(title/content/사유/메모 등 모든 필드)에서
  //   "링크데이" 문구가 발견되면 true. (조퇴 사유가 title이 아닌 다른 필드에 들어올 수 있어 전체 스캔)
  const isLinkDay = /링크\s*데이/.test(JSON.stringify(events || []));

  // 기준 출근시각: schedule 이벤트("13:30 (+4) ...")가 가장 정확(반차 반영).
  const schedEv = events.find(
    (e) => e.type === 'schedule' && /^\d{1,2}:\d{2}\s*\(\+\d+\)/.test(titleOf(e))
  );
  let schedStart = (schedEv && hhmm(titleOf(schedEv))) || STD_START;
  if (isAmHalf) schedStart = AM_HALF_START; // 안전망
  // 기준 퇴근시각
  let schedEnd = STD_END;
  if (isPmHalf) schedEnd = PM_HALF_END;

  // 실제 출퇴근 기록
  const inEv = events.find(
    (e) => e.type === 'process' && /^(출근|지각)/.test(titleOf(e))
  );
  const outEv = events.find(
    (e) => e.type === 'process' && /^(퇴근|조퇴)/.test(titleOf(e))
  );
  const checkIn = inEv ? hhmm(titleOf(inEv)) : null;
  const checkOut = outEv ? hhmm(titleOf(outEv)) : null;
  const gwLate = !!inEv && /^지각/.test(titleOf(inEv));   // 그룹웨어가 직접 지각으로 표기
  const gwEarly = !!outEv && /^조퇴/.test(titleOf(outEv)); // 그룹웨어가 직접 조퇴로 표기

  // 지각: 출근시각이 기준 출근보다 늦으면 그 차이
  let lateMinutes = 0;
  if (!holidayEv && checkIn != null) {
    const a = toMin(checkIn), s = toMin(schedStart);
    if (a != null && s != null) lateMinutes = Math.max(0, a - s);
  }

  // 조퇴: 그룹웨어가 "조퇴"로 표기한 날의 조기퇴근 분 (기준 퇴근 - 실제 퇴근)
  //   (오후 반차로 일찍 퇴근하는 날은 "퇴근"으로 찍혀 gwEarly=false → 조퇴 아님)
  let earlyMinutes = 0;
  if (!holidayEv && gwEarly && checkOut != null) {
    const b = toMin(checkOut), e = toMin(schedEnd);
    if (b != null && e != null) earlyMinutes = Math.max(0, e - b);
  }

  // 초과근무: 그룹웨어 status/day의 연장근무/야간근무(라벨)로만 인정.
  //   + 실제 퇴근 펀치(out.time == out.real_time)일 때만 인정.
  //     (관리자가 보정해 넣은 가짜 퇴근은 time≠real_time → 소액 연장근무가 떠도 제외)
  const overLabel = analysis ? (analysis.over_time_label || '') : '';
  const nightLabel = analysis ? (analysis.night_work_label || '') : '';
  const overMin = labelToMin(overLabel);
  const nightMin = labelToMin(nightLabel);
  const realPunch = !!(analysis && analysis.out_time && analysis.out_real && analysis.out_time === analysis.out_real);
  let overtimeMinutes = 0;
  if (!holidayEv && realPunch) overtimeMinutes = overMin > 0 ? overMin : (nightMin > 0 ? nightMin : 0);

  return {
    date,
    weekday: '일월화수목금토'[new Date(date + 'T00:00:00').getDay()],
    isHoliday: !!holidayEv,
    holidayLabel: holidayEv ? titleOf(holidayEv) : '',
    event: eventTitle,            // 반차/연차 등 이벤트명
    linkDay: isLinkDay,           // 링크데이(회사 행사) 조퇴 여부
    halfDay: isAmHalf ? 'am' : isPmHalf ? 'pm' : '',
    schedStart,
    schedEnd,
    checkIn,
    checkOut,
    gwLate,
    gwEarly,
    lateMinutes,
    earlyMinutes,
    overtimeMinutes,
    overLabel,    // 그룹웨어 연장근무 라벨 (참고/표시용)
    nightLabel,   // 그룹웨어 야간근무 라벨
    realPunch,    // 실제 퇴근 펀치 여부 (관리자 보정이면 false)
  };
}

function parseMonth(json, analysisByDate) {
  analysisByDate = analysisByDate || {};
  const raw = json && json.data ? json.data : [];
  const days = raw.map((d) => parseDay(d.date, d.events, analysisByDate[d.date]));
  // [임시 진단] 새 코드가 도는지 + 퇴근/조퇴 기록을 날짜별로 모두 출력
  console.log(`[링크데이 진단] parseMonth 진입 — ${raw.length}일 처리 (새 코드 적용됨)`);
  days.forEach((rec, i) => {
    const evs = raw[i].events || [];
    const out = evs.find((e) => e.type === 'process' && /^(퇴근|조퇴)/.test(e.title || ''));
    // 퇴근/조퇴 기록이 있는 날만, 또는 조퇴로 계산된 날만 출력
    if (out || rec.earlyMinutes > 0) {
      console.log(`[링크데이 진단] ${rec.date} out="${out ? out.title : '-'}" `
        + `earlyMin=${rec.earlyMinutes} linkDay=${rec.linkDay} events=` + JSON.stringify(evs));
    }
  });
  return days;
}

// ── Puppeteer 로그인 → 월별 근태 JSON 수집 ──
async function fetchAttendance(puppeteer, { id, pw, months }) {
  if (!id || !pw) throw Object.assign(new Error('그룹웨어 ID/PW가 필요합니다.'), { code: 'NO_CRED' });
  const monthList = (Array.isArray(months) ? months : [months]).filter(Boolean);
  if (monthList.length === 0) throw Object.assign(new Error('조회할 월(months)이 필요합니다.'), { code: 'NO_MONTH' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    // 아이디
    await page.waitForSelector('#log-userid', { timeout: 20000 });
    await page.click('#log-userid');
    await page.type('#log-userid', id, { delay: 25 });

    // 비밀번호 (보안 iframe 내부 #p)
    await page.waitForSelector('#iframeLoginPassword', { timeout: 20000 });
    const frameHandle = await page.$('#iframeLoginPassword');
    const frame = await frameHandle.contentFrame();
    await frame.waitForSelector('#p', { timeout: 20000 });
    await frame.click('#p');
    await frame.type('#p', pw, { delay: 25 });

    // 로그인
    await page.click('#btn-log');

    // 세션이 설정될 때까지 근태 API를 폴링(성공 시 로그인 완료로 간주)
    const firstMonth = monthList[0];
    let loggedIn = false;
    let lastHttp = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(700);
      const res = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return { http: r.status };
          const ct = r.headers.get('content-type') || '';
          if (!/json/.test(ct)) return { http: -1 }; // 로그인 페이지 HTML 등
          const j = await r.json();
          return { ok: true, j };
        } catch (e) {
          return { err: String(e) };
        }
      }, ORIGIN + CAL_API + firstMonth);
      if (res && res.ok && res.j && res.j.data) {
        loggedIn = true;
        break;
      }
      if (res && res.http) lastHttp = res.http;
    }
    if (!loggedIn) {
      throw Object.assign(
        new Error('그룹웨어 로그인에 실패했습니다. ID/PW를 확인해 주세요. (last http=' + lastHttp + ')'),
        { code: 'LOGIN_FAILED' }
      );
    }

    // 사용자 이름(베스트 에포트)
    let name = '';
    try {
      name = await page.evaluate(() => {
        const t = document.title || '';
        return '';
      });
    } catch (e) {}

    // 각 월 수집: 달력(출퇴근/지각) + 퇴근 17:30 이후인 날만 status/day로 연장근무 확인
    const result = {};
    for (const m of monthList) {
      const collected = await page.evaluate(async (args) => {
        const { base, month } = args;
        const calR = await fetch(base + '/nhr/api/timecard/user/schedule/calendar?day=' + month, { credentials: 'include' });
        if (!calR.ok) return null;
        const cal = await calR.json();
        const days = (cal && cal.data) || [];
        // 후보일: 퇴근/조퇴 기록이 17:30(1050분) 이후인 날 → 연장근무 가능성
        const cand = [];
        days.forEach((d) => {
          const out = (d.events || []).find((e) => e.type === 'process' && /^(퇴근|조퇴)/.test(e.title || ''));
          if (out) {
            const mm = (out.title || '').match(/(\d{1,2}):(\d{2})/);
            if (mm) { const min = (+mm[1]) * 60 + (+mm[2]); if (min > 1050) cand.push(d.date); }
          }
        });
        const analysisByDate = {};
        await Promise.all(cand.map(async (date) => {
          try {
            const r = await fetch(base + '/nhr/api/timecard/user/status/day?day=' + date, { credentials: 'include' });
            const j = await r.json();
            const a = j && j.data && j.data.analysis;
            const o = j && j.data && j.data.punch && j.data.punch.out;
            analysisByDate[date] = a ? {
              over_time_label: a.over_time_label,
              night_work_label: a.night_work_label,
              out_time: o && o.time,
              out_real: o && o.real_time,
            } : null;
          } catch (e) { analysisByDate[date] = null; }
        }));
        return { cal, analysisByDate };
      }, { base: ORIGIN, month: m });
      result[m] = collected && collected.cal ? parseMonth(collected.cal, collected.analysisByDate || {}) : [];
    }

    return { ok: true, name, months: result };
  } finally {
    await browser.close();
  }
}

module.exports = { fetchAttendance, parseMonth, parseDay };
