/* ═══════════════════════════════
   KEYWORD COCKPIT v2.0 — 공통 스크립트
   (토스트 · 블로그 설정 모달 · 입력창 X버튼 · CSV 유틸 · 방문 로깅 · 구글 플래그)
═══════════════════════════════ */

/* ── 토스트 알림 (기존 log() 인터페이스 승계) ── */
let _toastTimer = null;
function toast(msg, ms) {
  let el = document.getElementById('kcToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kcToast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
}
function log(type, msg) {
  // busy 상태는 화면 내 배지/스켈레톤으로 표시되므로 토스트 생략
  if (type === 'ok')   toast('✅ ' + msg);
  if (type === 'fail') toast('⚠️ ' + msg, 3200);
}

/* ═══ 블로그 설정 (localStorage) ═══ */
const BLOG_SETTING_KEY = 'kc_my_blog_id';

function getMyBlogId() {
  // 기본값 없음 — 사용자가 설정하지 않았으면 빈 문자열 (하드코딩 제거)
  return (localStorage.getItem(BLOG_SETTING_KEY) || '').trim();
}

/* 설정 모달 마크업은 정적 HTML에 두지 않고 여기서 생성한다.
   (UI 문구가 페이지 소스에 남지 않게 하여 크롤러가 본문으로 수집하지 않도록 함) */
function ensureSettingsModal() {
  if (document.getElementById('settingsModal')) return;
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.id = 'settingsModal';
  wrap.addEventListener('click', e => { if (e.target === wrap) closeSettings(); });
  wrap.innerHTML = [
    '<div class="modal">',
      '<div class="modal-header">',
        '<div class="modal-title">⚙️ 블로그 설정</div>',
        '<button class="modal-close" onclick="closeSettings()">×</button>',
      '</div>',
      '<div class="modal-body">',
        '<div class="modal-label">📌 내 블로그 ID</div>',
        '<div class="modal-desc">상위 10 차트에서 <strong>내 블로그를 강조</strong>하고, 검색 키워드 관련 <strong>내 포스팅</strong>을 자동으로 찾아 보여줍니다.</div>',
        '<div class="modal-current">현재 설정: <strong id="modalCurrentId">미설정</strong></div>',
        '<div class="modal-input-row">',
          '<span class="modal-prefix">blog.naver.com/</span>',
          '<input type="text" id="settingsBlogId" placeholder="블로그 ID 입력 (예: p911c4)" autocomplete="off" />',
        '</div>',
        '<div class="modal-saved" id="modalSaved">✅ 저장되었습니다!</div>',
      '</div>',
      '<div class="modal-footer">',
        '<button class="btn btn-outline btn-sm" onclick="resetBlogSetting()">초기화</button>',
        '<button class="btn btn-primary btn-sm" onclick="saveBlogSetting()">저장</button>',
      '</div>',
    '</div>'
  ].join('');
  document.body.appendChild(wrap);
  wrap.querySelector('#settingsBlogId')
      .addEventListener('keydown', e => { if (e.key === 'Enter') saveBlogSetting(); });
}

function openSettings() {
  ensureSettingsModal();
  const saved = localStorage.getItem(BLOG_SETTING_KEY) || '';
  const inp   = document.getElementById('settingsBlogId');
  const cur   = document.getElementById('modalCurrentId');
  const savedMsg = document.getElementById('modalSaved');
  if (inp) inp.value = saved;
  if (cur) cur.textContent = saved ? saved : '미설정';
  if (savedMsg) savedMsg.classList.remove('show');
  document.getElementById('settingsModal').classList.add('show');
  setTimeout(() => inp?.focus(), 100);
}

function closeSettings() {
  document.getElementById('settingsModal')?.classList.remove('show');
}

function saveBlogSetting() {
  const inp = document.getElementById('settingsBlogId');
  const val = (inp?.value || '').trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
  if (!val) {
    resetBlogSetting();
    closeSettings();
    window.onBlogSettingChanged?.();
    return;
  }
  localStorage.setItem(BLOG_SETTING_KEY, val);
  const cur = document.getElementById('modalCurrentId');
  if (cur) cur.textContent = val;
  const savedMsg = document.getElementById('modalSaved');
  if (savedMsg) { savedMsg.classList.add('show'); }
  setTimeout(() => { closeSettings(); window.onBlogSettingChanged?.(); }, 800);
  toast(`✅ 블로그 ID "${val}" 저장 완료`);
}

function resetBlogSetting() {
  localStorage.removeItem(BLOG_SETTING_KEY);
  const inp = document.getElementById('settingsBlogId');
  const cur = document.getElementById('modalCurrentId');
  if (inp) inp.value = '';
  if (cur) cur.textContent = '미설정';
  toast('블로그 설정이 초기화되었습니다');
  // 저장과 동일하게 현재 페이지 표시도 즉시 갱신 (모달은 열어둠)
  window.onBlogSettingChanged?.();
}

/* ── 브랜드 클릭: 홈에서는 초기화, 그 외 페이지에서는 홈으로 이동 ── */
function resetApp() {
  const onHome = location.pathname === '/' || location.pathname === '/index.html';
  if (onHome && typeof window.pageReset === 'function') {
    window.pageReset();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    location.href = '/';
  }
}

/* ── 입력창 X 버튼 ── */
function toggleClear(inputId, btnId) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!inp || !btn) return;
  btn.classList.toggle('show', inp.value.length > 0);
}
function clearInput(inputId, btnId) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!inp || !btn) return;
  inp.value = '';
  btn.classList.remove('show');
  inp.focus();
}

