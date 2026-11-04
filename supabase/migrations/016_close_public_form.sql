-- รันหลัง deploy หน้าเว็บที่ใช้ submit_garage_complaint แล้วเท่านั้น: ปิดการส่งเรื่องโดยไม่ login
drop function public.submit_complaint(uuid,date,text,text,text,text,text,text,jsonb,text);
revoke execute on function public.complaint_ref(uuid) from anon;
revoke select on public.garages from anon;
drop policy garages_read on public.garages;
create policy garages_read on public.garages for select to authenticated using (is_active or private.is_admin());
drop policy files_upload on storage.objects;
create policy files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'complaint-files' and name ~ '^incoming/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$');
