-- 客户在团购表里写的就是昵称，认人全靠 customer_aliases；但历史上改过昵称的客户，
-- 新昵称没登记成别名，导入时表里写新名字就认不出来，只能手动指认，一指认就容易绑错 QQ。
-- 这里把每个客户的昵称补成一条别名，让「昵称」始终是能对上的名字。
-- 撞车的（这个名字已经绑在别人身上）跳过，那种得人工去后台合并客户。
INSERT OR IGNORE INTO customer_aliases (alias, customer_id)
SELECT c.nickname, c.id FROM customers c;
