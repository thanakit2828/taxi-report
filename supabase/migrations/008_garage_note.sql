-- หมายเหตุของอู่ในแต่ละเรื่อง: แก้ได้เฉพาะอู่เจ้าของเรื่อง+ผู้ดูแล · อู่อื่นอ่านได้ตามสิทธิ์อ่านทุกเคส
alter table public.complaints add column garage_note text;

create function public.set_complaint_note(p_complaint_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_garage uuid; v_note text := nullif(btrim(coalesce(p_note,'')), '');
begin
  select garage_id into v_garage from public.complaints where id = p_complaint_id for update;
  if v_garage is null or not private.can_see_garage(v_garage) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if char_length(coalesce(v_note,'')) > 2000 then raise exception 'หมายเหตุยาวเกิน 2,000 ตัวอักษร' using errcode = 'P0001'; end if;
  update public.complaints set garage_note = v_note where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id) values (auth.uid(), 'set_note', p_complaint_id);
end $$;
revoke all on function public.set_complaint_note(uuid,text) from public, anon, authenticated;
grant execute on function public.set_complaint_note(uuid,text) to authenticated;
