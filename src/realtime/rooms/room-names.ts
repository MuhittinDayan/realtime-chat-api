export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}
