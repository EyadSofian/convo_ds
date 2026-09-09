export const API_CONFIG = Symbol('API_CONFIG');
export const API_POOL = Symbol('API_POOL');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
/** Where a password-recovery token is sent. See auth/recovery-delivery.ts. */
export const RECOVERY_DELIVERY = Symbol('RECOVERY_DELIVERY');
/** Where an invitation token is sent. See people/invitation-delivery.ts. */
export const INVITATION_DELIVERY = Symbol('INVITATION_DELIVERY');

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}
