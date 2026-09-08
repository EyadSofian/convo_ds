import { HttpException } from '@nestjs/common';
import type { ErrorDetail } from '@convo/contracts';

export class ApiHttpError extends HttpException {
  readonly code: string;
  readonly safeMessage: string;
  readonly details: readonly ErrorDetail[];
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    statusCode: number,
    code: string,
    safeMessage: string,
    details: readonly ErrorDetail[] = [],
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(safeMessage, statusCode);
    this.code = code;
    this.safeMessage = safeMessage;
    this.details = details;
    this.headers = headers;
  }
}
