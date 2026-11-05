// หน้าจัดการ — สิทธิ์จริงอยู่ที่ RLS และฟังก์ชันในฐานข้อมูล หน้านี้แค่ซ่อนเมนูที่ไม่เกี่ยวข้อง
const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(window.TR_CONFIG.url, window.TR_CONFIG.key);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '-');
const STATUS = { new: 'ใหม่', in_progress: 'กำลังดำเนินการ', closed: 'ปิดเรื่อง' };
const AUDIT = { reveal_national_id: 'เปิดดูเลขบัตร', move_complaint: 'ย้ายอู่', set_status: 'เปลี่ยนสถานะ', edit_complaint: 'แก้ไขเรื่อง', set_note: 'บันทึกหมายเหตุ', delete_complaint: 'ลบเรื่อง', create_user: 'สร้างผู้ใช้', set_password: 'ตั้งรหัสผ่าน', enable_user: 'เปิดบัญชี', disable_user: 'ปิดบัญชี' };
// ตรงกับ private.login_email ในฐานข้อมูล: ชื่อรูปแบบเดิมใช้ตรงๆ ชื่ออื่น (ไทย/เว้นวรรค) ใช้ hash
async function toEmail(u) {
  const v = u.trim().toLowerCase().normalize('NFC');
  if (/^[a-z0-9._-]{3,30}$/.test(v)) return v + '@taxi-report.local';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return 'u-' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32) + '@taxi-report.local';
}

const PAGE_SIZE = 10;
const S = { me: null, isAdmin: false, tab: 'home', garages: [], complaints: [], users: [], filter: { garage: '', q: '', from: '', to: '', sort: 'desc', page: 1 }, dash: null, redraw: null, viewing: null };

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3000);
}
const errMsg = (e) => (e && e.code === 'P0001' ? e.message : e && e.code === '42501' ? 'ไม่มีสิทธิ์ทำรายการนี้' : 'ทำรายการไม่สำเร็จ กรุณาลองใหม่');
const gName = (id) => S.garages.find((g) => g.id === id)?.name || '-';

// ── วันที่ยึดเวลาไทยเสมอ ──
const bkk = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(d));
const fmtDate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('th-TH', { dateStyle: 'medium' }) : '-');
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const monthLabel = (ym, year) => new Date(ym + '-15T00:00:00').toLocaleDateString('th-TH', year ? { month: 'short', year: '2-digit' } : { month: 'short' });
function presetRange(p) {
  const t = bkk(), ym = t.slice(0, 7);
  if (p === 'last') return [addMonths(ym, -1) + '-01', lastDay(addMonths(ym, -1))];
  if (p === 'y12') return [addMonths(ym, -11) + '-01', t];
  return [ym + '-01', t];
}
// ใช้กรองร่วมกันทั้งหน้าภาพรวมและหน้าเรื่องร้องเรียน
function matchBase(c, f) {
  if (f.garage && c.garage_id !== f.garage) return false;
  if (!f.q) return true;
  const text = [c.ref_no, c.reporter_name, c.reporter_last_name, c.contact_phone, c.driver_name, c.driver_phone, c.driver_line_id, c.plate].join(' ').toLowerCase();
  const digits = /^[\d\s-]+$/.test(f.q) ? f.q.replace(/\D/g, '') : '';
  return text.includes(f.q) || (digits && [c.contact_phone, c.driver_phone].some((v) => (v || '').includes(digits)));
}
const inRange = (c, from, to) => { const d = bkk(c.created_at); return (!from || d >= from) && (!to || d <= to); };
const svg = (d) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  view: svg('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
  del: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
};
const canEdit = (c) => S.isAdmin || c.garage_id === S.me.garage_id;   // ฐานข้อมูลบังคับสิทธิ์ซ้ำอีกชั้น
const filterControls = (f) => `<select id="fGarage" aria-label="อู่"><option value="">ทุกอู่</option>${S.garages.map((g) => `<option value="${g.id}" ${f.garage === g.id ? 'selected' : ''}>${esc(g.name)}${g.code ? ` ( ${esc(g.code)} )` : ''}</option>`).join('')}</select>
  <input id="fQ" placeholder="ค้นหา เลขอ้างอิง ชื่อ นามสกุล เบอร์โทร" value="${esc(f.q)}" aria-label="ค้นหา">`;
