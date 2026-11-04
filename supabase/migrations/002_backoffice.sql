-- หลังบ้าน: จัดการผู้ใช้ของอู่ + เปลี่ยนสถานะเรื่อง (ผู้ดูแลเท่านั้น ยกเว้นเปลี่ยนสถานะ)
-- ผู้ใช้ login ด้วยชื่อผู้ใช้ ระบบแปลงเป็นอีเมลภายใน <username>@taxi-report.local (ไม่มีการส่งอีเมล)

-- บัญชีที่ถูกปิดต้องเสียสิทธิ์ทันที แม้ token เดิมยังไม่หมดอายุ
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members m join auth.users u on u.id = m.user_id
                 where m.user_id = auth.uid() and m.role = 'admin'
                   and (u.banned_until is null or u.banned_until < now()));
$$;

create or replace function private.can_see_garage(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members m join auth.users u on u.id = m.user_id
                 where m.user_id = auth.uid() and (m.role = 'admin' or m.garage_id = g)
                   and (u.banned_until is null or u.banned_until < now()));
$$;

create function private.check_password(p text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if char_length(coalesce(p,'')) < 8 then raise exception 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' using errcode = 'P0001'; end if;
  if char_length(p) > 72 then raise exception 'รหัสผ่านยาวเกินไป' using errcode = 'P0001'; end if;
end $$;

-- ใช้ภายใน: สร้างบัญชี login + สมาชิกอู่ (garage null = ผู้ดูแลระบบ)
create function private.create_login(p_username text, p_password text, p_garage_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
  v_user text := lower(btrim(coalesce(p_username,'')));
  v_email text;
begin
  if v_user !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3–30 ตัว' using errcode = 'P0001'; end if;
  perform private.check_password(p_password);
  v_email := v_user || '@taxi-report.local';
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'ชื่อผู้ใช้นี้มีอยู่แล้ว' using errcode = 'P0001'; end if;
  if p_garage_id is not null and not exists (select 1 from public.garages where id = p_garage_id) then
    raise exception 'ไม่พบอู่' using errcode = 'P0001'; end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', v_user), now(), now(),
    '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_id::text, v_id, jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now());
  insert into public.garage_members (user_id, garage_id, role)
  values (v_id, p_garage_id, case when p_garage_id is null then 'admin' else 'owner' end);
  return v_id;
end $$;

create function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
end $$;

create function public.admin_create_user(p_username text, p_password text, p_garage_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_admin();
  v_id := private.create_login(p_username, p_password, p_garage_id);
  insert into public.audit_log (actor, action, detail)
  values (auth.uid(), 'create_user', jsonb_build_object('user_id', v_id, 'username', lower(btrim(p_username)), 'garage_id', p_garage_id));
  return v_id;
end $$;

create function public.admin_list_users()
returns table (user_id uuid, username text, role text, garage_id uuid, garage_name text, active boolean, last_sign_in_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
    select u.id, split_part(u.email::text, '@', 1), m.role, m.garage_id, g.name,
           (u.banned_until is null or u.banned_until < now()), u.last_sign_in_at, u.created_at
    from public.garage_members m join auth.users u on u.id = m.user_id
    left join public.garages g on g.id = m.garage_id
    order by m.role, g.name nulls first, u.email;
end $$;

create function public.admin_set_password(p_user_id uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  perform private.check_password(p_password);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = p_user_id;
  if not found then raise exception 'ไม่พบผู้ใช้' using errcode = 'P0001'; end if;
  delete from auth.sessions where user_id = p_user_id;   -- รหัสเปลี่ยน = ออกจากระบบทุกเครื่อง
  insert into public.audit_log (actor, action, detail) values (auth.uid(), 'set_password', jsonb_build_object('user_id', p_user_id));
end $$;

create function public.admin_set_user_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_user_id = auth.uid() and not p_active then raise exception 'ปิดบัญชีตัวเองไม่ได้' using errcode = 'P0001'; end if;
  update auth.users set banned_until = case when p_active then null else now() + interval '100 years' end, updated_at = now() where id = p_user_id;
  if not found then raise exception 'ไม่พบผู้ใช้' using errcode = 'P0001'; end if;
  if not p_active then delete from auth.sessions where user_id = p_user_id; end if;
  insert into public.audit_log (actor, action, detail) values (auth.uid(), case when p_active then 'enable_user' else 'disable_user' end, jsonb_build_object('user_id', p_user_id));
end $$;

create function public.set_complaint_status(p_complaint_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_garage uuid; v_old text;
begin
  select garage_id, status into v_garage, v_old from public.complaints where id = p_complaint_id for update;
  if v_garage is null or not private.can_see_garage(v_garage) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if p_status not in ('new','in_progress','closed') then raise exception 'สถานะไม่ถูกต้อง' using errcode = 'P0001'; end if;
  update public.complaints set status = p_status where id = p_complaint_id;
  insert into public.audit_log (actor, action, complaint_id, detail)
  values (auth.uid(), 'set_status', p_complaint_id, jsonb_build_object('from', v_old, 'to', p_status));
end $$;

revoke all on function private.check_password(text), private.create_login(text,text,uuid), private.require_admin() from public, anon, authenticated;
revoke all on function public.admin_create_user(text,text,uuid), public.admin_list_users(), public.admin_set_password(uuid,text),
  public.admin_set_user_active(uuid,boolean), public.set_complaint_status(uuid,text) from public, anon, authenticated;
grant execute on function public.admin_create_user(text,text,uuid), public.admin_list_users(), public.admin_set_password(uuid,text),
  public.admin_set_user_active(uuid,boolean), public.set_complaint_status(uuid,text) to authenticated;
