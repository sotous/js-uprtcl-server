import { DGraphService } from "../db/dgraph.service";
import { UprtclController } from "./uprtcl/uprtcl.controller";
import { UprtclService } from "./uprtcl/uprtcl.service";
import { UserController } from "./user/user.controller";
import { UserService } from "./user/user.service";
import { AccessService } from "./access/access.service";
import { AccessController } from "./access/access.controller";
import { AccessRepository } from "./access/access.repository";
import { UserRepository } from "./user/user.repository";
import { UprtclRepository } from "./uprtcl/uprtcl.repository";
import { DataRepository } from "./data/data.repository";
import { KnownSourcesRepository } from "./knownsources/knownsources.repository";

/** poors man dependency injection */
const dbService = new DGraphService('localhost:9080');

const userRepo = new UserRepository(dbService);
const accessRepo = new AccessRepository(dbService, userRepo);
const uprtclRepo = new UprtclRepository(dbService, userRepo);
const dataRepo = new DataRepository(dbService, userRepo);
const knownSourcesRepo = new KnownSourcesRepository(dbService, userRepo);

const accessService = new AccessService(dbService, accessRepo);
const accessController = new AccessController(accessService);

const uprtclService = new UprtclService(dbService, uprtclRepo, dataRepo, knownSourcesRepo, accessService);
const uprtclController = new UprtclController(uprtclService);

const userService = new UserService(dbService, userRepo);
const userController = new UserController(userService);


export const routes = [
  ...uprtclController.routes(), 
  ...userController.routes(), 
  ...accessController.routes()
];