const readControls = (f) => { f.garage = $('fGarage').value; f.q = $('fQ').value.trim().toLowerCase(); };
function complaintTable(list, total) {
  return `<p class="muted">${total} เรื่อง</p><div class="scroll"><table class="click"><thead><tr><th>วันที่ (วันรีพอร์ต)</th><th>เลขอ้างอิง</th><th>ชื่อ-นามสกุล</th><th>เบอร์โทร</th><th>วันเกิดเหตุ</th><th>รายละเอียด</th><th>เอกสารแนบ</th><th class="stick">จัดการ</th></tr></thead><tbody>
    ${list.map((c) => { const n = c.complaint_attachments?.length || 0; return `<tr data-open="${c.id}" tabindex="0"><td>${fmt(c.created_at)}</td><td>${esc(c.ref_no)}</td><td>${esc([c.reporter_name, c.reporter_last_name].filter(Boolean).join(' ') || c.driver_name || '-')}</td><td>${esc(c.contact_phone || c.driver_phone || '-')}</td><td>${fmtDate(c.incident_date)}</td><td class="clip" title="${esc(c.detail)}">${esc(c.detail)}</td><td>${n ? n + ' ไฟล์' : '-'}</td><td class="stick"><div class="icons"><button type="button" class="ico view" data-open="${c.id}" title="ดูรายละเอียด" aria-label="ดูรายละเอียด">${ICON.view}</button>${canEdit(c) ? `<button type="button" class="ico edit" data-cedit="${c.id}" title="แก้ไข" aria-label="แก้ไข">${ICON.edit}</button>` : ''}${canEdit(c) ? `<button type="button" class="ico del" data-cdel="${c.id}" title="ลบ" aria-label="ลบ">${ICON.del}</button>` : ''}</div></td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">ไม่พบเรื่อง</td></tr>'}
  </tbody></table></div>`;
}

// ── กราฟ: สีเดียว แท่งบาง เส้นตารางจาง · ไม่ใช้ style ในบรรทัดเพราะ CSP ปิดไว้ ──
// สีประจำอู่ตามลำดับที่สร้าง สีจึงไม่เปลี่ยนเมื่อกรองหรือเรียงใหม่ · เกิน 8 อู่ใช้สีเทา
const GARAGE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER_COLOR = '#8a8986';
function garageColor(id) {
  const i = [...S.garages].sort((a, b) => a.created_at.localeCompare(b.created_at)).findIndex((g) => g.id === id);
  return GARAGE_COLORS[i] || OTHER_COLOR;
}
const niceMax = (v) => { if (v <= 4) return Math.max(v, 1); const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
function monthChart(el, rows, from, to) {
  const W = Math.max(el.clientWidth, 280), H = 220, L = 30, R = 8, T = 22, B = 26;
  const max = niceMax(Math.max(...rows.map((r) => r.n))), y = (v) => T + (H - T - B) * (1 - v / max);
  const step = (W - L - R) / rows.length, bw = Math.min(26, step - 4), every = W < 480 ? 2 : 1, top = Math.max(...rows.map((r) => r.n));
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, max / 2, max];
  const bars = rows.map((r, i) => {
    const x = L + step * i + (step - bw) / 2, yy = y(r.n), h = H - B - yy, on = r.ym >= from.slice(0, 7) && r.ym <= to.slice(0, 7), last = i === rows.length - 1;
    // ซ้อนแท่งตามอู่ เว้น 2px ระหว่างอู่ · มุมโค้งเฉพาะบนสุด · เดือนนอกช่วงที่เลือกจางลง
    let cur = H - B; const unit = r.n ? h / r.n : 0;
    const bar = (r.seg || []).map((g, si, arr) => {
      const sh = g.n * unit, top2 = cur - sh, topMost = si === arr.length - 1, gap = topMost ? 0 : 2, ht = Math.max(1, sh - gap), yTop = top2 + gap, rad = topMost ? Math.min(4, ht, bw / 2) : 0;
      cur = top2;
      return `<path fill="${garageColor(g.id)}" ${on ? '' : 'opacity="0.35"'} d="M${x} ${yTop + ht}V${yTop + rad}Q${x} ${yTop} ${x + rad} ${yTop}H${x + bw - rad}Q${x + bw} ${yTop} ${x + bw} ${yTop + rad}V${yTop + ht}Z"/>`;
    }).join('');
    const val = r.n && (r.n === top || last) ? `<text class="val" x="${x + bw / 2}" y="${yy - 6}" text-anchor="middle">${r.n}</text>` : '';
    const lab = (rows.length - 1 - i) % every === 0 ? `<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${monthLabel(r.ym)}</text>` : '';
    return `<g><rect class="hit" x="${L + step * i}" y="${T}" width="${step}" height="${H - T}" data-tip="${esc(monthLabel(r.ym, true))}: ${r.n} เรื่อง${(r.seg || []).length ? ' (' + r.seg.map((g) => gName(g.id) + ' ' + g.n).join(', ') + ')' : ''}"/>${bar}${val}${lab}</g>`;
  }).join('');
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="จำนวนเรื่องรายเดือน 12 เดือนล่าสุด">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}${bars}</svg>`;
}
const hBars = (rows) => {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows.length ? `<div class="hbars">${rows.map((r) => `<div class="hbar" data-tip="${esc(r.label)}: ${r.n} เรื่อง"><span class="hlabel" title="${esc(r.label)}"><i class="swatch"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${r.color}"/></svg></i>${esc(r.label)}</span><svg width="100%" height="14" aria-hidden="true">${r.n ? `<rect fill="${r.color}" width="${(r.n / max) * 100}%" height="14" rx="4"/>` : ''}</svg><b>${r.n}</b></div>`).join('')}</div>` : '<p class="muted">ไม่มีข้อมูล</p>';
};

