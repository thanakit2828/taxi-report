-- ฟอร์มไม่ถามชื่อ/เบอร์ผู้แจ้ง และไม่มีการติ๊กยินยอม (พี่ลพสั่ง 2026-11-04) · ข้อมูลเรื่องเก่าคงไว้
-- รุ่นเก่าคงไว้ให้หน้าเว็บที่ยังไม่ deploy แล้วลบใน 014
alter table public.complaints alter column reporter_name drop not null, alter column contact_phone drop not null, alter column consent_at drop not null;

create function public.submit_complaint(
  p_garage_id uuid, p_incident_date date, p_driver_name text, p_driver_code text, p_national_id text,
  p_driver_phone text, p_driver_line_id text, p_detail text,
  p_files jsonb default '[]'::jsonb, p_website text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_ip text; v_ip_key text;
  v_nid text := nullif(regexp_replace(coalesce(p_national_id,''), '[^0-9]', '', 'g'), '');
  v_code text := nullif(upper(btrim(coalesce(p_driver_code,''))), '');
  v_name text := nullif(btrim(coalesce(p_driver_name,'')), '');
  v_drv_phone text := nullif(regexp_replace(coalesce(p_driver_phone,''), '[^0-9]', '', 'g'), '');
  v_line text := nullif(btrim(coalesce(p_driver_line_id,'')), '');
  v_detail text := btrim(coalesce(p_detail,''));
  f jsonb;
begin
  -- ช่องกับดักบอต: มีค่า = ตอบเหมือนสำเร็จ แต่ไม่บันทึก
  if coalesce(p_website,'') <> '' then return v_id; end if;

  if not exists (select 1 from public.garages where id = p_garage_id and is_active) then
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
  if v_nid is not null and not private.valid_thai_id(v_nid) then
    raise exception 'เลขบัตรประชาชนไม่ถูกต้อง' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 5 then
    raise exception 'แนบไฟล์ได้ไม่เกิน 5 ไฟล์' using errcode = 'P0001'; end if;

  -- จำกัด 5 เรื่อง/ชั่วโมง ต่อ IP และ 200 เรื่อง/ชั่วโมง ทั้งระบบ
  v_ip := split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip',
    nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for',
    'unknown'), ',', 1);
  v_ip_key := private.hmac_key('ip:' || v_ip);
  delete from private.submit_rate where at < now() - interval '1 day';
  if (select count(*) from private.submit_rate where ip_key = v_ip_key and at > now() - interval '1 hour') >= 5
     or (select count(*) from private.submit_rate where at > now() - interval '1 hour') >= 200 then
    raise exception 'ส่งเรื่องบ่อยเกินไป กรุณาลองใหม่ภายหลัง' using errcode = 'P0001';
  end if;
  insert into private.submit_rate (ip_key) values (v_ip_key);

  insert into public.complaints (id, garage_id, reporter_type, incident_date, driver_name, driver_code, national_id_last4,
    driver_phone, driver_line_id, detail, person_nid_key, person_code_key)
  values (v_id, p_garage_id, 'garage_staff', p_incident_date, v_name, v_code, right(v_nid, 4),
    v_drv_phone, v_line, v_detail,
    case when v_nid is not null then private.hmac_key('nid:' || v_nid) end,
    case when v_code is not null then private.hmac_key('code:' || p_garage_id || ':' || v_code) end);
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

create function public.update_complaint(
  p_complaint_id uuid, p_incident_date date, p_driver_name text,
  p_driver_code text, p_driver_phone text, p_driver_line_id text, p_detail text, p_status text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.complaints;
  v_name text := nullif(btrim(coalesce(p_driver_name,'')), '');
  v_code text := nullif(upper(btrim(coalesce(p_driver_code,''))), '');
  v_drv_phone text := nullif(regexp_replace(coalesce(p_driver_phone,''), '[^0-9]', '', 'g'), '');
  v_line text := nullif(btrim(coalesce(p_driver_line_id,'')), '');
  v_detail text := btrim(coalesce(p_detail,''));
  v_changed text[];
begin
  select * into o from public.complaints where id = p_complaint_id for update;
  if o.id is null or not private.can_see_garage(o.garage_id) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if p_incident_date is not null and p_incident_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'วันเกิดเหตุต้องไม่เกินวันนี้' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_name,'')) > 100 or char_length(coalesce(v_code,'')) > 30 then raise exception 'ชื่อหรือรหัสคนขับยาวเกินไป' using errcode = 'P0001'; end if;
  if v_drv_phone is not null and v_drv_phone !~ '^0[0-9]{8,9}$' then raise exception 'เบอร์มือถือคนขับไม่ถูกต้อง' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_line,'')) > 50 then raise exception 'Line ID ยาวเกินไป' using errcode = 'P0001'; end if;
  if char_length(v_detail) not between 10 and 2000 then raise exception 'รายละเอียดต้องยาว 10–2,000 ตัวอักษร' using errcode = 'P0001'; end if;
  if p_status not in ('new','in_progress','closed') then raise exception 'สถานะไม่ถูกต้อง' using errcode = 'P0001'; end if;

  v_changed := array_remove(array[
    case when p_incident_date is distinct from o.incident_date then 'incident_date' end,
    case when v_name is distinct from o.driver_name then 'driver_name' end,
    case when v_code is distinct from o.driver_code then 'driver_code' end,
    case when v_drv_phone is distinct from o.driver_phone then 'driver_phone' end,
    case when v_line is distinct from o.driver_line_id then 'driver_line_id' end,
    case when v_detail is distinct from o.detail then 'detail' end,
    case when p_status is distinct from o.status then 'status' end], null);
  if cardinality(v_changed) = 0 then return; end if;

  update public.complaints set incident_date = p_incident_date,
    driver_name = v_name, driver_code = v_code, driver_phone = v_drv_phone, driver_line_id = v_line, detail = v_detail, status = p_status,
    person_code_key = case when v_code is not null then private.hmac_key('code:' || o.garage_id || ':' || v_code) end
  where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'edit_complaint', p_complaint_id, jsonb_build_object('fields', v_changed));
end $$;

revoke all on function public.submit_complaint(uuid,date,text,text,text,text,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.submit_complaint(uuid,date,text,text,text,text,text,text,jsonb,text) to anon, authenticated;
revoke all on function public.update_complaint(uuid,date,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.update_complaint(uuid,date,text,text,text,text,text,text) to authenticated;
