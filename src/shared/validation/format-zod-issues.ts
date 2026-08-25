import type { ZodError } from "zod";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function formatZodIssues(
  error: ZodError,
  rootPath = "environment",
): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : rootPath,
    message: issue.message,
  }));
}
