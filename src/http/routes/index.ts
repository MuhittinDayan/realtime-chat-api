import { Router } from "express";

import { authRouter } from "../../modules/auth/http/auth.routes.js";
import { conversationRouter } from "../../modules/conversations/conversation.routes.js";
import { usersRouter } from "../../modules/users/users.routes.js";
import { healthRouter } from "./health.routes.js";

export const apiV1Router = Router();

apiV1Router.use(healthRouter);
apiV1Router.use("/auth", authRouter);
apiV1Router.use("/users", usersRouter);
apiV1Router.use("/conversations", conversationRouter);
