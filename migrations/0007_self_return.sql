-- 0007：客户可以标成「不拼邮」（自己带回国 / 另找转运）
-- 标了之后：这一箱不用认领、不用称重、不参与国际运费分摊、不能申请发货、也不发国内快递；
-- 货款照旧按表里那样记，一分钱不多收一分钱不少收。默认 0 = 跟我们一起拼邮。
ALTER TABLE customers ADD COLUMN self_return INTEGER NOT NULL DEFAULT 0;
