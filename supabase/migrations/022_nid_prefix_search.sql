-- ค้นเลขบัตรจากตัวหน้าทีละตัว ส่งกลับแค่รหัสเรื่อง ไม่ส่งเลขบัตร · ค้นตั้งแต่ 4 หลักลงประวัติ โดยไม่เก็บเลขที่ค้น
create or replace function public.find_complaints_by_nid(p_nid text)
returns setof uuid
language plpgsql security definer set search_path to '' as $$
declare v_nid text := regexp_replace(coalesce(p_nid,''), '[^0-9]', '', 'g');
begin
  if not private.is_active_member() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if char_length(v_nid) not between 1 and 13 then return; end if;
  if char_length(v_nid) >= 4 then
    insert into public.audit_log (actor, action) values (auth.uid(), 'search_national_id');
  end if;
  return query select p.complaint_id from private.complaint_pii p where p.national_id like v_nid || '%';
end $$;
