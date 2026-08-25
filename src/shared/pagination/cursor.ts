export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new Error("Cursor is not valid base64url");
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  return JSON.parse(decoded) as unknown;
}
