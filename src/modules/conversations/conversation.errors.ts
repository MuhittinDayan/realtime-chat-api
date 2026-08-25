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
