import type { AuthContext } from "../../modules/auth/domain/auth.types.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

export {};
