-- รันหลัง deploy หน้าเว็บที่ใช้ฟอร์ม 013 แล้วเท่านั้น
drop function public.submit_complaint(uuid,date,text,text,text,text,text,text,text,text,boolean,jsonb,text);
drop function public.update_complaint(uuid,text,text,date,text,text,text,text,text,text);
