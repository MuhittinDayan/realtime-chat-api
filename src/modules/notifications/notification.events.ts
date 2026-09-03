export interface NotificationCreatedEvent {
  id: string;
  type: "MESSAGE_CREATED";
  recipientUserId: string;
  conversationId: string;
  messageId: string;
  createdAt: Date;
}

export interface NotificationReadEvent {
  id: string;
  recipientUserId: string;
  readAt: Date;
}

export interface ConversationNotificationsReadEvent {
  recipientUserId: string;
  conversationId: string;
  markedCount: number;
}

export interface NotificationPublisher {
  publishCreated(event: NotificationCreatedEvent): Promise<void> | void;
  publishRead(event: NotificationReadEvent): Promise<void> | void;
  publishConversationRead(
    event: ConversationNotificationsReadEvent,
  ): Promise<void> | void;
}

export const noopNotificationPublisher: NotificationPublisher = {
  publishCreated: () => undefined,
  publishRead: () => undefined,
  publishConversationRead: () => undefined,
};
