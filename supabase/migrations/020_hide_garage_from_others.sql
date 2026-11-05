-- บัญชีอู่เห็นทุกเรื่องแต่ไม่รู้ว่าของอู่ไหน · ผู้ดูแลเห็นครบ · รันก่อน deploy หน้าเว็บ
-- ข้อมูลที่บอกตัวอู่ได้ (อู่ ผู้ร้องเรียน ผู้สร้าง) ส่งออกเฉพาะเรื่องของอู่ตัวเองหรือผู้ดูแล
create function public.list_complaints()
returns table (
  id uuid, garage_id uuid, is_mine boolean, reporter_name text, reporter_last_name text, contact_phone text,
  driver_name text, driver_code text, driver_phone text, driver_line_id text, national_id_last4 text, person_nid_key text,
  plate text, detail text, garage_note text, status text, incident_date date, created_at timestamptz,
  ref_no text, attachment_count bigint
)
language sql stable security definer set search_path to '' as $$
  select c.id,
    case when v.mine then c.garage_id end,
    v.mine,
    case when v.mine then c.reporter_name end,
    case when v.mine then c.reporter_last_name end,
    case when v.mine then c.contact_phone end,
    c.driver_name, c.driver_code, c.driver_phone, c.driver_line_id, c.national_id_last4, c.person_nid_key,
    c.plate, c.detail, c.garage_note, c.status, c.incident_date, c.created_at, c.ref_no,
    (select count(*) from public.complaint_attachments a where a.complaint_id = c.id)
  from public.complaints c
  cross join lateral (select private.can_see_garage(c.garage_id) as mine) v
  where private.is_active_member();
$$;
revoke all on function public.list_complaints() from public, anon;
grant execute on function public.list_complaints() to authenticated;

-- ค้นจากเลขบัตรเต็มด้วยค่าแฮช เลขเต็มไม่ส่งให้หน้าเว็บ และไม่เก็บเลขที่ค้นลงประวัติ
create function public.find_complaints_by_nid(p_nid text)
returns setof uuid
language plpgsql security definer set search_path to '' as $$
declare v_nid text := regexp_replace(coalesce(p_nid,''), '[^0-9]', '', 'g');
begin
  if not private.is_active_member() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if not private.valid_thai_id(v_nid) then return; end if;
  insert into public.audit_log (actor, action) values (auth.uid(), 'search_national_id');
  return query select c.id from public.complaints c where c.person_nid_key = private.hmac_key('nid:' || v_nid);
end $$;
revoke all on function public.find_complaints_by_nid(text) from public, anon;
grant execute on function public.find_complaints_by_nid(text) to authenticated;

-- ฟอร์มเพิ่มชื่อและเบอร์ผู้ร้องเรียน (ไม่บังคับ) ตรวจเงื่อนไขอื่นต่อที่ฟังก์ชันเดิม · ลงประวัติให้ผู้ดูแลรู้ว่าเลขอ้างอิงมาจากอู่ไหน
create function public.submit_garage_complaint(
  p_garage_id uuid, p_incident_date date, p_driver_name text, p_driver_code text, p_national_id text,
  p_driver_phone text, p_driver_line_id text, p_detail text, p_reporter_name text, p_reporter_phone text, p_files jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path to '' as $$
declare
  v_id uuid;
  v_garage uuid;
  v_ref text;
  v_name text := nullif(btrim(coalesce(p_reporter_name,'')), '');
  v_phone text := nullif(regexp_replace(coalesce(p_reporter_phone,''), '[^0-9]', '', 'g'), '');
begin
  if char_length(coalesce(v_name,'')) > 100 then raise exception 'ชื่อผู้ร้องเรียนยาวเกินไป' using errcode = 'P0001'; end if;
  if v_phone is not null and v_phone !~ '^0[0-9]{8,9}$' then raise exception 'เบอร์โทรผู้ร้องเรียนไม่ถูกต้อง' using errcode = 'P0001'; end if;
  v_id := public.submit_garage_complaint(
    p_garage_id => p_garage_id, p_incident_date => p_incident_date, p_driver_name => p_driver_name, p_driver_code => p_driver_code,
    p_national_id => p_national_id, p_driver_phone => p_driver_phone, p_driver_line_id => p_driver_line_id, p_detail => p_detail, p_files => p_files);
  update public.complaints set reporter_name = v_name, contact_phone = v_phone where id = v_id
    returning garage_id, ref_no into v_garage, v_ref;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'submit_complaint', v_id, jsonb_build_object('garage_id', v_garage, 'ref_no', v_ref));
  return v_id;
end $$;
revoke all on function public.submit_garage_complaint(uuid,date,text,text,text,text,text,text,text,text,jsonb) from public, anon;
grant execute on function public.submit_garage_complaint(uuid,date,text,text,text,text,text,text,text,text,jsonb) to authenticated;
