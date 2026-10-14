-- 群主手上有一份攒了很久的客户名单：昵称、QQ、真名。真名是他自己后补的，只用来在后台认人，
-- 不给客户互相看见，所以单独一列，不塞进 note（备注是随手写的杂项）。
ALTER TABLE customers ADD COLUMN real_name TEXT;
