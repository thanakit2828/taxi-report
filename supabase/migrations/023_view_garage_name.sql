-- พี่ลพเลือกให้หน้าต่าง View แสดงชื่ออู่ทุกเรื่อง · ดึงทีละเรื่องตอนเปิดดู รายการรวมยังไม่ส่งข้อมูลอู่
create function public.complaint_garage_name(p_complaint_id uuid)
returns text
language plpgsql stable security definer set search_path to '' as $$
declare v_name text;
begin
  if not private.is_active_member() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select g.name into v_name from public.complaints c join public.garages g on g.id = c.garage_id where c.id = p_complaint_id;
  return v_name;
end $$;
revoke all on function public.complaint_garage_name(uuid) from public, anon;
grant execute on function public.complaint_garage_name(uuid) to authenticated;
