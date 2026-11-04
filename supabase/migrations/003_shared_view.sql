-- ทุกอู่เห็นเรื่องของทุกอู่แบบอ่านอย่างเดียว · เลขบัตรเต็มและการเปลี่ยนสถานะยังจำกัดอู่เจ้าของเรื่อง+ผู้ดูแล (ใช้ can_see_garage เดิม)
-- ฟอร์ม: แยกนามสกุลผู้แจ้ง + เพิ่มวันเกิดเหตุ

alter table public.complaints add column reporter_last_name text, add column incident_date date;

create function private.is_active_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members m join auth.users u on u.id = m.user_id
                 where m.user_id = auth.uid() and (u.banned_until is null or u.banned_until < now()));
$$;
revoke all on function private.is_active_member() from public, anon, authenticated;
grant execute on function private.is_active_member() to authenticated;

drop policy complaints_read on public.complaints;
create policy complaints_read on public.complaints for select to authenticated using (private.is_active_member());
drop policy attachments_read on public.complaint_attachments;
create policy attachments_read on public.complaint_attachments for select to authenticated using (private.is_active_member());
drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated
  using (bucket_id = 'complaint-files' and private.is_active_member() and exists (
    select 1 from public.complaint_attachments a where a.storage_path = name));

-- ฟอร์มรุ่นใหม่ (รุ่นเดิมคงไว้ให้หน้าเว็บที่ยังไม่ deploy · ลบใน 005 หลัง deploy)
create function public.submit_complaint(
  p_garage_id uuid, p_reporter_type text, p_reporter_name text, p_reporter_last_name text, p_incident_date date,
  p_driver_name text, p_driver_code text, p_national_id text, p_plate text, p_detail text, p_contact_phone text,
  p_consent boolean, p_files jsonb default '[]'::jsonb, p_website text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_ip text; v_ip_key text;
  v_nid text := nullif(regexp_replace(coalesce(p_national_id,''), '[^0-9]', '', 'g'), '');
  v_phone text := regexp_replace(coalesce(p_contact_phone,''), '[^0-9]', '', 'g');
  v_code text := nullif(upper(btrim(coalesce(p_driver_code,''))), '');
  v_name text := nullif(btrim(coalesce(p_driver_name,'')), '');
  v_reporter text := btrim(coalesce(p_reporter_name,''));
  v_last text := nullif(btrim(coalesce(p_reporter_last_name,'')), '');
  v_plate text := btrim(coalesce(p_plate,''));
  v_detail text := btrim(coalesce(p_detail,''));
  f jsonb;
begin
  -- ช่องกับดักบอต: มีค่า = ตอบเหมือนสำเร็จ แต่ไม่บันทึก
  if coalesce(p_website,'') <> '' then return v_id; end if;

  if p_consent is not true then raise exception 'กรุณายอมรับเงื่อนไขการเก็บข้อมูล' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.garages where id = p_garage_id and is_active) then
    raise exception 'กรุณาเลือกอู่' using errcode = 'P0001'; end if;
  if p_reporter_type not in ('passenger','garage_staff') then
    raise exception 'กรุณาเลือกประเภทผู้แจ้ง' using errcode = 'P0001'; end if;
  if char_length(v_reporter) not between 2 and 100 then raise exception 'กรุณากรอกชื่อผู้แจ้งหรือชื่ออู่' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_last,'')) > 100 then raise exception 'นามสกุลยาวเกินไป' using errcode = 'P0001'; end if;
  if p_incident_date is null then raise exception 'กรุณาเลือกวันเกิดเหตุ' using errcode = 'P0001'; end if;
  if p_incident_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'วันเกิดเหตุต้องไม่เกินวันนี้' using errcode = 'P0001'; end if;
  if char_length(v_plate) not between 2 and 20 then raise exception 'กรุณากรอกทะเบียนรถ' using errcode = 'P0001'; end if;
  if char_length(v_detail) not between 10 and 2000 then
    raise exception 'รายละเอียดต้องยาว 10–2,000 ตัวอักษร' using errcode = 'P0001'; end if;
  if v_phone !~ '^0[0-9]{8,9}$' then raise exception 'เบอร์ติดต่อไม่ถูกต้อง' using errcode = 'P0001'; end if;
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

  insert into public.complaints (id, garage_id, reporter_type, reporter_name, reporter_last_name, incident_date, driver_name, driver_code, national_id_last4,
    plate, detail, contact_phone, person_nid_key, person_code_key, consent_at)
  values (v_id, p_garage_id, p_reporter_type, v_reporter, v_last, p_incident_date, v_name, v_code, right(v_nid, 4),
    upper(v_plate), v_detail, v_phone,
    case when v_nid is not null then private.hmac_key('nid:' || v_nid) end,
    case when v_code is not null then private.hmac_key('code:' || p_garage_id || ':' || v_code) end,
    now());
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
revoke all on function public.submit_complaint(uuid,text,text,text,date,text,text,text,text,text,text,boolean,jsonb,text) from public, anon, authenticated;
grant execute on function public.submit_complaint(uuid,text,text,text,date,text,text,text,text,text,text,boolean,jsonb,text) to anon, authenticated;
