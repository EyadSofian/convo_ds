export interface ClusterCredentials {
  readonly host: string;
  readonly port: number;
  readonly superUser: string;
  readonly superPassword: string;
}

export interface DatabaseNames {
  /** Database that holds the application schema. */
  readonly database: string;
  /** Owns the schema and runs migrations. Never used at runtime. */
  readonly migrationRole: string;
  readonly migrationPassword: string;
  /** Reads and writes rows at runtime. Owns nothing, no BYPASSRLS. */
  readonly runtimeRole: string;
  readonly runtimePassword: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}
