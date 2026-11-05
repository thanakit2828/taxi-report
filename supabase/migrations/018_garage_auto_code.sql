-- รหัสอู่ออกอัตโนมัติ A1..A9, B1..B9 ไปเรื่อยๆ · เลขอ้างอิงเดิมคงเลขเดิม เรื่องใหม่ใช้รหัสใหม่
update public.garages set code = 'A1' where code = 'G1';
update public.garages set code = 'A2' where code = 'G2';
create unique index garages_code_key on public.garages (code);

-- ลำดับที่ 0 = A1, 8 = A9, 9 = B1, 233 = Z9, 234 = AA1
create function private.garage_code_at(p_n int) returns text
language plpgsql immutable set search_path to '' as $$
declare v_k int := p_n / 9 + 1; v_s text := '';
begin
  while v_k > 0 loop
    v_k := v_k - 1;
    v_s := chr(65 + v_k % 26) || v_s;
    v_k := v_k / 26;
  end loop;
  return v_s || (p_n % 9 + 1);
end $$;

create function private.next_garage_code() returns text
language plpgsql security definer set search_path to '' as $$
declare v_n int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('garage_code'));   -- กันเพิ่มอู่พร้อมกันแล้วได้รหัสซ้ำ
  while exists (select 1 from public.garages where code = private.garage_code_at(v_n)) loop
    v_n := v_n + 1;
  end loop;
  return private.garage_code_at(v_n);
end $$;
revoke all on function private.garage_code_at(int), private.next_garage_code() from public;

create function public.admin_create_garage(p_name text, p_address text, p_contact_person text, p_contact_number text, p_username text, p_password text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_g uuid; v_u uuid;
begin
  perform private.require_admin();
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'กรุณากรอกชื่ออู่' using errcode = 'P0001'; end if;
  if exists (select 1 from public.garages where name = btrim(p_name)) then raise exception 'ชื่ออู่นี้มีอยู่แล้ว' using errcode = 'P0001'; end if;
  insert into public.garages (name, code, address, contact_person, contact_number)
  values (btrim(p_name), private.next_garage_code(), nullif(btrim(coalesce(p_address,'')),''), nullif(btrim(coalesce(p_contact_person,'')),''), nullif(btrim(coalesce(p_contact_number,'')),''))
  returning id into v_g;
  v_u := private.create_login(p_username, p_password, v_g);
  insert into public.audit_log (actor, action, detail) values (auth.uid(), 'create_user', jsonb_build_object('user_id', v_u, 'username', btrim(p_username), 'garage_id', v_g));
  return v_g;
end $$;
revoke all on function public.admin_create_garage(text,text,text,text,text,text) from public, anon;
grant execute on function public.admin_create_garage(text,text,text,text,text,text) to authenticated;
