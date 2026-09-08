export const API_CONFIG = Symbol('API_CONFIG');
export const API_POOL = Symbol('API_POOL');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}
