import { Request, Response } from 'express';
import { DataService } from './data.service';
import { UprtclService } from '../uprtcl/uprtcl.service';
import { checkJwt } from '../../middleware/jwtCheck';
import {
  getUserFromReq,
  SUCCESS,
  PostEntityResult,
  GetResult,
} from '../../utils';
declare global {
  namespace Express {
    interface Request {
      user: string;
    }
  }
}

export class DataController {
  constructor(
    protected dataService: DataService,
    protected uprtclService: UprtclService
  ) {}

  routes() {
    return [
      {
        path: '/uprtcl/1/data',
        method: 'post',
        handler: [
          checkJwt,
          async (req: Request, res: Response) => {
            const allDatas = req.body.datas;

            /** all entities are stored in plain text */
            const commits = allDatas.filter((data: any) =>
              this.dataService.commitFilter(data)
            );
            /** explicitely store structured commits to link them to other elements */
            const datas = allDatas.filter(
              (data: any) => !this.dataService.commitFilter(data)
            );

            const resultCommits = await this.uprtclService.createCommits(
              commits,
              getUserFromReq(req)
            );

            let result: PostEntityResult = {
              result: SUCCESS,
              message: '',
              entities: Array.prototype.concat([], datas.concat(resultCommits)),
            };
            res.status(200).send(result);
          },
        ],
      },

      /** GET with put to receive the list of hashes as an object */
      {
        path: '/uprtcl/1/data',
        method: 'put',
        handler: [
          checkJwt,
          async (req: Request, res: Response) => {
            const hashes = req.body.hashes as string[];
            const datas = await this.dataService.getDatas(hashes);
            let result: GetResult<any> = {
              result: SUCCESS,
              message: '',
              data: datas,
            };
            res.status(200).send(result);
          },
        ],
      },
    ];
  }
}
