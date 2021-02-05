import {
  PERSPECTIVE_SCHEMA_NAME,
  COMMIT_SCHEMA_NAME,
} from '../uprtcl/uprtcl.schema';

export const PROPOSALS_SCHEMA_NAME = 'Proposal';
export const HEAD_UPDATE_SCHEMA_NAME = 'HeadUpdate';
export const NEW_PERSPECTIVE_PROPOSAL_SCHEMA_NAME = 'NewPerspectiveProposal';
export const PROPOSAL_STATE_TYPE = 'ProposalStateType';

export const PROPOSAL_SCHEMA = `

type ${HEAD_UPDATE_SCHEMA_NAME} {
    fromPerspective: ${PERSPECTIVE_SCHEMA_NAME}
    perspective: ${PERSPECTIVE_SCHEMA_NAME}
    newHead: ${COMMIT_SCHEMA_NAME}
    oldHead: ${COMMIT_SCHEMA_NAME}
}

type ${NEW_PERSPECTIVE_PROPOSAL_SCHEMA_NAME} {
    NEWP_perspectiveId: string!
    NEWP_parentId: string
    NEWP_headId: string
}

type ${PROPOSALS_SCHEMA_NAME} {
	creator: uid
    toPerspective: ${PERSPECTIVE_SCHEMA_NAME}
    fromPerspective: ${PERSPECTIVE_SCHEMA_NAME}
    toHead: ${COMMIT_SCHEMA_NAME}
    fromHead: ${COMMIT_SCHEMA_NAME}
    updates: [${HEAD_UPDATE_SCHEMA_NAME}]
    newPerspectives: [${NEW_PERSPECTIVE_PROPOSAL_SCHEMA_NAME}]
    state: string!
}

perspective: uid .
newHead: uid .
oldHead: uid .
creator: uid .
toPerspective: uid .
fromPerspective: uid .
toHead: uid .
fromHead: uid .
updates: [uid] .
newPerspectives: [uid] .
state: string @index(exact) .

NEWP_perspectiveId: string .
NEWP_parentId: string .
NEWP_headId: string .

`;
