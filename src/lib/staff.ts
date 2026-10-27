import type { Context } from 'hono';

export type StaffRole = 'admin' | 'jp';
export const STAFF_ROLES: StaffRole[] = ['admin', 'jp'];
export const ROLE_LABELS: Record<StaffRole, string> = { admin: '管理员', jp: '日本仓' };

/** 当前登录的员工。id = 0 表示用 ADMIN_PASSWORD 登录的引导管理员。 */
export interface Staff {
  id: number;
  role: StaffRole;
  name: string;
}

/** 引导账号的用户名：留给环境变量密码，员工表里不许再建同名的。 */
export const BOOTSTRAP_USERNAME = 'admin';

export function isStaffRole(value: unknown): value is StaffRole {
  return value === 'admin' || value === 'jp';
}

/** 守卫中间件放进去的当前员工；走到这里一定已经登录。 */
export function staffOf(c: Context): Staff {
  const staff = (c as unknown as { get(key: string): unknown }).get('staff') as Staff | undefined;
  if (!staff) throw new Error('staffOf 只能在登录守卫之后调用');
  return staff;
}

export function usernameProblem(username: string): string | null {
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return '账号只能用 2～32 位英文字母、数字、点、下划线、横线';
  if (username.toLowerCase() === BOOTSTRAP_USERNAME) return 'admin 留给引导账号（环境变量密码），换一个名字';
  return null;
}

export function staffPasswordProblem(password: string): string | null {
  if (password.length < 8 || password.length > 64) return '员工密码要 8 到 64 位';
  if (/\s/.test(password)) return '密码里不要有空格';
  return null;
}
