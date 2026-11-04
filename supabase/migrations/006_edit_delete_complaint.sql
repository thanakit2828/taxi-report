-- ไอคอนแก้ไข/ลบในตาราง: แก้ได้เฉพาะอู่เจ้าของเรื่อง+ผู้ดูแล · ลบได้เฉพาะผู้ดูแล (กันอู่ลบเรื่องร้องเรียนของตัวเอง)
-- บันทึกประวัติเฉพาะชื่อช่องที่เปลี่ยน ไม่เก็บค่าข้อมูลส่วนบุคคลซ้ำใน audit_log

create function public.update_complaint(
  p_complaint_id uuid, p_reporter_name text, p_reporter_last_name text, p_contact_phone text, p_incident_date date,
  p_driver_code text, p_plate text, p_detail text, p_status text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.complaints;
  v_reporter text := btrim(coalesce(p_reporter_name,''));
  v_last text := nullif(btrim(coalesce(p_reporter_last_name,'')), '');
  v_phone text := regexp_replace(coalesce(p_contact_phone,''), '[^0-9]', '', 'g');
  v_code text := nullif(upper(btrim(coalesce(p_driver_code,''))), '');
  v_plate text := upper(btrim(coalesce(p_plate,'')));
  v_detail text := btrim(coalesce(p_detail,''));
  v_changed text[];
begin
  select * into o from public.complaints where id = p_complaint_id for update;
  if o.id is null or not private.can_see_garage(o.garage_id) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if char_length(v_reporter) not between 2 and 100 then raise exception 'กรุณากรอกชื่อผู้แจ้งหรือชื่ออู่' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_last,'')) > 100 then raise exception 'นามสกุลยาวเกินไป' using errcode = 'P0001'; end if;
  if v_phone !~ '^0[0-9]{8,9}$' then raise exception 'เบอร์โทรไม่ถูกต้อง' using errcode = 'P0001'; end if;
  if p_incident_date is not null and p_incident_date > (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'วันเกิดเหตุต้องไม่เกินวันนี้' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_code,'')) > 30 then raise exception 'รหัสคนขับยาวเกินไป' using errcode = 'P0001'; end if;
  if char_length(v_plate) not between 2 and 20 then raise exception 'กรุณากรอกทะเบียนรถ' using errcode = 'P0001'; end if;
  if char_length(v_detail) not between 10 and 2000 then raise exception 'รายละเอียดต้องยาว 10–2,000 ตัวอักษร' using errcode = 'P0001'; end if;
  if p_status not in ('new','in_progress','closed') then raise exception 'สถานะไม่ถูกต้อง' using errcode = 'P0001'; end if;

  v_changed := array_remove(array[
    case when v_reporter is distinct from o.reporter_name then 'reporter_name' end,
    case when v_last is distinct from o.reporter_last_name then 'reporter_last_name' end,
    case when v_phone is distinct from o.contact_phone then 'contact_phone' end,
    case when p_incident_date is distinct from o.incident_date then 'incident_date' end,
    case when v_code is distinct from o.driver_code then 'driver_code' end,
    case when v_plate is distinct from o.plate then 'plate' end,
    case when v_detail is distinct from o.detail then 'detail' end,
    case when p_status is distinct from o.status then 'status' end], null);
  if cardinality(v_changed) = 0 then return; end if;

  update public.complaints set reporter_name = v_reporter, reporter_last_name = v_last, contact_phone = v_phone,
    incident_date = p_incident_date, driver_code = v_code, plate = v_plate, detail = v_detail, status = p_status,
    person_code_key = case when v_code is not null then private.hmac_key('code:' || o.garage_id || ':' || v_code) end
  where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'edit_complaint', p_complaint_id, jsonb_build_object('fields', v_changed));
end $$;

-- คืน path ไฟล์แนบให้หน้าเว็บลบออกจาก storage ต่อ (ลบไฟล์จาก SQL โดยตรงไม่ได้)
create function public.delete_complaint(p_complaint_id uuid) returns text[]
language plpgsql security definer set search_path = '' as $$
declare v_paths text[]; v_garage uuid;
begin
  if not private.is_admin() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select garage_id into v_garage from public.complaints where id = p_complaint_id for update;
  if v_garage is null then raise exception 'ไม่พบเรื่องนี้' using errcode = 'P0001'; end if;
  select coalesce(array_agg(storage_path), '{}') into v_paths from public.complaint_attachments where complaint_id = p_complaint_id;
  delete from public.complaints where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'delete_complaint', p_complaint_id, jsonb_build_object('garage_id', v_garage));
  return v_paths;
end $$;

create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'complaint-files' and private.is_admin());

revoke all on function public.update_complaint(uuid,text,text,text,date,text,text,text,text), public.delete_complaint(uuid) from public, anon, authenticated;
grant execute on function public.update_complaint(uuid,text,text,text,date,text,text,text,text), public.delete_complaint(uuid) to authenticated;
