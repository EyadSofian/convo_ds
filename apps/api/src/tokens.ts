export const API_CONFIG = Symbol('API_CONFIG');
export const API_POOL = Symbol('API_POOL');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
/** Where a password-recovery token is sent. See auth/recovery-delivery.ts. */
export const RECOVERY_DELIVERY = Symbol('RECOVERY_DELIVERY');
/** Where an invitation token is sent. See people/invitation-delivery.ts. */
export const INVITATION_DELIVERY = Symbol('INVITATION_DELIVERY');
/**
 * How a channel reaches its provider. See channels/channel-transport.ts.
 *
 * The default refuses every call, because no provider assets are authorized.
 * That is the truth this build can tell, and a simulator bound here would make
 * it look otherwise.
 */
export const CHANNEL_TRANSPORT = Symbol('CHANNEL_TRANSPORT');
/**
 * The durable broker. See broker/broker.port.ts.
 *
 * The default refuses every publish. A process that requires a broker fails
 * closed rather than falling back to an in-memory queue, because a queue that
 * quietly becomes an array loses everything on restart while every dashboard
 * still says it is working.
 */
export const BROKER = Symbol('BROKER');

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}
