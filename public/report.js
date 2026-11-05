// ฟอร์มแจ้งเรื่อง — ตรวจข้อมูลฝั่งนี้เพื่อบอกผู้ใช้เร็วขึ้น ส่วนการตรวจจริงอยู่ที่ submit_complaint
const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');   // แสดงเต็มกว้างในหน้าจัดการ
const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024, MAX_IMAGE_PX = 1600;
const cfg = window.TR_CONFIG || {};
const sb = cfg.url && cfg.key && window.supabase ? window.supabase.createClient(cfg.url, cfg.key) : null;

function notice(msg) {
  $('notice').textContent = msg || '';
  $('notice').hidden = !msg;
  if (msg) $('notice').scrollIntoView({ block: 'center' });
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

function validThaiId(v) {
  if (!/^\d{13}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +v[i] * (13 - i);
  return (11 - (sum % 11)) % 10 === +v[12];
}

// เก็บไฟล์ไว้เอง เพราะ input ล้างรายการเดิมทุกครั้งที่เลือกใหม่ (โดยเฉพาะบนมือถือ)
let picked = [];
function renderFiles() {
  const box = $('fileList');
  box.hidden = !picked.length;
  box.replaceChildren(...picked.map((f, i) => {
    const li = document.createElement('li'), span = document.createElement('span'), del = document.createElement('button');
    span.textContent = f.name; del.type = 'button'; del.textContent = 'ลบ'; del.setAttribute('aria-label', 'ลบไฟล์ ' + f.name);
    del.onclick = () => { picked.splice(i, 1); renderFiles(); };
    li.append(span, del); return li;
  }));
}
$('files').addEventListener('change', (e) => {
  picked = picked.concat([...e.target.files]); e.target.value = ''; renderFiles();
  if (picked.length > MAX_FILES) notice(`แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์ กรุณาลบออกบางไฟล์`); else notice('');
});

function validate() {
  if (!$('garage').value) return 'กรุณาเลือกอู่';
  if (!$('incidentDate').value) return 'กรุณาเลือกวันเกิดเหตุ';
  if ($('incidentDate').value > today()) return 'วันเกิดเหตุต้องไม่เกินวันนี้';
  const nid = $('nid').value.replace(/\D/g, '');
  if (!nid) return 'กรุณากรอกเลขบัตรประชาชนคนขับ';
  if (!validThaiId(nid)) return 'เลขบัตรประชาชนไม่ถูกต้อง';
  const repPhone = $('reporterPhone').value.replace(/\D/g, '');
  if (repPhone && !/^0\d{8,9}$/.test(repPhone)) return 'เบอร์โทรผู้ร้องเรียนไม่ถูกต้อง';
  const drvPhone = $('driverPhone').value.replace(/\D/g, '');
  if (drvPhone && !/^0\d{8,9}$/.test(drvPhone)) return 'เบอร์มือถือคนขับไม่ถูกต้อง';
  if ($('detail').value.trim().length < 10) return 'กรุณาเล่ารายละเอียดอย่างน้อย 10 ตัวอักษร';
  if (picked.length > MAX_FILES) return `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์`;
  if (picked.some((f) => !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.type))) return 'รองรับเฉพาะรูปและไฟล์ PDF';
  if (picked.some((f) => f.type === 'application/pdf' && f.size > MAX_BYTES)) return 'ไฟล์ PDF ต้องไม่เกิน 10 MB';
  return '';
}

// ย่อรูปก่อนอัปโหลด เพื่อประหยัดพื้นที่ไฟล์ของแพ็กเกจฟรี
async function shrinkImage(file) {
  if (!file.type.startsWith('image/')) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.75));
  if (!blob) throw new Error('shrink failed');
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

