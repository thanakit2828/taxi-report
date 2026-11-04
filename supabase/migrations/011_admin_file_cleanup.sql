-- การลบไฟล์ต้องมองเห็นไฟล์ก่อน แต่ delete_complaint ลบแถวไฟล์แนบไปแล้ว ผู้ดูแลจึงต้องอ่านไฟล์ได้โดยไม่ผูกกับแถวนั้น
create policy files_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'complaint-files' and private.is_admin());
