export function createDirectConversationKey(
  firstUserId: string,
  secondUserId: string,
): string {
  return [firstUserId.toLowerCase(), secondUserId.toLowerCase()]
    .sort()
    .join(":");
}