async function uploadFiles() {
  const batch = crypto.randomUUID();
  const out = [];
  let i = 0;
  for (const original of picked) {
    i++;
    let file;
    try { file = await shrinkImage(original); } catch { throw new Error('อ่านรูป ' + original.name + ' ไม่ได้'); }
    if (file.size > MAX_BYTES) throw new Error('ไฟล์ ' + original.name + ' ใหญ่เกินไป');
    const ext = (file.name.split('.').pop() || 'bin').replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toLowerCase() || 'bin';
    const path = `incoming/${batch}/${i}.${ext}`;
    const { error } = await sb.storage.from('complaint-files').upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new Error('อัปโหลดไฟล์ ' + original.name + ' ไม่สำเร็จ');
    out.push({ path, name: original.name, mime: file.type });
  }
  return out;
}

// ต้อง login ก่อน · บัญชีอู่ล็อกอู่ตัวเอง · ผู้ดูแลเลือกอู่ได้ (ฐานข้อมูลบังคับซ้ำอีกชั้น)
let myGarage = null;
async function loadGarages() {
  const sel = $('garage');
  if (!sb) { sel.innerHTML = '<option value="">ยังไม่พร้อมใช้งาน</option>'; notice('ระบบยังไม่พร้อมใช้งาน'); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('form').hidden = true; $('needLogin').hidden = false; return; }
  const { data: member } = await sb.from('garage_members').select('role,garage_id').eq('user_id', session.user.id).maybeSingle();
  const { data, error } = await sb.from('garages').select('id,name').eq('is_active', true).order('sort_order').order('name');
  if (error || !member) { sel.innerHTML = '<option value="">โหลดไม่สำเร็จ</option>'; notice('โหลดข้อมูลอู่ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); return; }
  if (member.role !== 'admin') {
    const own = data.find((g) => g.id === member.garage_id);
    if (!own) { sel.innerHTML = '<option value="">อู่นี้ปิดรับเรื่อง</option>'; sel.disabled = true; notice('อู่ของบัญชีนี้ปิดรับเรื่องอยู่ กรุณาติดต่อผู้ดูแล'); $('submit').disabled = true; return; }
    myGarage = own.id; sel.replaceChildren(new Option(own.name, own.id)); sel.value = own.id; sel.disabled = true;
    sel.closest('label').hidden = true;   // บัญชีอู่ใช้อู่ตัวเองเสมอ ไม่ต้องแสดง
    return;
  }
  sel.innerHTML = '<option value="">เลือกอู่</option>';
  for (const g of data) sel.add(new Option(g.name, g.id));
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  notice('');
  const problem = validate();
  if (problem) { notice(problem); return; }
  if (!sb) { notice('ระบบยังไม่พร้อมใช้งาน'); return; }
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'กำลังส่ง…';
  try {
    const files = await uploadFiles();
    const { data, error } = await sb.rpc('submit_garage_complaint', {
      p_garage_id: $('garage').value,
      p_incident_date: $('incidentDate').value,
      p_driver_name: $('driverName').value,
      p_driver_code: null,
      p_national_id: $('nid').value,
      p_driver_phone: $('driverPhone').value,
      p_driver_line_id: $('driverLine').value,
      p_detail: $('detail').value,
      p_reporter_name: $('reporterName').value,
      p_reporter_phone: $('reporterPhone').value,
      p_files: files,
    });
    if (error) throw new Error(error.code === 'P0001' ? error.message : 'ส่งเรื่องไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    const { data: refNo } = await sb.rpc('complaint_ref', { p_id: data });
    $('ref').textContent = refNo || String(data).slice(0, 8).toUpperCase();
    $('form').hidden = true; $('done').hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    notice(err.message || 'ส่งเรื่องไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
  } finally {
    btn.disabled = false; btn.textContent = 'ส่งเรื่อง';
  }
});

$('again').addEventListener('click', () => {
  $('form').reset(); picked = []; renderFiles();
  if (myGarage) $('garage').value = myGarage;
  $('done').hidden = true; $('form').hidden = false;
});

$('incidentDate').max = today();
loadGarages();
