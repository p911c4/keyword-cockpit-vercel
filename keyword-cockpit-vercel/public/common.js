/* ═══════════════════════════════
   KEYWORD COCKPIT v1.7 — 공통 스크립트
   (시계 · 콘솔 · 블로그 설정 모달 · 입력창 X버튼 · 방문 로깅)
═══════════════════════════════ */

/* ── 시계 ── */
setInterval(() => {
  const t = new Date();
  const el = document.getElementById('clock');
  if (el) el.textContent =
    t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
}, 1000);

/* ── 하단 콘솔 ── */
function log(type, msg) {
  const dot = document.getElementById('cdot');
  const txt = document.getElementById('ctxt');
  if (dot) dot.className = 'cdot' + (type ? ' '+type : '');
  if (txt) txt.textContent = msg;
}

/* ═══════════════════════════════
   블로그 설정 (localStorage)
═══════════════════════════════ */
const BLOG_SETTING_KEY = 'kc_my_blog_id';

function getMyBlogId() {
  return localStorage.getItem(BLOG_SETTING_KEY) || 'p911c4';
}

function openSettings() {
  const saved = localStorage.getItem(BLOG_SETTING_KEY) || '';
  const inp   = document.getElementById('settingsBlogId');
  const cur   = document.getElementById('modalCurrentId');
  const savedMsg = document.getElementById('modalSaved');
  if (inp) inp.value = saved;
  if (cur) cur.textContent = saved ? saved : '미설정 (기본값 사용)';
  if (savedMsg) savedMsg.classList.remove('show');
  document.getElementById('settingsModal').classList.add('show');
  setTimeout(() => inp?.focus(), 100);
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('show');
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
  if (savedMsg) { savedMsg.classList.add('show'); setTimeout(() => savedMsg.classList.remove('show'), 1500); }
  log('ok', `블로그 ID "${val}" 저장 완료`);
  setTimeout(() => { closeSettings(); window.onBlogSettingChanged?.(); }, 1000);
}

function resetBlogSetting() {
  localStorage.removeItem(BLOG_SETTING_KEY);
  const inp = document.getElementById('settingsBlogId');
  const cur = document.getElementById('modalCurrentId');
  if (inp) inp.value = '';
  if (cur) cur.textContent = '미설정 (기본값 사용)';
  log('ok', '블로그 설정이 초기화되었습니다');
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
