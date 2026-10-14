-- 客户改成「QQ 号 + 密码」登录：初始密码统一 123456，本人第一次进去必须先换成自己的。
-- 只存 PBKDF2 哈希，不存明文；这一列还是空的时候，就说明对方仍在用初始密码，后台要能看出来。
ALTER TABLE customers ADD COLUMN password_hash TEXT;
