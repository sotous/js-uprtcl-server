import { DGraphService } from "../../db/dgraph.service";
import { NewProposalData, NewPerspectiveData } from "../uprtcl/types";
import { UserRepository } from "../user/user.repository";
import { UprtclService } from '../uprtcl/uprtcl.service';
import { PROPOSALS_SCHEMA_NAME } from "../proposals/proposals.schema";
import { Perspective, Proposal, UpdateRequest } from "../uprtcl/types";

const dgraph = require("dgraph-js");
require("dotenv").config();

interface DgProposal {
    state: string
    fromPerspective: DgPerspective
    toPerspective: DgPerspective
    updates?: Array<string>    
}

interface DgPerspective {
    xid: string
}

export class ProposalsRepository {
    constructor(
        protected db: DGraphService
    ) {}

    async createOrUpdateProposal(proposalData: NewProposalData): Promise <string> {        
        await this.db.ready();

       /** 
         *  Needs to validate if proposal exists to update instead
         */        

        const mu = new dgraph.Mutation();
        const req = new dgraph.Request();

        let query = `toPerspective as var(func: eq(xid, ${proposalData.toPerspectiveId}))`;
        query = query.concat(`\nfromPerspective as var(func: eq(xid, ${proposalData.fromPerspectiveId}))`);
        
        let nquads = `_:proposal  <toPerspective> uid(toPerspective) .`;
        nquads = nquads.concat(`\n_:proposal <fromPerspective> uid(fromPerspective) .`);
        nquads = nquads.concat(`\n_:proposal <state>  "Open".`);
        nquads = nquads.concat(`\n_:proposal <dgraph.type> "${PROPOSALS_SCHEMA_NAME}" .`);
      

        req.setQuery(`query{${query}}`);
        mu.setSetNquads(nquads);
        req.setMutationsList([mu]);

        const result = await this.db.callRequest(req);        

        return result.getUidsMap().get("proposal");
    }

    async getProposal(proposalId: string): Promise<Proposal> {
        
        await this.db.ready();

        let query = `query {
            proposal(func: uid(${proposalId})) {
                state
                fromPerspective {
                    xid
                }
                toPerspective {
                    xid
                }
            }
        }`;

        const result = await this.db.client.newTxn().query(query);

        const dproposal: DgProposal = result.getJson().proposal[0];

        if(!dproposal) throw new Error(`Proposal with id ${proposalId} not found`);        

        const { fromPerspective: { xid: fromPerspectiveId },
                toPerspective: { xid: toPerspectiveId },
                state
              } = dproposal;                            

        const proposal: Proposal = {
            // creatorId
            // toHeadId
            // fromHeadId
            // updates
            id: proposalId,
            toPerspectiveId: toPerspectiveId,
            fromPerspectiveId: fromPerspectiveId,
            [state.toLowerCase()]: true,            
        }                

        return proposal;
    }

    async getProposalsToPerspective(perspectiveId: string): Promise<Array<Proposal>> {
        const proposals: Array<Proposal> = [
            {    
                id: 'id9430',        
                fromPerspectiveId: 'perspectiveModifying',
                updates: [
                    { perspectiveId: 'testId',
                      newHeadId: 'headId' }
                ],
                executed: true
            }
        ];

        return proposals;
    }

    async addUpdatesToProposal(proposalId: string, updates: UpdateRequest[]): Promise<void> {
        return;
    } 

    async acceptProposal(proposalId: string): Promise<void> {
        // let acceptProposal = {
        //     proposalId: (proposalId == undefined || proposalId == '') ? this.errorProposalId() : proposalId
        // }
        return;
    } 

    async cancelProposal(proposalId: string): Promise<void> {
        return;
    }
    
    async declineProposal(proposalId: string): Promise<void> {
        return;
    } 


}