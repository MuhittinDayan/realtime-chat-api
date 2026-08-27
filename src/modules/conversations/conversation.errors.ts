import { AppError } from "../../shared/errors/app-error.js";

export class UserNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "USER_NOT_FOUND",
      message: "User not found",
    });

    this.name = "UserNotFoundError";
  }
}

export class CannotMessageSelfError extends AppError {
  constructor() {
    super({
      statusCode: 400,
      code: "CANNOT_MESSAGE_SELF",
      message: "You cannot start a conversation with yourself",
    });

    this.name = "CannotMessageSelfError";
  }
}

export class ConversationNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
      message: "Conversation not found",
    });

    this.name = "ConversationNotFoundError";
  }
}

export class InsufficientRoleError extends AppError {
  constructor() {
    super({
      statusCode: 403,
      code: "INSUFFICIENT_ROLE",
      message: "Your role does not permit this action",
    });

    this.name = "InsufficientRoleError";
  }
}

export class ConversationConflictError extends AppError {
  constructor(message: string) {
    super({ statusCode: 409, code: "CONFLICT", message });
    this.name = "ConversationConflictError";
  }
}

export class InvalidConversationOperationError extends AppError {
  constructor(message: string) {
    super({ statusCode: 400, code: "INVALID_OPERATION", message });
    this.name = "InvalidConversationOperationError";
  }
}
