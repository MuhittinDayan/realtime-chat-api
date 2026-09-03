import { AppError } from "../../shared/errors/app-error.js";

export class NotificationNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "NOTIFICATION_NOT_FOUND",
      message: "Notification not found",
    });
    this.name = "NotificationNotFoundError";
  }
}
