-- เลขอ้างอิง = รหัสอู่ + เดือน + วัน ตามเวลาไทยของวันรีพอร์ต เช่น TN1104 · เรื่องถัดไปในวันเดียวกัน TN1104-2
-- ใช้ตัวนับแยก เพื่อไม่ให้เลขซ้ำแม้มีการลบเรื่อง · ย้ายอู่แล้วเลขเดิมคงไว้เพราะผู้แจ้งถือเลขนี้อยู่

alter table public.garages add column code text check (code ~ '^[A-Z0-9]{2,6}$');
create unique index garages_code_uniq on public.garages (code);
with n as (select id, row_number() over (order by created_at) r from public.garages)
update public.garages g set code = 'G' || n.r from n where n.id = g.id;

alter table public.complaints add column ref_no text;
create index complaints_ref_idx on public.complaints (ref_no);

create table private.ref_counter (
  garage_id uuid not null references public.garages(id) on delete cascade,
  ref_date date not null,
  n int not null,
  primary key (garage_id, ref_date)
);

create function private.next_ref(p_garage uuid, p_at timestamptz) returns text
language plpgsql security definer set search_path = '' as $$
declare v_date date := (p_at at time zone 'Asia/Bangkok')::date; v_n int; v_code text;
begin
  select coalesce(code, 'XX') into v_code from public.garages where id = p_garage;
  insert into private.ref_counter as c values (p_garage, v_date, 1)
  on conflict (garage_id, ref_date) do update set n = c.n + 1 returning n into v_n;
  return v_code || to_char(v_date, 'MMDD') || case when v_n > 1 then '-' || v_n else '' end;
end $$;
revoke all on function private.next_ref(uuid, timestamptz) from public, anon, authenticated;

create function private.set_ref_no() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.ref_no := private.next_ref(new.garage_id, new.created_at);
  return new;
end $$;
revoke all on function private.set_ref_no() from public, anon, authenticated;
create trigger complaints_ref before insert on public.complaints for each row execute function private.set_ref_no();

do $$ declare r record; begin
  for r in select id, garage_id, created_at from public.complaints order by created_at loop
    update public.complaints set ref_no = private.next_ref(r.garage_id, r.created_at) where id = r.id;
  end loop;
end $$;

-- ฟอร์มสาธารณะขอเลขอ้างอิงจาก id ที่เพิ่งได้รับ (uuid เดาไม่ได้ และคืนแค่เลขอ้างอิง)
create function public.complaint_ref(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select ref_no from public.complaints where id = p_id;
$$;
revoke all on function public.complaint_ref(uuid) from public, anon, authenticated;
grant execute on function public.complaint_ref(uuid) to anon, authenticated;
