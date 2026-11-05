-- ผู้ร้องเรียนใช้ Contact Person/Number ของอู่ ณ วันที่แจ้ง · รันก่อน deploy หน้าเว็บ
create or replace function public.submit_garage_complaint(
  p_garage_id uuid, p_incident_date date, p_driver_name text, p_driver_code text, p_national_id text,
  p_driver_phone text, p_driver_line_id text, p_detail text, p_reporter_name text, p_reporter_phone text, p_files jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path to '' as $$
declare
  v_id uuid;
  v_garage uuid;
  v_ref text;
begin
  v_id := public.submit_garage_complaint(
    p_garage_id => p_garage_id, p_incident_date => p_incident_date, p_driver_name => p_driver_name, p_driver_code => p_driver_code,
    p_national_id => p_national_id, p_driver_phone => p_driver_phone, p_driver_line_id => p_driver_line_id, p_detail => p_detail, p_files => p_files);
  update public.complaints c set reporter_name = g.contact_person, contact_phone = g.contact_number
    from public.garages g where c.id = v_id and g.id = c.garage_id
    returning c.garage_id, c.ref_no into v_garage, v_ref;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'submit_complaint', v_id, jsonb_build_object('garage_id', v_garage, 'ref_no', v_ref));
  return v_id;
end $$;

-- หน้าต่าง View ถามทีละเรื่อง รายการรวมยังไม่ส่งข้อมูลอู่ · เรื่องเก่าที่ไม่มีผู้ร้องเรียนใช้ข้อมูลอู่ปัจจุบัน
create function public.complaint_view_info(p_complaint_id uuid)
returns table (garage_name text, reporter_name text, contact_phone text)
language plpgsql stable security definer set search_path to '' as $$
begin
  if not private.is_active_member() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  return query
    select g.name,
      coalesce(nullif(btrim(concat_ws(' ', c.reporter_name, c.reporter_last_name)), ''), g.contact_person),
      coalesce(c.contact_phone, g.contact_number)
    from public.complaints c join public.garages g on g.id = c.garage_id
    where c.id = p_complaint_id;
end $$;
revoke all on function public.complaint_view_info(uuid) from public, anon;
grant execute on function public.complaint_view_info(uuid) to authenticated;
