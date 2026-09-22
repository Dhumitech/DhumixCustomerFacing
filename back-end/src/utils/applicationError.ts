import type { PublicProblemCode } from "./publicProblemCode.js";

export interface ProblemField {
  readonly field: string;
  readonly message: string;
}

export interface ApplicationErrorOptions {
  readonly status: number;
  readonly code: PublicProblemCode;
  readonly title: string;
  readonly detail?: string | null;
  readonly errors?: readonly ProblemField[];
  readonly cause?: unknown;
}

export class ApplicationError extends Error {
  public readonly status: number;
  public readonly code: PublicProblemCode;
  public readonly title: string;
  public readonly detail: string | null;
  public readonly errors: readonly ProblemField[] | undefined;

  public constructor(options: ApplicationErrorOptions) {
    super(options.detail ?? options.title, { cause: options.cause });
    this.name = "ApplicationError";
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail ?? null;
    this.errors = options.errors;
  }
}