// ── โหลดข้อมูล ──
async function fetchAll(table, select, order) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order(order, { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) return out;
  }
}
async function loadGarages() {
  const { data, error } = await sb.from('garages').select('*').order('sort_order').order('name');
  if (error) throw error;
  S.garages = data;
}
const loadComplaints = async () => { S.complaints = await fetchAll('complaints', '*,complaint_attachments(id)', 'created_at'); };
async function loadUsers() {
  const { data, error } = await sb.rpc('admin_list_users');
  if (error) throw error;
  S.users = data;
}

// ── Login ──
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  const { data: m, error } = await sb.from('garage_members').select('role,garage_id').eq('user_id', session.user.id).maybeSingle();
  if (error || !m) { await sb.auth.signOut(); return showLogin('บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าใช้งาน'); }
  S.me = { id: session.user.id, username: session.user.user_metadata?.username || session.user.email.split('@')[0], ...m };
  S.isAdmin = m.role === 'admin';
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoName').textContent = S.me.username + (S.isAdmin ? ' (ผู้ดูแล)' : '');
  renderNav();
  await go('home');
}
function showLogin(msg) {
  $('appView').hidden = true; $('loginView').hidden = false;
  $('loginErr').textContent = msg || ''; $('loginErr').hidden = !msg;
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: await toEmail($('loginUser').value), password: $('loginPass').value });
  btn.disabled = false;
  $('loginPass').value = '';
  if (error) return showLogin('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  await boot();
});
$('logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

// ── เมนู ──
function tabs() {
  const t = [['home', 'ภาพรวม'], ['link', 'ฟอร์มร้องเรียน'], ['complaints', 'เรื่องร้องเรียน']];
  if (S.isAdmin) t.push(['garages', 'จัดการอู่'], ['audit', 'ประวัติ']);
  return t;
}
function renderNav() {
  $('nav').innerHTML = tabs().map(([k, l]) => `<button type="button" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('');
}
$('nav').addEventListener('click', (e) => { const k = e.target.dataset.tab; if (k) go(k); });

let goToken = 0;   // กดเมนูเร็วๆ: ผลของเมนูก่อนหน้าที่โหลดเสร็จทีหลังต้องไม่ทับหน้าปัจจุบัน
async function go(tab) {
  const tok = ++goToken;
  S.tab = tab; S.redraw = null; renderNav();
  $('view').innerHTML = '<p class="muted">กำลังโหลด…</p>';
  try {
    await loadGarages();
    if (['home', 'complaints'].includes(tab)) await loadComplaints();
    if (tab === 'garages') await loadUsers();
    if (tok !== goToken) return;
    await VIEWS[tab]();
  } catch (e) {
    if (tok === goToken) $('view').innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`;
  }
}

const VIEWS = {
  // ── ภาพรวม: เปิดมาเป็นเดือนปัจจุบันเสมอ ──
  home() {
    const f = S.dash = { preset: 'month', garage: '', q: '' };
    [f.from, f.to] = presetRange('month');
    const PRE = [['all', 'เรื่องที่แจ้งทั้งหมด'], ['y12', 'ย้อนหลัง 12 เดือน'], ['last', 'เดือนที่แล้ว'], ['month', 'เดือนปัจจุบัน']];
    $('view').innerHTML = `<h2>ภาพรวม</h2>
      <div class="stats" id="dStats"></div>
      <div class="filters">${filterControls(f)}
        <label class="inline">ตั้งแต่ <input id="fFrom" type="date"></label>
        <label class="inline">ถึง <input id="fTo" type="date"></label>
      </div>
      <p class="muted" id="dPeriod"></p>
      <div class="charts">
        <section class="panel wide"><h3>จำนวนเรื่องตามเดือน <span class="muted">12 เดือนล่าสุด</span></h3><div id="cLegend" class="legend"></div><div id="cMonth"></div></section>
        <section class="panel wide"><h3>ตามอู่ <span class="muted">ในช่วงที่เลือก</span></h3><div id="cGarage"></div></section>
      </div>`;
    const redraw = () => {
      readControls(f);
      const base = S.complaints.filter((c) => matchBase(c, f));
      const ranges = { all: ['', ''], y12: presetRange('y12'), last: presetRange('last'), month: presetRange('month') };
      $('dStats').innerHTML = PRE.map(([k, l]) => `<button type="button" class="stat ${f.preset === k ? 'on' : ''}" data-pre="${k}" aria-pressed="${f.preset === k}"><b>${base.filter((c) => inRange(c, ...ranges[k])).length}</b><span>${l}</span></button>`).join('');
      $('fFrom').value = f.from; $('fTo').value = f.to;
      const list = base.filter((c) => inRange(c, f.from, f.to));   // เรียงล่าสุดก่อนจากตอนโหลดแล้ว
      $('dPeriod').textContent = f.from || f.to ? `ช่วงที่แสดง: ${fmtDate(f.from)} ถึง ${fmtDate(f.to)}` : 'ช่วงที่แสดง: ทั้งหมด';
      const ym = bkk().slice(0, 7);
      const months = Array.from({ length: 12 }, (_, i) => addMonths(ym, i - 11)).map((m) => {
        const rows = base.filter((c) => bkk(c.created_at).slice(0, 7) === m);
        return { ym: m, n: rows.length, seg: S.garages.map((g) => ({ id: g.id, n: rows.filter((c) => c.garage_id === g.id).length })).filter((g) => g.n) };
      });
      const shownG = S.garages.filter((g) => months.some((r) => r.seg.some((x) => x.id === g.id)));
      $('cLegend').innerHTML = shownG.map((g) => `<span class="lg"><i class="swatch"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${garageColor(g.id)}"/></svg></i>${esc(g.name)}</span>`).join('');
      monthChart($('cMonth'), months, f.from || '0000-00', f.to || '9999-99');
      $('cGarage').innerHTML = hBars(S.garages.map((g) => ({ label: g.name, color: garageColor(g.id), n: list.filter((c) => c.garage_id === g.id).length })).filter((r) => r.n || !f.garage).sort((a, b) => b.n - a.n));
    };
    S.redraw = redraw;
    $('dStats').onclick = (e) => {
      const k = e.target.closest('[data-pre]')?.dataset.pre; if (!k) return;
      f.preset = k; [f.from, f.to] = k === 'all' ? ['', ''] : presetRange(k); redraw();
    };
    const custom = () => { f.preset = 'custom'; f.from = $('fFrom').value; f.to = $('fTo').value; redraw(); };
    $('fFrom').onchange = custom; $('fTo').onchange = custom;
    $('fGarage').onchange = redraw; $('fQ').oninput = redraw;
    redraw();
  },

  // ── เรื่องร้องเรียน ──
  complaints() {
    const f = S.filter;
    $('view').innerHTML = `<h2>เรื่องร้องเรียน</h2>
      <div class="filters">${filterControls(f)}
        <label class="inline">รีพอร์ตตั้งแต่ <input id="fFrom" type="date" value="${esc(f.from)}"></label>
        <label class="inline">ถึง <input id="fTo" type="date" value="${esc(f.to)}"></label>
        <select id="fSort" aria-label="เรียงตามวันเวลาที่รีพอร์ต"><option value="desc" ${f.sort === 'desc' ? 'selected' : ''}>ล่าสุดก่อน</option><option value="asc" ${f.sort === 'asc' ? 'selected' : ''}>เก่าสุดก่อน</option></select>
      </div>
      <div id="cList"></div>`;
    const redraw = () => {
      readControls(f); f.from = $('fFrom').value; f.to = $('fTo').value; f.sort = $('fSort').value;
      const list = S.complaints.filter((c) => matchBase(c, f) && inRange(c, f.from, f.to));
      if (f.sort === 'asc') list.reverse();
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      f.page = Math.min(f.page, pages);
      const shown = list.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
      $('cList').innerHTML = complaintTable(shown, list.length) + (pages > 1 ? `<nav class="pager" aria-label="เลือกหน้า"><button type="button" class="ghost" data-page="${f.page - 1}" ${f.page === 1 ? 'disabled' : ''}>ก่อนหน้า</button><span>หน้า ${f.page} / ${pages}</span><button type="button" class="ghost" data-page="${f.page + 1}" ${f.page === pages ? 'disabled' : ''}>ถัดไป</button></nav>` : '');
    };
    S.redraw = redraw;
    const refilter = () => { f.page = 1; redraw(); };
    ['fGarage', 'fFrom', 'fTo', 'fSort'].forEach((id) => { $(id).onchange = refilter; }); $('fQ').oninput = refilter;
    $('cList').onclick = (e) => { const p = e.target.closest('[data-page]')?.dataset.page; if (p) { f.page = +p; redraw(); $('view').scrollIntoView(); } };
    redraw();
  },

  // ── ฟอร์มร้องเรียน: ฟอร์มเต็มจอ ──
  async link() {
    $('view').innerHTML = `<h2>ฟอร์มร้องเรียน</h2><iframe id="formFrame" class="form-frame" src="/report?embed=1" title="ฟอร์มร้องเรียน"></iframe>`;
    // ให้ความสูงกรอบเท่าฟอร์ม หน้าจะเลื่อนชั้นเดียว
    const fr = $('formFrame');
    fr.onload = () => { const doc = fr.contentDocument; if (!doc) return; const fit = () => { fr.style.height = doc.documentElement.scrollHeight + 'px'; }; fit(); new ResizeObserver(fit).observe(doc.body); };
  },

  // ── จัดการอู่ + บัญชีผู้ใช้ ──
  garages() {
    const usersOf = (id) => S.users.filter((u) => u.garage_id === id).map((u) => u.username).join(', ') || '-';
    $('view').innerHTML = `<h2>จัดการอู่</h2>
      <div class="row panel"><button type="button" id="addGarage">เพิ่มอู่พร้อมบัญชีผู้ใช้</button></div>
      <div class="scroll"><table><thead><tr><th>รหัส</th><th>ชื่ออู่</th><th>ผู้ใช้</th><th>ที่อยู่</th><th>Contact Person</th><th>Contact Number</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${S.garages.map((g) => `<tr><td>${esc(g.code || '-')}</td><td>${esc(g.name)}</td><td>${esc(usersOf(g.id))}</td><td class="clip" title="${esc(g.address || '')}">${esc(g.address || '-')}</td><td>${esc(g.contact_person || '-')}</td><td>${esc(g.contact_number || '-')}</td><td><span class="tag ${g.is_active ? 'closed' : 'off'}">${g.is_active ? 'เปิดรับเรื่อง' : 'ปิดรับเรื่อง'}</span></td>
        <td class="actions"><button type="button" class="ghost" data-grename="${g.id}">แก้ไข</button><button type="button" class="ghost" data-uadd="${g.id}">เพิ่มผู้ใช้</button><button type="button" class="ghost" data-gtoggle="${g.id}">${g.is_active ? 'ปิดรับเรื่อง' : 'เปิดรับเรื่อง'}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">ยังไม่มีอู่</td></tr>'}
      </tbody></table></div>
      <h3 class="sec">บัญชีผู้ใช้ทั้งหมด</h3>
      <div class="row panel"><button type="button" class="ghost" id="addAdmin">เพิ่มผู้ดูแลระบบ</button></div>
      <div class="scroll"><table><thead><tr><th>ชื่อผู้ใช้</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th><th></th></tr></thead><tbody>
      ${S.users.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'ผู้ดูแลระบบ' : esc(u.garage_name)}</td><td><span class="tag ${u.active ? 'closed' : 'off'}">${u.active ? 'ใช้งาน' : 'ปิดบัญชี'}</span></td><td>${fmt(u.last_sign_in_at)}</td>
        <td class="actions"><button type="button" class="ghost" data-upass="${u.user_id}">ตั้งรหัสใหม่</button>${u.user_id === S.me.id ? '' : `<button type="button" class="ghost" data-utoggle="${u.user_id}" data-active="${u.active}">${u.active ? 'ปิดบัญชี' : 'เปิดบัญชี'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    $('addGarage').onclick = () => openGarageForm();
    $('addAdmin').onclick = () => openUserForm(null);
  },

  // ── ประวัติ ──
  async audit() {
    await loadUsers();
    const { data, error } = await sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    const who = (id) => S.users.find((u) => u.user_id === id)?.username || '-';
    const { data: refs } = await sb.from('complaints').select('id,ref_no').in('id', [...new Set(data.map((a) => a.complaint_id).filter(Boolean))]);
    const refOf = (id) => refs?.find((r) => r.id === id)?.ref_no || (id ? id.slice(0, 8).toUpperCase() : '-');
    $('view').innerHTML = `<h2>ประวัติการใช้งาน</h2><p class="muted">300 รายการล่าสุด</p><div class="scroll"><table><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>รายการ</th><th>เลขอ้างอิง</th><th>รายละเอียด</th></tr></thead><tbody>
      ${data.map((a) => `<tr><td>${fmt(a.created_at)}</td><td>${esc(who(a.actor))}</td><td>${esc(AUDIT[a.action] || a.action)}</td><td>${esc(refOf(a.complaint_id))}</td><td>${esc(auditDetail(a))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีประวัติ</td></tr>'}
      </tbody></table></div>`;
  },
};

function auditDetail(a) {
  const d = a.detail || {};
  if (a.action === 'move_complaint') return `${gName(d.from)} → ${gName(d.to)} (${d.reason || ''})`;
  if (a.action === 'set_status') return `${STATUS[d.from] || d.from} → ${STATUS[d.to] || d.to}`;
  if (a.action === 'create_user') return d.username || '';
  if (d.user_id) return S.users.find((u) => u.user_id === d.user_id)?.username || '';
  return '';
}

// ── รายละเอียดเรื่อง ──
async function openComplaint(id) {
  const c = S.complaints.find((x) => x.id === id); if (!c) return;
  S.viewing = id;
  const { data: files } = await sb.from('complaint_attachments').select('*').eq('complaint_id', id);
  const links = await Promise.all((files || []).map(async (f) => {
    const { data } = await sb.storage.from('complaint-files').createSignedUrl(f.storage_path, 600);
    return data ? `<li><a href="${esc(data.signedUrl)}" target="_blank" rel="noopener">${esc(f.file_name)}</a></li>` : `<li>${esc(f.file_name)} (เปิดไม่ได้)</li>`;
  }));
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const mine = S.isAdmin || c.garage_id === S.me.garage_id;   // เรื่องของอู่อื่น = ดูอย่างเดียว (ฐานข้อมูลก็บังคับเช่นกัน)
  $('dlgBody').innerHTML = `<h2>เรื่อง ${esc(c.ref_no)}</h2>
    <dl class="detail">
      ${row('วันที่แจ้ง', fmt(c.created_at))}${row('วันเกิดเหตุ', fmtDate(c.incident_date))}${row('อู่', esc(gName(c.garage_id)))}${c.plate ? row('ทะเบียน', esc(c.plate)) : ''}
      ${c.reporter_name ? row('ผู้แจ้ง', esc([c.reporter_name, c.reporter_last_name].filter(Boolean).join(' '))) : ''}${c.contact_phone ? row('เบอร์โทรผู้แจ้ง', `<a href="tel:${esc(c.contact_phone)}">${esc(c.contact_phone)}</a>`) : ''}
      ${row('ชื่อคนขับ', esc(c.driver_name || '-'))}${row('มือถือคนขับ', c.driver_phone ? `<a href="tel:${esc(c.driver_phone)}">${esc(c.driver_phone)}</a>` : '-')}${row('Line ID', esc(c.driver_line_id || '-'))}
      ${row('เลขบัตร', c.national_id_last4 ? `<span id="nidVal">กำลังโหลด…</span>` : '-')}
    </dl>
    <h3>รายละเอียด</h3><p class="prewrap">${esc(c.detail)}</p>
    <h3>ไฟล์แนบ</h3>${links.length ? `<ul>${links.join('')}</ul>` : '<p class="muted">ไม่มีไฟล์แนบ</p>'}
    <p>สถานะ <span class="tag ${c.status}">${STATUS[c.status]}</span>${mine ? '' : ' <span class="muted">เรื่องของอู่อื่น ดูได้อย่างเดียว</span>'}</p>
    <h3>หมายเหตุของอู่</h3>
    ${mine ? `<label class="sr" for="dNote">หมายเหตุหรือเหตุผลเพิ่มเติม</label><textarea id="dNote" rows="3" maxlength="2000" placeholder="ใส่หมายเหตุหรือเหตุผลเพิ่มเติม"></textarea><div class="row note-save"><button type="button" id="dNoteSave" class="ghost">บันทึกหมายเหตุ</button></div>`
      : `<p class="prewrap">${esc(c.garage_note || '-')}</p>`}
    <div class="row end"><button type="button" id="dClose" class="ghost">ปิด</button></div>`;
  $('dlg').showModal();
  $('dClose').onclick = () => $('dlg').close();
  if ($('nidVal')) {   // เปิดเลขเต็มอัตโนมัติ ฐานข้อมูลบันทึกประวัติการเปิดดูทุกครั้ง
    const { data, error } = await sb.rpc('reveal_national_id', { p_complaint_id: id });
    if (S.viewing === id && $('nidVal')) $('nidVal').textContent = error ? '*********' + c.national_id_last4 : (data || '-');
  }
  if ($('dNote')) {
    $('dNote').value = c.garage_note || '';
    $('dNoteSave').onclick = async () => {
      const { error } = await sb.rpc('set_complaint_note', { p_complaint_id: id, p_note: $('dNote').value });
      if (error) return toast(errMsg(error));
      c.garage_note = $('dNote').value.trim() || null; toast('บันทึกหมายเหตุแล้ว');
    };
  }
}

function openComplaintEdit(c) {
  $('dlgBody').innerHTML = `<h2>แก้ไขเรื่อง ${esc(c.ref_no)}</h2><form id="dForm">
    <div class="grid"><label>วันเกิดเหตุ <input id="eDate" type="date" max="${bkk()}"></label><label>ชื่อคนขับ <input id="eDrv" maxlength="100"></label>
    <label>มือถือคนขับ <input id="eDrvPhone" inputmode="tel" maxlength="15"></label>
    <label>Line ID <input id="eLine" maxlength="50" autocapitalize="none"></label><label>สถานะ <select id="eStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
    <label>รายละเอียด <textarea id="eDetail" rows="5" required maxlength="2000"></textarea></label>
    <div class="row end"><button type="button" id="dCancel" class="ghost">ยกเลิก</button><button type="submit">บันทึก</button></div></form>`;
  $('eDate').value = c.incident_date || ''; $('eDrv').value = c.driver_name || '';
  $('eDrvPhone').value = c.driver_phone || ''; $('eLine').value = c.driver_line_id || ''; $('eStatus').value = c.status; $('eDetail').value = c.detail;
  $('dlg').showModal();
  $('dCancel').onclick = () => $('dlg').close();
  $('dForm').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc('update_complaint', { p_complaint_id: c.id, p_incident_date: $('eDate').value || null,
      p_driver_name: $('eDrv').value, p_driver_code: c.driver_code, p_driver_phone: $('eDrvPhone').value, p_driver_line_id: $('eLine').value, p_detail: $('eDetail').value, p_status: $('eStatus').value });
    if (error) return toast(errMsg(error));
    $('dlg').close(); toast('แก้ไขแล้ว'); await refreshList();
  };
}
async function deleteComplaint(c) {
  if (!confirm(`ลบเรื่อง ${c.ref_no} และไฟล์แนบทั้งหมด? ลบแล้วกู้คืนไม่ได้`)) return;
  // ลบไฟล์ก่อน เพราะสิทธิ์ลบไฟล์ตรวจจากแถวไฟล์แนบที่ยังอยู่ · remove ไม่ error เมื่อไม่มีสิทธิ์ ต้องนับจำนวนที่ลบได้จริง
  const { data: files } = await sb.from('complaint_attachments').select('storage_path').eq('complaint_id', c.id);
  const paths = (files || []).map((f) => f.storage_path);
  let msg = 'ลบเรื่องแล้ว';
  if (paths.length) {
    const { data: gone, error: e2 } = await sb.storage.from('complaint-files').remove(paths);
    if (e2 || (gone || []).length < paths.length) msg = 'ลบเรื่องแล้ว แต่ลบไฟล์แนบไม่ครบ กรุณาแจ้งผู้ดูแลระบบ';
  }
  const { error } = await sb.rpc('delete_complaint', { p_complaint_id: c.id });
  if (error) return toast(errMsg(error));
  toast(msg); await refreshList();
}
const refreshList = async () => { await loadComplaints(); S.redraw?.(); };

// garageId = null คือเพิ่มผู้ดูแลระบบ
function openUserForm(garageId) {
  $('dlgBody').innerHTML = `<h2>${garageId ? 'เพิ่มผู้ใช้ของ ' + esc(gName(garageId)) : 'เพิ่มผู้ดูแลระบบ'}</h2><form id="dForm">
    <label>ชื่อผู้ใช้ <input id="uName" required minlength="2" maxlength="50" autocomplete="off" autocapitalize="none" placeholder="ตั้งชื่ออะไรก็ได้"></label>
    <label>รหัสผ่าน <input id="uPass" type="text" required minlength="8" maxlength="72" autocomplete="off" placeholder="อย่างน้อย 8 ตัวอักษร"></label>
    <div class="row end"><button type="button" id="dCancel" class="ghost">ยกเลิก</button><button type="submit">สร้างผู้ใช้</button></div></form>`;
  $('dlg').showModal();
  $('dCancel').onclick = () => $('dlg').close();
  $('dForm').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc('admin_create_user', { p_username: $('uName').value, p_password: $('uPass').value, p_garage_id: garageId });
    if (error) return toast(errMsg(error));
    $('dlg').close(); toast('สร้างผู้ใช้แล้ว'); go('garages');
  };
}

function openGarageForm(g) {
  $('dlgBody').innerHTML = `<h2>${g ? 'แก้ไขอู่' : 'เพิ่มอู่'}</h2><form id="dForm">
    <label>ชื่ออู่ <input id="gName" required maxlength="100" autocomplete="off"></label>
    ${g ? `<p class="muted">รหัสอู่ ${esc(g.code || '-')}</p>` : '<p class="muted">รหัสอู่ระบบออกให้อัตโนมัติ เช่น A1, A2</p>'}
    <label>ที่อยู่ <textarea id="gAddress" rows="2" maxlength="500"></textarea></label>
    <label>Contact Person <input id="gPerson" maxlength="100" autocomplete="off"></label>
    <label>Contact Number <input id="gNumber" inputmode="tel" maxlength="30" autocomplete="off"></label>
    ${g ? '' : `<h3>บัญชีเข้าใช้งานของอู่</h3>
    <label>ชื่อผู้ใช้ <input id="gUser" required minlength="2" maxlength="50" autocomplete="off" autocapitalize="none" placeholder="ตั้งชื่ออะไรก็ได้"></label>
    <label>รหัสผ่าน <input id="gPass" type="text" required minlength="8" maxlength="72" autocomplete="off" placeholder="อย่างน้อย 8 ตัวอักษร"></label>`}
    <div class="row end"><button type="button" id="dCancel" class="ghost">ยกเลิก</button><button type="submit">บันทึก</button></div></form>`;
  $('gName').value = g?.name || ''; $('gAddress').value = g?.address || ''; $('gPerson').value = g?.contact_person || ''; $('gNumber').value = g?.contact_number || '';
  $('dlg').showModal();
  $('dCancel').onclick = () => $('dlg').close();
  $('dForm').onsubmit = async (e) => {
    e.preventDefault();
    const row = { name: $('gName').value.trim(), address: $('gAddress').value.trim() || null, contact_person: $('gPerson').value.trim() || null, contact_number: $('gNumber').value.trim() || null };
    if (!row.name) return toast('กรุณากรอกชื่ออู่');
    const { error } = g ? await sb.from('garages').update(row).eq('id', g.id)
      : await sb.rpc('admin_create_garage', { p_name: row.name, p_address: row.address, p_contact_person: row.contact_person, p_contact_number: row.contact_number, p_username: $('gUser').value, p_password: $('gPass').value });
    if (error) return toast(error.code === '23505' ? 'ชื่ออู่นี้มีอยู่แล้ว' : errMsg(error));
    $('dlg').close(); toast(g ? 'แก้ไขอู่แล้ว' : 'เพิ่มอู่และบัญชีผู้ใช้แล้ว'); go('garages');
  };
}

function openForm(title, label, submitText, onSubmit, opts = {}) {
  $('dlgBody').innerHTML = `<h2>${esc(title)}</h2><form id="dForm"><label>${esc(label)} <input id="dInput" type="${opts.type || 'text'}" required minlength="${opts.min || 1}" maxlength="${opts.max || 100}" value="${esc(opts.value || '')}" autocomplete="off"></label>
    <div class="row end"><button type="button" id="dCancel" class="ghost">ยกเลิก</button><button type="submit">${esc(submitText)}</button></div></form>`;
  $('dlg').showModal();
  $('dCancel').onclick = () => $('dlg').close();
  $('dForm').onsubmit = async (e) => { e.preventDefault(); await onSubmit($('dInput').value); };
}

$('changePwBtn').addEventListener('click', () => openForm('เปลี่ยนรหัสผ่านของฉัน', 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)', 'บันทึก', async (v) => {
  const { error } = await sb.auth.updateUser({ password: v });
  if (error) return toast(/different/i.test(error.message) ? 'รหัสใหม่ต้องไม่ซ้ำรหัสเดิม' : 'เปลี่ยนรหัสผ่านไม่สำเร็จ');
  $('dlg').close(); toast('เปลี่ยนรหัสผ่านแล้ว');
}, { type: 'password', min: 8, max: 72 }));

