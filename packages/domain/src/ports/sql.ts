/**
 * The narrow database port the domain is allowed to see.
 *
 * `pg`'s `PoolClient` satisfies this structurally, but the domain never imports
 * the driver: MASTER-PROMPT section 2 asks for domain logic that stays
 * framework-independent where practical, and a three-method port is practical.
 */
export interface SqlResult<R> {
  readonly rows: readonly R[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<R>(text: string, values?: readonly unknown[]): Promise<SqlResult<R>>;
}

/**
 * Runs `work` inside one transaction whose tenant context is set and verified.
 *
 * The domain requires a transaction, not a connection: the installation
 * bootstrap claims its one-time flag and writes the company in the same unit,
 * so a failure halfway cannot leave the flag consumed with no company behind
 * it (MODE-03).
 */
export interface TenantTransaction {
  <T>(tenantId: string, work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}
