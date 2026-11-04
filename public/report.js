// ฟอร์มแจ้งเรื่อง — ตรวจข้อมูลฝั่งนี้เพื่อบอกผู้ใช้เร็วขึ้น ส่วนการตรวจจริงอยู่ที่ submit_complaint
const $ = (id) => document.getElementById(id);
const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024, MAX_IMAGE_PX = 1600;
const cfg = window.TR_CONFIG || {};
const sb = cfg.url && cfg.key && window.supabase ? window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } }) : null;

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

function validate() {
  if (!$('garage').value) return 'กรุณาเลือกอู่';
  if ($('plate').value.trim().length < 2) return 'กรุณากรอกทะเบียนรถ';
  if ($('detail').value.trim().length < 10) return 'กรุณาเล่ารายละเอียดอย่างน้อย 10 ตัวอักษร';
  if (!$('incidentDate').value) return 'กรุณาเลือกวันเกิดเหตุ';
  if ($('incidentDate').value > today()) return 'วันเกิดเหตุต้องไม่เกินวันนี้';
  if ($('reporterName').value.trim().length < 2) return 'กรุณากรอกชื่อผู้แจ้งหรือชื่ออู่';
  if (!/^0\d{8,9}$/.test($('phone').value.replace(/\D/g, ''))) return 'เบอร์โทรผู้แจ้งไม่ถูกต้อง';
  const nid = $('nid').value.replace(/\D/g, '');
  if (nid && !validThaiId(nid)) return 'เลขบัตรประชาชนไม่ถูกต้อง';
  const files = [...$('files').files];
  if (files.length > MAX_FILES) return `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์`;
  if (files.some((f) => !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.type))) return 'รองรับเฉพาะรูปและไฟล์ PDF';
  if (files.some((f) => f.type === 'application/pdf' && f.size > MAX_BYTES)) return 'ไฟล์ PDF ต้องไม่เกิน 10 MB';
  if (!$('consent').checked) return 'กรุณายอมรับเงื่อนไขการเก็บข้อมูล';
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
  for (const original of $('files').files) {
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

async function loadGarages() {
  const sel = $('garage');
  if (!sb) { sel.innerHTML = '<option value="">ยังไม่พร้อมใช้งาน</option>'; notice('ระบบยังไม่พร้อมใช้งาน'); return; }
  const { data, error } = await sb.from('garages').select('id,name').eq('is_active', true).order('sort_order').order('name');
  if (error) { sel.innerHTML = '<option value="">โหลดไม่สำเร็จ</option>'; notice('โหลดรายชื่ออู่ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); return; }
  sel.innerHTML = '<option value="">เลือกอู่</option>';
  for (const g of data) { const o = new Option(g.name, g.id); sel.add(o); }
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
    const { data, error } = await sb.rpc('submit_complaint', {
      p_garage_id: $('garage').value,
      p_reporter_type: document.querySelector('input[name=reporter]:checked').value,
      p_reporter_name: $('reporterName').value,
      p_reporter_last_name: $('reporterLastName').value,
      p_incident_date: $('incidentDate').value,
      p_driver_name: $('driverName').value,
      p_driver_code: $('driverCode').value,
      p_national_id: $('nid').value,
      p_plate: $('plate').value,
      p_detail: $('detail').value,
      p_contact_phone: $('phone').value,
      p_consent: $('consent').checked,
      p_files: files,
      p_website: $('website').value,
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
  $('form').reset();
  $('done').hidden = true; $('form').hidden = false;
});

$('incidentDate').max = today();
loadGarages();