// ── ปุ่มในตาราง ──
$('view').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-open],[data-cedit],[data-cdel],[data-uadd],[data-grename],[data-gtoggle],[data-upass],[data-utoggle]')?.dataset;
  if (!d) return;
  if (d.open) return openComplaint(d.open);
  if (d.cedit) return openComplaintEdit(S.complaints.find((x) => x.id === d.cedit));
  if (d.cdel) return deleteComplaint(S.complaints.find((x) => x.id === d.cdel));
  if (d.uadd) return openUserForm(d.uadd);
  if (d.grename) return openGarageForm(S.garages.find((x) => x.id === d.grename));
  if (d.gtoggle) {
    const g = S.garages.find((x) => x.id === d.gtoggle);
    const { error } = await sb.from('garages').update({ is_active: !g.is_active }).eq('id', g.id);
    if (error) return toast(errMsg(error));
    return go('garages');
  }
  if (d.upass) {
    const u = S.users.find((x) => x.user_id === d.upass);
    return openForm(`ตั้งรหัสใหม่ให้ ${u.username}`, 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)', 'บันทึก', async (v) => {
      const { error } = await sb.rpc('admin_set_password', { p_user_id: u.user_id, p_password: v });
      if (error) return toast(errMsg(error));
      $('dlg').close(); toast('ตั้งรหัสใหม่แล้ว');
    }, { min: 8, max: 72 });
  }
  if (d.utoggle) {
    const on = d.active !== 'true';
    if (!on && !confirm('ปิดบัญชีนี้? ผู้ใช้จะเข้าระบบไม่ได้ทันที')) return;
    const { error } = await sb.rpc('admin_set_user_active', { p_user_id: d.utoggle, p_active: on });
    if (error) return toast(errMsg(error));
    go('garages');
  }
});
// กล่องข้อมูลเมื่อชี้กราฟ (ตั้งตำแหน่งผ่าน JS ได้ภายใต้ CSP)
$('view').addEventListener('mousemove', (e) => {
  const t = $('chartTip'), v = e.target.closest?.('[data-tip]')?.dataset.tip;
  if (!v) { t.hidden = true; return; }
  t.textContent = v; t.hidden = false;
  t.style.left = Math.min(e.clientX + 12, innerWidth - t.offsetWidth - 8) + 'px'; t.style.top = Math.max(e.clientY - 34, 8) + 'px';
});
$('view').addEventListener('mouseleave', () => { $('chartTip').hidden = true; });
let resizeT; addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => S.redraw?.(), 150); });
// จอเล็กแสดงตารางเป็นการ์ด: คัดลอกหัวคอลัมน์ไปเป็นป้ายของแต่ละช่อง
new MutationObserver(() => {
  document.querySelectorAll('#view table').forEach((t) => {
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    t.querySelectorAll('tbody td:not([colspan]):not([data-label])').forEach((td) => { td.dataset.label = heads[td.cellIndex] || ''; });
  });
}).observe($('view'), { childList: true, subtree: true });
$('view').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.open) openComplaint(e.target.dataset.open); });

boot();
