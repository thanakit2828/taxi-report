-- ชื่อผู้ใช้ตั้งอะไรก็ได้ (ไทย/เว้นวรรค) · ข้อมูลอู่เพิ่ม: ที่อยู่ เบอร์ รายละเอียด

alter table public.garages add column address text, add column phone text, add column detail text;

-- ฟอร์มสาธารณะอ่านได้แค่ชื่ออู่ ข้อมูลติดต่ออู่ต้อง login
revoke select on public.garages from anon;
grant select (id, name, is_active, sort_order) on public.garages to anon;

-- ชื่อที่ไม่ใช่รูปแบบเดิม แปลงเป็นอีเมลภายในด้วย hash (ตรงกับ toEmail ใน admin.js) ไม่ต้องค้นชื่อก่อน login
create function private.login_email(p_username text) returns text
language sql immutable set search_path = '' as $$
  select case when v ~ '^[a-z0-9._-]{3,30}$' then v
              else 'u-' || left(encode(extensions.digest(v, 'sha256'), 'hex'), 32) end || '@taxi-report.local'
  from (select normalize(lower(btrim(coalesce(p_username,''))), NFC) as v) t;
$$;
revoke all on function private.login_email(text) from public, anon, authenticated;

create or replace function private.create_login(p_username text, p_password text, p_garage_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_user text := normalize(lower(btrim(coalesce(p_username,''))), NFC);
  v_email text;
begin
  if char_length(v_user) not between 2 and 50 then
    raise exception 'ชื่อผู้ใช้ต้องยาว 2–50 ตัวอักษร' using errcode = 'P0001'; end if;
  perform private.check_password(p_password);
  v_email := private.login_email(v_user);
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'ชื่อผู้ใช้นี้มีอยู่แล้ว' using errcode = 'P0001'; end if;
  if p_garage_id is not null and not exists (select 1 from public.garages where id = p_garage_id) then
    raise exception 'ไม่พบอู่' using errcode = 'P0001'; end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', btrim(p_username)), now(), now(),
    '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now());
  insert into public.garage_members (user_id, garage_id, role)
  values (v_id, p_garage_id, case when p_garage_id is null then 'admin' else 'owner' end);
  return v_id;
end $$;

create or replace function public.admin_list_users()
returns table (user_id uuid, username text, role text, garage_id uuid, garage_name text, active boolean, last_sign_in_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
    select u.id, coalesce(u.raw_user_meta_data->>'username', split_part(u.email::text, '@', 1)), m.role, m.garage_id, g.name,
           (u.banned_until is null or u.banned_until < now()), u.last_sign_in_at, u.created_at
    from public.garage_members m join auth.users u on u.id = m.user_id
    left join public.garages g on g.id = m.garage_id
    order by m.role, g.name nulls first, u.email;
end $$;
