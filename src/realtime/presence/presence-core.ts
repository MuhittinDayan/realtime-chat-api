import { systemClock } from "../../shared/time/clock.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { socketPresencePublisher } from "./presence-publisher.js";
import { PrismaPresenceRepository } from "./presence.repository.js";
import { PresenceService } from "./presence.service.js";

export const connectionRegistry = new ConnectionRegistry();
export const presenceRepository = new PrismaPresenceRepository();
export const presenceService = new PresenceService(
  connectionRegistry,
  presenceRepository,
  socketPresencePublisher,
  systemClock,
);
