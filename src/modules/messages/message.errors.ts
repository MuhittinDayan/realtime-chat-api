import { AppError } from "../../shared/errors/app-error.js";

export class MessageNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "MESSAGE_NOT_FOUND",
      message: "Message not found",
    });

    this.name = "MessageNotFoundError";
  }
}
