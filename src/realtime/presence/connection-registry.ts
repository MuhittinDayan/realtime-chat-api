export class ConnectionRegistry {
  private readonly socketsByUser = new Map<string, Set<string>>();

  add(userId: string, socketId: string): boolean {
    const socketIds = this.socketsByUser.get(userId) ?? new Set<string>();
    const wasOffline = socketIds.size === 0;
    socketIds.add(socketId);
    this.socketsByUser.set(userId, socketIds);

    return wasOffline;
  }

  remove(userId: string, socketId: string): boolean {
    const socketIds = this.socketsByUser.get(userId);

    if (socketIds === undefined) {
      return false;
    }

    const removed = socketIds.delete(socketId);

    if (socketIds.size === 0) {
      this.socketsByUser.delete(userId);
      return removed;
    }

    return false;
  }

  socketIdsFor(userId: string): ReadonlySet<string> {
    return this.socketsByUser.get(userId) ?? new Set<string>();
  }

  isOnline(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }
}
