import type { Problem } from "./generated";

function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Problem>;
  return (
    typeof candidate.status === "number" &&
    typeof candidate.code === "string" &&
    typeof candidate.title === "string"
  );
}

export class DhumiApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(cause: unknown) {
    const problem = isProblem(cause) ? cause : null;
    super(
      problem?.detail ||
        problem?.title ||
        "Dhumi could not complete the request.",
      { cause },
    );
    this.name = "DhumiApiError";
    this.status = problem?.status ?? null;
    this.code = problem?.code ?? null;
    this.requestId = problem?.request_id ?? null;
  }
}

export async function asDhumiRequest<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    throw error instanceof DhumiApiError ? error : new DhumiApiError(error);
  }
}
