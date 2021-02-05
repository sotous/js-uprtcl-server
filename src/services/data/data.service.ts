import { DGraphService } from '../../db/dgraph.service';
import { DataRepository } from '../data/data.repository';
import {
  Hashed,
  Secured,
  Commit,
  Signed,
  NewPerspectiveData,
  Perspective,
} from '../uprtcl/types';

const propertyOrder = [
  'creatorsIds',
  'dataId',
  'message',
  'timestamp',
  'parentsIds',
];
const perspectivePropertyOrder = [
  'remote',
  'path',
  'creatorId',
  'context',
  'timestamp',
];

export class DataService {
  constructor(
    protected db: DGraphService,
    protected dataRepo: DataRepository
  ) {}

  async createData(
    data: Hashed<Object>,
    _loggedUserId: string | null
  ): Promise<string> {
    console.log('[UPRTCL-SERVICE] createData', data);
    let dataId = await this.dataRepo.createData(data);
    return dataId;
  }

  async getData(dataId: string): Promise<any> {
    console.log('[UPRTCL-SERVICE] getData', dataId);
    let data = await this.dataRepo.getData(dataId);
    return data;
  }
}
