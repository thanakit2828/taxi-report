-- แจ้งเรื่องแท็กซี่ — ฐานข้อมูลเริ่มต้น
-- หลักการ: ผู้ส่งเรื่อง (anon) เขียนตารางตรงไม่ได้ ต้องผ่าน submit_complaint เท่านั้น
--          เจ้าของอู่เห็นเฉพาะอู่ตัวเอง · เลขบัตรเต็มเก็บแยก เปิดดูผ่าน reveal_national_id ซึ่งบันทึกประวัติทุกครั้ง

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ── ตาราง ─────────────────────────────────────────────
create table public.garages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.garage_members (
  user_id uuid not null references auth.users(id) on delete cascade,
  garage_id uuid references public.garages(id) on delete cascade,   -- null = ผู้ดูแลระบบ เห็นทุกอู่
  role text not null check (role in ('owner','admin')),
  created_at timestamptz not null default now(),
  check ((role = 'admin') = (garage_id is null))
);
create unique index garage_members_uniq on public.garage_members (user_id, coalesce(garage_id, '00000000-0000-0000-0000-000000000000'));

create table public.complaints (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id),
  reporter_type text not null check (reporter_type in ('passenger','garage_staff')),
  reporter_name text not null,         -- ชื่อผู้แจ้งหรือชื่ออู่
  driver_name text,
  driver_code text,
  national_id_last4 text,              -- หน้ารายการแสดงแค่ 4 ตัวท้าย
  plate text not null,
  detail text not null,
  contact_phone text not null,
  person_nid_key text,                 -- รวมคนจากเลขบัตร (HMAC ย้อนกลับไม่ได้)
  person_code_key text,                -- รวมคนจากรหัสคนขับ ภายในอู่เดียวกัน
  status text not null default 'new' check (status in ('new','in_progress','closed')),
  consent_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index complaints_garage_idx on public.complaints (garage_id, created_at desc);
create index complaints_nid_idx on public.complaints (person_nid_key);
create index complaints_code_idx on public.complaints (person_code_key);

create table public.complaint_attachments (
  id uuid primary key default gen_random_uuid(),
  complaint_id uuid not null references public.complaints(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  complaint_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create table private.complaint_pii (
  complaint_id uuid primary key references public.complaints(id) on delete cascade,
  national_id text not null
);
create table private.secrets (name text primary key, value text not null);
insert into private.secrets values ('person_key', encode(extensions.gen_random_bytes(32), 'hex'));
create table private.submit_rate (ip_key text not null, at timestamptz not null default now());
create index submit_rate_idx on private.submit_rate (ip_key, at);

-- ── ฟังก์ชันช่วย ────────────────────────────────────────
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members where user_id = auth.uid() and role = 'admin');
$$;

create function private.can_see_garage(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members
                 where user_id = auth.uid() and (role = 'admin' or garage_id = g));
$$;

create function private.hmac_key(v text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(v, (select value from private.secrets where name = 'person_key'), 'sha256'), 'hex');
$$;

-- เลขบัตรประชาชนไทย 13 หลัก + ตรวจหลักสุดท้าย
create function private.valid_thai_id(v text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare s int := 0;
begin
  if v !~ '^[0-9]{13}$' then return false; end if;
  for i in 1..12 loop s := s + substr(v, i, 1)::int * (14 - i); end loop;
  return (11 - s % 11) % 10 = substr(v, 13, 1)::int;
end $$;

-- ── ส่งเรื่อง (ทางเดียวที่ผู้ไม่ได้ login เขียนข้อมูลได้) ──
create function public.submit_complaint(
  p_garage_id uuid, p_reporter_type text, p_reporter_name text, p_driver_name text, p_driver_code text,
  p_national_id text, p_plate text, p_detail text, p_contact_phone text,
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

  insert into public.complaints (id, garage_id, reporter_type, reporter_name, driver_name, driver_code, national_id_last4,
    plate, detail, contact_phone, person_nid_key, person_code_key, consent_at)
  values (v_id, p_garage_id, p_reporter_type, v_reporter, v_name, v_code, right(v_nid, 4),
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

-- ── เปิดดูเลขบัตรเต็ม (บันทึกประวัติทุกครั้ง) ────────────
create function public.reveal_national_id(p_complaint_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_nid text; v_garage uuid;
begin
  select garage_id into v_garage from public.complaints where id = p_complaint_id;
  if v_garage is null or not private.can_see_garage(v_garage) then
    raise exception 'ไม่มีสิทธิ์ดูข้อมูลนี้' using errcode = '42501'; end if;
  select national_id into v_nid from private.complaint_pii where complaint_id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id) values (auth.uid(), 'reveal_national_id', p_complaint_id);
  return v_nid;
end $$;

-- ── ย้ายเรื่องที่เลือกอู่ผิด (ผู้ดูแลเท่านั้น) ─────────────
create function public.move_complaint(p_complaint_id uuid, p_garage_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old uuid; v_code text;
begin
  if not private.is_admin() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason,''))) < 3 then raise exception 'กรุณาระบุเหตุผล' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.garages where id = p_garage_id) then raise exception 'ไม่พบอู่' using errcode = 'P0001'; end if;
  select garage_id, driver_code into v_old, v_code from public.complaints where id = p_complaint_id for update;
  if v_old is null then raise exception 'ไม่พบเรื่องนี้' using errcode = 'P0001'; end if;
  update public.complaints set garage_id = p_garage_id,
    person_code_key = case when v_code is not null then private.hmac_key('code:' || p_garage_id || ':' || v_code) end
  where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'move_complaint', p_complaint_id, jsonb_build_object('from', v_old, 'to', p_garage_id, 'reason', p_reason));
