-- รันหลัง deploy หน้าเว็บที่ใช้ list_complaints แล้วเท่านั้น: ปิดการอ่านตารางตรง บัญชีอู่จึงดึงข้อมูลอู่อื่นเองไม่ได้
drop policy complaints_read on public.complaints;
create policy complaints_read on public.complaints for select to authenticated using (private.can_see_garage(garage_id));
drop policy garages_read on public.garages;
create policy garages_read on public.garages for select to authenticated using (private.can_see_garage(id) and (is_active or private.is_admin()));
