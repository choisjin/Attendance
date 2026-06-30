// 팀 근태 관리 서버
//   - 웹 페이지(attendance-app.html) 서빙
//   - 모든 사용자 데이터(att2:data)를 서버 파일(data.json)에 공유 저장 (재시작해도 유지)
//   - 그룹웨어 근태 싱크 프록시
//
//   실행: cd backend && npm install && npm start
//   기본 포트: 3939 (환경변수 PORT로 변경)  ·  접속: http://<노트북 IP>:<포트>/
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const { fetchAttendance } = require('./groupware');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // 전체 데이터 저장이라 넉넉히

const PORT = process.env.PORT || 3939;
const ROOT = path.join(__dirname, '..');                 // 프로젝트 루트(attendance-app.html 위치)
const HTML = path.join(ROOT, 'attendance-app.html');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ── 공유 데이터 저장소 (단일 JSON 파일) ──
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return null; }
}
function writeData(obj) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, DATA_FILE); // 원자적 교체로 손상 방지
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'attendance-server' }));

// 앱 데이터: 모든 사용자가 공유하는 단일 상태
app.get('/api/data', (req, res) => {
  const d = readData();
  res.json({ ok: true, data: d, rev: d && d._rev ? d._rev : 0 });
});
app.put('/api/data', (req, res) => {
  const d = req.body && req.body.data;
  if (d == null || typeof d !== 'object') return res.status(400).json({ ok: false, error: 'no data' });
  d._rev = Date.now(); // 서버가 리비전 부여
  try { writeData(d); } catch (e) {
    console.error('[data] write error:', e && e.message);
    return res.status(500).json({ ok: false, error: 'save failed' });
  }
  res.json({ ok: true, rev: d._rev });
});

// 그룹웨어 근태 싱크 (헤드리스 로그인 후 근태 수집)
app.post('/api/groupware/attendance', async (req, res) => {
  const { id, pw } = req.body || {};
  const months = req.body && (req.body.months || (req.body.month ? [req.body.month] : null));
  try {
    const out = await fetchAttendance(puppeteer, { id, pw, months });
    res.json(out);
  } catch (e) {
    console.error('[attendance] error:', e && e.message);
    res.status(e && e.code === 'LOGIN_FAILED' ? 401 : 400).json({
      ok: false,
      code: (e && e.code) || 'ERROR',
      error: (e && e.message) || '알 수 없는 오류',
    });
  }
});

// 웹 페이지 (HTML만 노출 — 디렉터리/엑셀 등 다른 파일은 서빙하지 않음)
app.get(['/', '/attendance-app.html'], (req, res) => res.sendFile(HTML));

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => (ifs[name] || []).forEach((i) => {
    if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }));
  return out;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('───────────────────────────────────────────────');
  console.log(' 팀 근태 관리 서버 실행 중');
  console.log('  · 이 노트북:   http://localhost:' + PORT + '/');
  lanIPs().forEach((ip) => console.log('  · 팀원 접속용: http://' + ip + ':' + PORT + '/'));
  console.log('  · 데이터 파일: ' + DATA_FILE);
  console.log('───────────────────────────────────────────────');
  console.log(' 팀원이 접속하려면 Windows 방화벽에서 이 포트(' + PORT + ') 인바운드 허용이 필요할 수 있습니다.');
});
