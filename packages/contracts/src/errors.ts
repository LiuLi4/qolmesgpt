export type ErrorCode =
  | "INVALID_STATE_TRANSITION"
  | "APPROVAL_REQUIRED"
  | "CREDENTIALS_NOT_AVAILABLE"
  | "DATA_SOURCE_NOT_VERIFIED";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
