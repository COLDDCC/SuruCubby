/**
 * 客户登录密码：只存 PBKDF2-SHA256 哈希，不存明文。
 * 群主的口径是「账号就是 QQ 号，初始密码统一 123456，后期谁要改再来找他」，
 * 所以 `password_hash` 为空表示这个人还没改过初始密码——页面会拦着不让他下单。
 */

import { timingSafeEqual } from './crypto.ts';

export const INITIAL_PASSWORD = '123456';

const ITERATIONS = 60_000;
const PREFIX = 'pbkdf2-sha256';

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return `${PREFIX}$${ITERATIONS}$${toB64(salt)}$${toB64(await derive(password, salt, ITERATIONS))}`;
}

/** 校验密码；库里没哈希时按初始密码认。 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (stored === null || stored === '') return password === INITIAL_PASSWORD;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  try {
    return timingSafeEqual(toB64(await derive(password, fromB64(parts[2]), iterations)), parts[3]);
  } catch {
    return false;
  }
}

/** 还在用初始密码（或压根没设过）就返回 true，页面据此强制改密码。 */
export function usingInitialPassword(stored: string | null): boolean {
  return stored === null || stored === '';
}

/** 客户自己设的新密码要求；不合法返回中文原因。 */
export function passwordProblem(password: string): string | null {
  if (password.length < 6 || password.length > 32) return '密码要 6 到 32 位';
  if (/\s/.test(password)) return '密码里不要有空格';
  if (password === INITIAL_PASSWORD) return '这就是初始密码，换一个只有你自己知道的';
  return null;
}
