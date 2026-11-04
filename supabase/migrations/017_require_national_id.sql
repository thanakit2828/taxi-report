-- ฟอร์มบังคับกรอกเลขบัตรประชาชนคนขับ (พี่ลพสั่ง 2026-11-04) · เรื่องเก่าที่ไม่มีเลขคงไว้
create or replace function public.submit_garage_complaint(
  p_garage_id uuid, p_incident_date date, p_driver_name text, p_driver_code text, p_national_id text,
  p_driver_phone text, p_driver_line_id text, p_detail text,
  p_files jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_rate_key text;
  v_role text; v_own uuid; v_garage uuid;
  v_nid text := nullif(regexp_replace(coalesce(p_national_id,''), '[^0-9]', '', 'g'), '');
  v_code text := nullif(upper(btrim(coalesce(p_driver_code,''))), '');
  v_name text := nullif(btrim(coalesce(p_driver_name,'')), '');
  v_drv_phone text := nullif(regexp_replace(coalesce(p_driver_phone,''), '[^0-9]', '', 'g'), '');
  v_line text := nullif(btrim(coalesce(p_driver_line_id,'')), '');
  v_detail text := btrim(coalesce(p_detail,''));
  f jsonb;
begin
  -- ต้อง login · บัญชีอู่ใช้อู่ของตัวเองเสมอ ค่าที่ส่งมาไม่มีผล · ผู้ดูแลเท่านั้นที่เลือกอู่ได้
  select m.role, m.garage_id into v_role, v_own from public.garage_members m join auth.users u on u.id = m.user_id
   where m.user_id = auth.uid() and (u.banned_until is null or u.banned_until < now()) order by m.role desc limit 1;
  if v_role is null then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  v_garage := case when v_role = 'admin' then p_garage_id else v_own end;
  if not exists (select 1 from public.garages where id = v_garage and is_active) then
    raise exception 'กรุณาเลือกอู่' using errcode = 'P0001'; end if;
  if p_incident_date is null then raise exception 'กรุณาเลือกวันเกิดเหตุ' using errcode = 'P0001'; end if;
  if p_incident_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'วันเกิดเหตุต้องไม่เกินวันนี้' using errcode = 'P0001'; end if;
  if v_drv_phone is not null and v_drv_phone !~ '^0[0-9]{8,9}$' then raise exception 'เบอร์มือถือคนขับไม่ถูกต้อง' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_line,'')) > 50 then raise exception 'Line ID ยาวเกินไป' using errcode = 'P0001'; end if;
  if char_length(v_detail) not between 10 and 2000 then
    raise exception 'รายละเอียดต้องยาว 10–2,000 ตัวอักษร' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_name,'')) > 100 or char_length(coalesce(v_code,'')) > 30 then
    raise exception 'ชื่อหรือรหัสคนขับยาวเกินไป' using errcode = 'P0001'; end if;
  if v_nid is null then raise exception 'กรุณากรอกเลขบัตรประชาชนคนขับ' using errcode = 'P0001'; end if;
  if not private.valid_thai_id(v_nid) then
    raise exception 'เลขบัตรประชาชนไม่ถูกต้อง' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 5 then
    raise exception 'แนบไฟล์ได้ไม่เกิน 5 ไฟล์' using errcode = 'P0001'; end if;

  -- จำกัด 60 เรื่อง/ชั่วโมง ต่อบัญชี กันกดซ้ำ
  v_rate_key := private.hmac_key('user:' || auth.uid());
  delete from private.submit_rate where at < now() - interval '1 day';
  if (select count(*) from private.submit_rate where ip_key = v_rate_key and at > now() - interval '1 hour') >= 60 then
    raise exception 'ส่งเรื่องบ่อยเกินไป กรุณาลองใหม่ภายหลัง' using errcode = 'P0001';
  end if;
  insert into private.submit_rate (ip_key) values (v_rate_key);

  insert into public.complaints (id, garage_id, reporter_type, incident_date, driver_name, driver_code, national_id_last4,
    driver_phone, driver_line_id, detail, person_nid_key, person_code_key, created_by)
  values (v_id, v_garage, 'garage_staff', p_incident_date, v_name, v_code, right(v_nid, 4),
    v_drv_phone, v_line, v_detail,
    case when v_nid is not null then private.hmac_key('nid:' || v_nid) end,
    case when v_code is not null then private.hmac_key('code:' || v_garage || ':' || v_code) end, auth.uid());
  if v_nid is not null then insert into private.complaint_pii values (v_id, v_nid); end if;

  -- รับเฉพาะไฟล์ที่อัปโหลดเข้าที่พักชั่วคราวจริง
  for f in select * from jsonb_array_elements(p_files) loop
    if f->>'path' !~ '^incoming/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'
       or not exists (select 1 from storage.objects where bucket_id = 'complaint-files' and name = f->>'path') then
      raise exception 'ไฟล์แนบไม่ถูกต้อง' using errcode = 'P0001';
    end if;
    insert into public.complaint_attachments (complaint_id, storage_path, file_name, mime_type)
    values (v_id, f->>'path', left(coalesce(f->>'name','file'), 200), left(coalesce(f->>'mime','application/octet-stream'), 100));
  end loop;
  return v_id;
end $$;
