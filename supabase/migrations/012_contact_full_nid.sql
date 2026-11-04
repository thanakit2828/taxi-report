-- ข้อมูลอู่: ผู้ติดต่อ + เบอร์ติดต่อ · เลขบัตรเต็มเปิดดูได้ทุกบัญชีที่ใช้งานอยู่ (พี่ลพสั่ง 2026-11-04) และยังบันทึกประวัติทุกครั้ง
alter table public.garages add column contact_person text, add column contact_number text;
update public.garages set contact_number = phone where phone is not null;

create or replace function public.reveal_national_id(p_complaint_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_nid text;
begin
  if not private.is_active_member() or not exists (select 1 from public.complaints where id = p_complaint_id) then
    raise exception 'ไม่มีสิทธิ์ดูข้อมูลนี้' using errcode = '42501'; end if;
  select national_id into v_nid from private.complaint_pii where complaint_id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id) values (auth.uid(), 'reveal_national_id', p_complaint_id);
  return v_nid;
end $$;