/* ═══ CSV 유틸 (공통 사양: UTF-8 BOM, 파일명 규칙, 토스트) ═══ */
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCSV(kind, header, rows) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const filename = `keyword-cockpit_${kind}_${ymd}.csv`;
  const lines = [header, ...rows].map(r => r.map(csvEscape).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`📥 ${filename} 다운로드 완료`);
}

/* ── 숫자 포맷 ── */
function fmtNum(n) {
  return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('ko-KR') : '-';
}

/* ═══ 구간(range) 표기 유틸 ═══
   구글 검색량은 구간으로만 표시한다는 원칙은 그대로 두되,
   표기 형식을 네이버와 맞춘다 — "1천 ~ 1만"은 62,700 옆에서 자릿수가 안 잡힌다.
   "1,000 ~ 10,000"으로 쓰면 같은 눈금으로 읽힌다.
   구간 중앙값을 화면에 숫자로 찍지는 않는다(정밀 측정치처럼 보이므로). */

/* "1천" · "1만" · "1,000" → 정수. 구버전 스냅샷 라벨을 되읽기 위한 파서. */
function parseKoNum(s) {
  const t = String(s == null ? '' : s).trim().replace(/,/g, '');
  const m = t.match(/^([\d.]+)\s*(억|만|천)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = { '억': 1e8, '만': 1e4, '천': 1e3 }[m[2]] || 1;
  return Math.round(n * unit);
}
function parseRangeLabel(label) {
  const p = String(label == null ? '' : label).split('~');
  if (p.length !== 2) return null;
  const a = parseKoNum(p[0]), b = parseKoNum(p[1]);
  return (a != null && b != null) ? { min: a, max: b } : null;
}
function fmtRange(min, max) {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${fmtNum(min)} ~ ${fmtNum(max)}`;
  return max != null ? `~ ${fmtNum(max)}` : `${fmtNum(min)} ~`;
}
/* volume 객체({min,max,label}) → 표기 문자열. min·max가 없으면 라벨을 되읽고,
   그것도 실패하면 서버 라벨을 그대로 쓴다(표기만 못 맞출 뿐 값은 정확하다). */
function volRange(v) {
  if (!v) return null;
  const r = (v.min != null || v.max != null)
    ? { min: v.min, max: v.max }
    : parseRangeLabel(v.label);
  return r ? fmtRange(r.min, r.max) : (v.label || null);
}
/* 구간의 기하 중앙값. 키워드 플래너 구간은 로그 스케일(10–100 / 100–1K / 1K–10K)이라
   산술 평균(5,500)은 구간 중심이 아니다. 화면에 숫자로 찍지 않고 막대 폭에만 쓴다. */
function geoMid(min, max) {
  if (min == null || max == null) return null;
  const a = Math.max(min, 1), b = Math.max(max, a);
  const g = Math.sqrt(a * b);
  return isFinite(g) ? g : null;
}

/* ═══ 구글 검색량 feature flag ═══
   /api/google-keyword?ping=1 → { enabled: true|false }
   비활성(기본) 상태에선 소스 토글의 구글/통합 버튼이 "준비 중"으로 표시됨 */
window.GOOGLE_ENABLED = false;
async function checkGoogleFlag() {
  try {
    const res  = await fetch('/api/google-keyword?ping=1');
    const json = await res.json();
    window.GOOGLE_ENABLED = !!json.enabled;
  } catch (e) {
    window.GOOGLE_ENABLED = false;
  }
  window.onGoogleFlagReady?.(window.GOOGLE_ENABLED);
}

/* ── 통계 로깅 ── */
function logPageView() {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'pageview' })
  }).catch(() => {});
}
function logSearch(keyword) {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'search', keyword })
  }).catch(() => {});
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', logPageView);
} else {
  logPageView();
}