end $$;

-- ── RLS ───────────────────────────────────────────────
alter table public.garages enable row level security;
alter table public.garage_members enable row level security;
alter table public.complaints enable row level security;
alter table public.complaint_attachments enable row level security;
alter table public.audit_log enable row level security;

create policy garages_read on public.garages for select to anon, authenticated using (is_active or private.is_admin());
create policy garages_admin on public.garages for all to authenticated using (private.is_admin()) with check (private.is_admin());
create policy members_self on public.garage_members for select to authenticated using (user_id = auth.uid() or private.is_admin());
create policy members_admin on public.garage_members for all to authenticated using (private.is_admin()) with check (private.is_admin());
create policy complaints_read on public.complaints for select to authenticated using (private.can_see_garage(garage_id));
create policy attachments_read on public.complaint_attachments for select to authenticated
  using (exists (select 1 from public.complaints c where c.id = complaint_id and private.can_see_garage(c.garage_id)));
create policy audit_admin on public.audit_log for select to authenticated using (private.is_admin());

-- ── สิทธิ์ ─────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on schema private from anon, authenticated, public;
revoke all on all functions in schema private from anon, authenticated, public;
grant usage on schema private to anon, authenticated;          -- policy ต้องเรียกฟังก์ชันใน schema นี้ได้ (ตารางยังปิดอยู่)
grant execute on function private.is_admin() to anon, authenticated;
grant execute on function private.can_see_garage(uuid) to anon, authenticated;
grant select on public.garages to anon, authenticated;
grant insert, update, delete on public.garages to authenticated;
grant select, insert, update, delete on public.garage_members to authenticated;
grant select on public.complaints, public.complaint_attachments, public.audit_log to authenticated;
grant execute on function public.submit_complaint(uuid,text,text,text,text,text,text,text,text,boolean,jsonb,text) to anon, authenticated;
grant execute on function public.reveal_national_id(uuid), public.move_complaint(uuid,uuid,text) to authenticated;

-- ── ไฟล์แนบ: กล่องส่วนตัว อัปโหลดได้แต่อ่านไม่ได้ถ้าไม่ login ─
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('complaint-files', 'complaint-files', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf']);

create policy files_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'complaint-files' and name ~ '^incoming/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$');
create policy files_read on storage.objects for select to authenticated
  using (bucket_id = 'complaint-files' and exists (
    select 1 from public.complaint_attachments a join public.complaints c on c.id = a.complaint_id
    where a.storage_path = name and private.can_see_garage(c.garage_id)));
