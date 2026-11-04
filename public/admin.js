// หลังบ้าน — สิทธิ์จริงอยู่ที่ RLS และฟังก์ชันในฐานข้อมูล หน้านี้แค่ซ่อนเมนูที่ไม่เกี่ยวข้อง
const $ = (id) => document.getElementById(id);
const sb = window.supabase.createClient(window.TR_CONFIG.url, window.TR_CONFIG.key);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '-');
const STATUS = { new: 'ใหม่', in_progress: 'กำลังดำเนินการ', closed: 'ปิดเรื่อง' };
const REPORTER = { passenger: 'ผู้โดยสาร', garage_staff: 'พนักงานอู่' };
const AUDIT = { reveal_national_id: 'เปิดดูเลขบัตร', move_complaint: 'ย้ายอู่', set_status: 'เปลี่ยนสถานะ', create_user: 'สร้างผู้ใช้', set_password: 'ตั้งรหัสผ่าน', enable_user: 'เปิดบัญชี', disable_user: 'ปิดบัญชี' };
const REPORT_URL = location.origin + '/report';
const toEmail = (u) => u.trim().toLowerCase() + '@taxi-report.local';

const S = { me: null, isAdmin: false, tab: 'home', garages: [], complaints: [], users: [], filter: { garage: '', status: '', q: '' }, viewing: null };

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3000);
}
const errMsg = (e) => (e && e.code === 'P0001' ? e.message : e && e.code === '42501' ? 'ไม่มีสิทธิ์ทำรายการนี้' : 'ทำรายการไม่สำเร็จ กรุณาลองใหม่');
const gName = (id) => S.garages.find((g) => g.id === id)?.name || '-';

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
const loadComplaints = async () => { S.complaints = await fetchAll('complaints', '*', 'created_at'); };
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
  S.me = { id: session.user.id, username: session.user.email.split('@')[0], ...m };
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
  const { error } = await sb.auth.signInWithPassword({ email: toEmail($('loginUser').value), password: $('loginPass').value });
  btn.disabled = false;
  $('loginPass').value = '';
  if (error) return showLogin('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  await boot();
});
$('logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

// ── เมนู ──
function tabs() {
  const t = [['home', 'ภาพรวม'], ['complaints', 'เรื่องร้องเรียน'], ['drivers', 'คนขับ'], ['link', 'ลิงก์ / QR']];
  if (S.isAdmin) t.push(['garages', 'จัดการอู่'], ['users', 'ผู้ใช้งาน'], ['audit', 'ประวัติ']);
  return t;
}
function renderNav() {
  $('nav').innerHTML = tabs().map(([k, l]) => `<button type="button" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('');
}
$('nav').addEventListener('click', (e) => { const k = e.target.dataset.tab; if (k) go(k); });

let goToken = 0;   // กดเมนูเร็วๆ: ผลของเมนูก่อนหน้าที่โหลดเสร็จทีหลังต้องไม่ทับหน้าปัจจุบัน
async function go(tab) {
  const tok = ++goToken;
  S.tab = tab; renderNav();
  $('view').innerHTML = '<p class="muted">กำลังโหลด…</p>';
  try {
    await loadGarages();
    if (['home', 'complaints', 'drivers'].includes(tab)) await loadComplaints();
    if (tab === 'users') await loadUsers();
    if (tok !== goToken) return;
    await VIEWS[tab]();
  } catch (e) {
    if (tok === goToken) $('view').innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`;
  }
}

const VIEWS = {
  // ── ภาพรวม ──
  home() {
    const c = S.complaints, n = (s) => c.filter((x) => x.status === s).length;
    const stat = (l, v) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    const rows = S.garages.map((g) => {
      const r = c.filter((x) => x.garage_id === g.id);
      return `<tr><td>${esc(g.name)}</td><td class="num">${r.length}</td><td class="num">${r.filter((x) => x.status === 'new').length}</td><td class="num">${r.filter((x) => x.status === 'in_progress').length}</td><td class="num">${r.filter((x) => x.status === 'closed').length}</td></tr>`;
    }).filter((_, i) => S.isAdmin || S.garages[i].id === S.me.garage_id).join('');
    $('view').innerHTML = `<h2>ภาพรวม</h2>
      <div class="stats">${stat('ทั้งหมด', c.length)}${stat('ใหม่', n('new'))}${stat('กำลังดำเนินการ', n('in_progress'))}${stat('ปิดเรื่อง', n('closed'))}</div>
      <div class="scroll"><table><thead><tr><th>อู่</th><th class="num">ทั้งหมด</th><th class="num">ใหม่</th><th class="num">กำลังดำเนินการ</th><th class="num">ปิดเรื่อง</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">ยังไม่มีอู่</td></tr>'}</tbody></table></div>`;
  },

  // ── เรื่องร้องเรียน ──
  complaints() {
    const f = S.filter;
    $('view').innerHTML = `<h2>เรื่องร้องเรียน</h2>
      <div class="filters">
        ${S.isAdmin ? `<select id="fGarage" aria-label="อู่"><option value="">ทุกอู่</option>${S.garages.map((g) => `<option value="${g.id}" ${f.garage === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : ''}
        <select id="fStatus" aria-label="สถานะ"><option value="">ทุกสถานะ</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input id="fQ" placeholder="ค้นหาทะเบียน ชื่อ รหัสคนขับ เลขอ้างอิง" value="${esc(f.q)}" aria-label="ค้นหา">
      </div>
      <div id="cList"></div>`;
    const redraw = () => {
      f.garage = $('fGarage')?.value || ''; f.status = $('fStatus').value; f.q = $('fQ').value.trim().toLowerCase();
      const list = S.complaints.filter((c) => (!f.garage || c.garage_id === f.garage) && (!f.status || c.status === f.status) &&
        (!f.q || [c.plate, c.driver_name, c.driver_code, c.reporter_name, c.id.slice(0, 8)].some((v) => (v || '').toLowerCase().includes(f.q))));
      $('cList').innerHTML = `<p class="muted">${list.length} เรื่อง</p><div class="scroll"><table class="click"><thead><tr><th>วันที่</th><th>เลขอ้างอิง</th><th>อู่</th><th>ทะเบียน</th><th>คนขับ</th><th>ผู้แจ้ง</th><th>สถานะ</th></tr></thead><tbody>
        ${list.map((c) => `<tr data-open="${c.id}" tabindex="0"><td>${fmt(c.created_at)}</td><td>${c.id.slice(0, 8).toUpperCase()}</td><td>${esc(gName(c.garage_id))}</td><td>${esc(c.plate)}</td><td>${esc(c.driver_name || c.driver_code || '-')}</td><td>${esc(c.reporter_name)}</td><td><span class="tag ${c.status}">${STATUS[c.status]}</span></td></tr>`).join('') || '<tr><td colspan="7" class="muted">ไม่พบเรื่อง</td></tr>'}
      </tbody></table></div>`;
    };
    $('fGarage')?.addEventListener('change', redraw); $('fStatus').addEventListener('change', redraw); $('fQ').addEventListener('input', redraw);
    redraw();
  },

  // ── Card คนขับ: รวมจากเลขบัตร/รหัสคนขับเท่านั้น ไม่เดาจากชื่อ ──
  drivers() {
    const cards = groupDrivers(S.complaints);
    $('view').innerHTML = `<h2>คนขับ</h2><p class="muted">รวมเรื่องจากเลขบัตรหรือรหัสคนขับ เรื่องที่ไม่มีทั้งสองอย่างจะแยกเป็นคนละใบ</p>
      <div class="cards">${cards.map((p, i) => `<article class="card">
        <h3>${esc(p.name || 'ไม่ทราบชื่อ')}</h3>
        <dl><dt>จำนวนเรื่อง</dt><dd>${p.items.length}</dd><dt>รหัสคนขับ</dt><dd>${esc(p.codes.join(', ') || '-')}</dd>
        <dt>เลขบัตร</dt><dd>${p.last4 ? '*********' + esc(p.last4) : '-'}</dd><dt>ทะเบียน</dt><dd>${esc(p.plates.join(', '))}</dd>
        <dt>อู่</dt><dd>${esc(p.garages.map(gName).join(', '))}</dd><dt>ล่าสุด</dt><dd>${fmt(p.items[0].created_at)}</dd></dl>
        <button type="button" class="ghost" data-card="${i}">ดาวน์โหลด Card</button></article>`).join('') || '<p class="muted">ยังไม่มีข้อมูล</p>'}</div>`;
    S.cards = cards;
  },

  // ── ลิงก์ / QR ──
  async link() {
    $('view').innerHTML = `<h2>ลิงก์และ QR แจ้งเรื่อง</h2>
      <p class="muted">ลิงก์เดียวใช้ได้ทุกอู่ ผู้แจ้งเลือกอู่เองในฟอร์ม</p>
      <div class="panel qr"><div id="qrBox"></div>
        <div><p class="link-url" id="reportUrl"></p>
          <div class="row"><button type="button" id="copyLink">คัดลอกลิงก์</button><a class="btn ghost" href="/report" target="_blank" rel="noopener">เปิดฟอร์ม</a><button type="button" id="dlQr" class="ghost">ดาวน์โหลด QR</button></div>
        </div></div>`;
    $('reportUrl').textContent = REPORT_URL;
    const qr = new window.QRCodeStyling({ width: 300, height: 300, type: 'canvas', data: REPORT_URL, margin: 8,
      dotsOptions: { type: 'rounded', color: '#15803d' }, cornersSquareOptions: { type: 'extra-rounded', color: '#166534' },
      cornersDotOptions: { type: 'dot', color: '#166534' }, backgroundOptions: { color: '#ffffff' }, qrOptions: { errorCorrectionLevel: 'Q' } });
    qr.append($('qrBox'));
    $('copyLink').onclick = async () => { await navigator.clipboard.writeText(REPORT_URL); toast('คัดลอกลิงก์แล้ว'); };
    $('dlQr').onclick = () => qr.download({ name: 'qr-แจ้งเรื่องแท็กซี่', extension: 'png' });
  },

  // ── จัดการอู่ ──
  garages() {
    $('view').innerHTML = `<h2>จัดการอู่</h2>
      <form id="addGarage" class="row panel"><input id="gName" required maxlength="100" placeholder="ชื่ออู่ใหม่" aria-label="ชื่ออู่ใหม่"><button type="submit">เพิ่มอู่</button></form>
      <div class="scroll"><table><thead><tr><th>ชื่ออู่</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${S.garages.map((g) => `<tr><td>${esc(g.name)}</td><td><span class="tag ${g.is_active ? 'closed' : 'off'}">${g.is_active ? 'เปิดรับเรื่อง' : 'ปิดรับเรื่อง'}</span></td>
        <td class="actions"><button type="button" class="ghost" data-grename="${g.id}">แก้ชื่อ</button><button type="button" class="ghost" data-gtoggle="${g.id}">${g.is_active ? 'ปิดรับเรื่อง' : 'เปิดรับเรื่อง'}</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">ยังไม่มีอู่</td></tr>'}
      </tbody></table></div>`;
    $('addGarage').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('gName').value.trim(); if (!name) return;
      const { error } = await sb.from('garages').insert({ name });
      if (error) return toast(error.code === '23505' ? 'มีอู่ชื่อนี้แล้ว' : errMsg(error));
      toast('เพิ่มอู่แล้ว'); go('garages');
    };
  },

  // ── ผู้ใช้งาน ──
  users() {
    $('view').innerHTML = `<h2>ผู้ใช้งาน</h2>
      <form id="addUser" class="panel grid"><label>ชื่อผู้ใช้ <input id="uName" required maxlength="30" autocomplete="off" autocapitalize="none" placeholder="a-z 0-9 . _ -"></label>
        <label>รหัสผ่าน <input id="uPass" type="text" required minlength="8" maxlength="72" autocomplete="off" placeholder="อย่างน้อย 8 ตัวอักษร"></label>
        <label>สิทธิ์ <select id="uGarage"><option value="">เลือกอู่</option>${S.garages.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}<option value="__admin">ผู้ดูแลระบบ (เห็นทุกอู่)</option></select></label>
        <button type="submit">สร้างผู้ใช้</button></form>
      <div class="scroll"><table><thead><tr><th>ชื่อผู้ใช้</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th><th></th></tr></thead><tbody>
      ${S.users.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'admin' ? 'ผู้ดูแลระบบ' : esc(u.garage_name)}</td><td><span class="tag ${u.active ? 'closed' : 'off'}">${u.active ? 'ใช้งาน' : 'ปิดบัญชี'}</span></td><td>${fmt(u.last_sign_in_at)}</td>
        <td class="actions"><button type="button" class="ghost" data-upass="${u.user_id}">ตั้งรหัสใหม่</button>${u.user_id === S.me.id ? '' : `<button type="button" class="ghost" data-utoggle="${u.user_id}" data-active="${u.active}">${u.active ? 'ปิดบัญชี' : 'เปิดบัญชี'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    $('addUser').onsubmit = async (e) => {
      e.preventDefault();
      const g = $('uGarage').value;
      if (!g) return toast('กรุณาเลือกอู่หรือสิทธิ์');
      const { error } = await sb.rpc('admin_create_user', { p_username: $('uName').value, p_password: $('uPass').value, p_garage_id: g === '__admin' ? null : g });
      if (error) return toast(errMsg(error));
      toast('สร้างผู้ใช้แล้ว'); go('users');
    };
  },

  // ── ประวัติ ──
  async audit() {
    await loadUsers();
    const { data, error } = await sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    const who = (id) => S.users.find((u) => u.user_id === id)?.username || '-';
    $('view').innerHTML = `<h2>ประวัติการใช้งาน</h2><p class="muted">300 รายการล่าสุด</p><div class="scroll"><table><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>รายการ</th><th>เลขอ้างอิง</th><th>รายละเอียด</th></tr></thead><tbody>
      ${data.map((a) => `<tr><td>${fmt(a.created_at)}</td><td>${esc(who(a.actor))}</td><td>${esc(AUDIT[a.action] || a.action)}</td><td>${a.complaint_id ? a.complaint_id.slice(0, 8).toUpperCase() : '-'}</td><td>${esc(auditDetail(a))}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีประวัติ</td></tr>'}
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

// เรื่องที่ใช้เลขบัตรหรือรหัสคนขับตัวเดียวกันเชื่อมเป็นคนเดียวกัน
function groupDrivers(list) {
  const parent = list.map((_, i) => i), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const seen = {};
  list.forEach((c, i) => [c.person_nid_key, c.person_code_key].filter(Boolean).forEach((k) => {
    if (seen[k] == null) seen[k] = i; else parent[find(i)] = find(seen[k]);
  }));
  const groups = {};
  list.forEach((c, i) => (groups[find(i)] = groups[find(i)] || []).push(c));
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  return Object.values(groups).map((items) => ({
    items, name: items.find((c) => c.driver_name)?.driver_name, codes: uniq(items.map((c) => c.driver_code)),
    last4: items.find((c) => c.national_id_last4)?.national_id_last4, plates: uniq(items.map((c) => c.plate)), garages: uniq(items.map((c) => c.garage_id)),
  })).sort((a, b) => b.items.length - a.items.length || b.items[0].created_at.localeCompare(a.items[0].created_at));
}

// Card เป็นรูป PNG วาดเองบน canvas (ไม่ส่งข้อมูลออกนอกเครื่อง)
function downloadCard(p) {
  const font = '"Noto Sans Thai","Sukhumvit Set","Thonburi",sans-serif', W = 900;
  const c = document.createElement('canvas'), x = c.getContext('2d');
  const lines = [['จำนวนเรื่อง', String(p.items.length)], ['รหัสคนขับ', p.codes.join(', ') || '-'], ['เลขบัตร', p.last4 ? '*********' + p.last4 : '-'], ['ทะเบียน', p.plates.join(', ')], ['อู่', p.garages.map(gName).join(', ')]];
  const recent = p.items.slice(0, 5);
  const wrap = (t, w) => { const out = []; let cur = ''; for (const ch of t) { if (x.measureText(cur + ch).width > w) { out.push(cur); cur = ch; } else cur += ch; } if (cur) out.push(cur); return out; };
  const paint = (draw) => {
    let y = 118;
    if (draw) { x.fillStyle = '#fff'; x.fillRect(0, 0, W, c.height); x.fillStyle = '#15803d'; x.fillRect(0, 0, W, 84); x.fillStyle = '#fff'; x.font = `700 34px ${font}`; x.fillText(p.name || 'ไม่ทราบชื่อ', 32, 54); }
    for (const [k, v] of lines) { x.font = `20px ${font}`; if (draw) { x.fillStyle = '#6b7280'; x.fillText(k, 32, y); x.fillStyle = '#1f2937'; } for (const l of wrap(v, W - 240)) { if (draw) x.fillText(l, 200, y); y += 32; } }
    y += 14; x.font = `700 22px ${font}`; if (draw) { x.fillStyle = '#166534'; x.fillText('เรื่องล่าสุด', 32, y); } y += 36;
    for (const r of recent) {
      x.font = `600 18px ${font}`; if (draw) { x.fillStyle = '#1f2937'; x.fillText(`${fmt(r.created_at)} · ${r.plate} · ${STATUS[r.status]}`, 32, y); } y += 28;
      x.font = `18px ${font}`; for (const l of wrap(r.detail, W - 64).slice(0, 3)) { if (draw) { x.fillStyle = '#374151'; x.fillText(l, 32, y); } y += 26; } y += 12;
    }
    return y + 8;
  };
  c.width = W; c.height = 10; c.height = paint(false); paint(true);
  c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `card-${(p.name || p.codes[0] || 'driver').replace(/[\\/:*?"<>|]/g, '')}.png`; a.click(); URL.revokeObjectURL(a.href); }, 'image/png');
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
  $('dlgBody').innerHTML = `<h2>เรื่อง ${c.id.slice(0, 8).toUpperCase()}</h2>
    <dl class="detail">
      ${row('วันที่แจ้ง', fmt(c.created_at))}${row('อู่', esc(gName(c.garage_id)))}${row('ทะเบียน', esc(c.plate))}
      ${row('ผู้แจ้ง', `${esc(c.reporter_name)} (${REPORTER[c.reporter_type]})`)}${row('เบอร์โทร', `<a href="tel:${esc(c.contact_phone)}">${esc(c.contact_phone)}</a>`)}
      ${row('ชื่อคนขับ', esc(c.driver_name || '-'))}${row('รหัสคนขับ', esc(c.driver_code || '-'))}
      ${row('เลขบัตร', c.national_id_last4 ? `<span id="nidVal">*********${esc(c.national_id_last4)}</span> <button type="button" class="ghost small" id="revealBtn">แสดงเลขเต็ม</button>` : '-')}
    </dl>
    <h3>รายละเอียด</h3><p class="prewrap">${esc(c.detail)}</p>
    <h3>ไฟล์แนบ</h3>${links.length ? `<ul>${links.join('')}</ul>` : '<p class="muted">ไม่มีไฟล์แนบ</p>'}
    <div class="row"><label>สถานะ <select id="dStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
    ${S.isAdmin ? `<div class="row move"><label>ย้ายไปอู่ <select id="dGarage">${S.garages.filter((g) => g.id !== c.garage_id).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
      <label>เหตุผล <input id="dReason" maxlength="200"></label><button type="button" id="dMove" class="ghost">ย้ายอู่</button></div>` : ''}
    <div class="row end"><button type="button" id="dClose" class="ghost">ปิด</button></div>`;
  $('dlg').showModal();
  $('dClose').onclick = () => $('dlg').close();
  $('dStatus').onchange = async (e) => {
    const { error } = await sb.rpc('set_complaint_status', { p_complaint_id: id, p_status: e.target.value });
    if (error) return toast(errMsg(error));
    c.status = e.target.value; toast('เปลี่ยนสถานะแล้ว'); if (S.tab === 'complaints') $('fStatus').dispatchEvent(new Event('change'));
  };
  if ($('revealBtn')) $('revealBtn').onclick = async () => {
    if (!confirm('การเปิดดูเลขบัตรเต็มจะถูกบันทึกในประวัติ ต้องการดำเนินการต่อหรือไม่?')) return;
    const { data, error } = await sb.rpc('reveal_national_id', { p_complaint_id: id });
    if (error) return toast(errMsg(error));
    $('nidVal').textContent = data || '-'; $('revealBtn').remove();
  };
  if ($('dMove')) $('dMove').onclick = async () => {
    const { error } = await sb.rpc('move_complaint', { p_complaint_id: id, p_garage_id: $('dGarage').value, p_reason: $('dReason').value });
    if (error) return toast(errMsg(error));
    toast('ย้ายอู่แล้ว'); $('dlg').close(); go(S.tab);
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
  const d = e.target.closest('[data-open],[data-card],[data-grename],[data-gtoggle],[data-upass],[data-utoggle]')?.dataset;
  if (!d) return;
  if (d.open) return openComplaint(d.open);
  if (d.card != null) return downloadCard(S.cards[+d.card]);
  if (d.grename) {
    const g = S.garages.find((x) => x.id === d.grename);
    return openForm('แก้ชื่ออู่', 'ชื่ออู่', 'บันทึก', async (v) => {
      const { error } = await sb.from('garages').update({ name: v.trim() }).eq('id', g.id);
      if (error) return toast(error.code === '23505' ? 'มีอู่ชื่อนี้แล้ว' : errMsg(error));
      $('dlg').close(); go('garages');
    }, { value: g.name });
  }
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
    go('users');
  }
});
$('view').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.open) openComplaint(e.target.dataset.open); });

boot();
