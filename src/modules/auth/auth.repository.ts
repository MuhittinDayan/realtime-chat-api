import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";

export type UserStatus = "ACTIVE" | "DISABLED";
export type UserUniqueField = "email" | "username";

export interface UserRecord {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: UserStatus;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface AuthUserRecord extends UserRecord {
  passwordHash: string;
}

export interface CreateUserData {
  email: string;
  username: string;
  displayName: string;
  passwordHash: string;
  status: UserStatus;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  findUserById(userId: string): Promise<UserRecord | null>;
  findUserByUsername(username: string): Promise<{ id: string } | null>;
  createUser(data: CreateUserData): Promise<UserRecord>;
}

export class UserUniqueConstraintError extends Error {
  readonly fields: readonly UserUniqueField[];

  constructor(fields: readonly UserUniqueField[], cause: unknown) {
    super("A user unique constraint was violated", { cause });
    this.name = "UserUniqueConstraintError";
    this.fields = fields;
  }
}

const userSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  status: true,
  createdAt: true,
  deletedAt: true,
} as const;

const authUserSelect = {
  ...userSelect,
  passwordHash: true,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStrings(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string",
    );
  }

  return [];
}

function readDriverAdapterConstraintFields(
  meta: Record<string, unknown>,
): readonly string[] {
  const driverAdapterError = meta.driverAdapterError;

  if (!isRecord(driverAdapterError)) {
    return [];
  }

  const cause = driverAdapterError.cause;

  if (
    !isRecord(cause) ||
    cause.kind !== "UniqueConstraintViolation" ||
    !isRecord(cause.constraint)
  ) {
    return [];
  }

  return readStrings(cause.constraint.fields);
}

function readUniqueFields(error: unknown): readonly UserUniqueField[] | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  const meta = error.meta ?? {};
  const values = [
    ...readStrings(meta.target),
    ...readDriverAdapterConstraintFields(meta),
  ];
  const joinedTarget = values.join(" ").toLowerCase();
  const fields: UserUniqueField[] = [];

  if (joinedTarget.includes("email")) {
    fields.push("email");
  }

  if (joinedTarget.includes("username")) {
    fields.push("username");
  }

  return fields;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    return this.client.user.findUnique({
      where: { email },
      select: authUserSelect,
    });
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.client.user.findUnique({
      where: { id: userId },
      select: userSelect,
    });
  }

  async findUserByUsername(
    username: string,
  ): Promise<{ id: string } | null> {
    return this.client.user.findUnique({
      where: { username },
      select: { id: true },
    });
  }

  async createUser(data: CreateUserData): Promise<UserRecord> {
    try {
      return await this.client.user.create({
        data: {
          email: data.email,
          username: data.username,
          displayName: data.displayName,
          passwordHash: data.passwordHash,
          status: data.status,
        },
        select: userSelect,
      });
    } catch (error: unknown) {
      const uniqueFields = readUniqueFields(error);

      if (uniqueFields !== null) {
        throw new UserUniqueConstraintError(uniqueFields, error);
      }

      throw error;
    }
  }
}
