import {
  Commit,
  Entity,
  GetPerspectiveOptions,
  NewPerspective,
  Perspective,
  PerspectiveDetails,
  PerspectiveGetResult,
  Secured,
  Update,
  Slice,
  ParentAndChild,
  SearchOptions,
  SearchOptionsJoin,
  SearchOptionsEcoJoin,
  SearchResult,
  SearchForkOptions,
  ForkOf,
} from '@uprtcl/evees';
import { DGraphService } from '../../db/dgraph.service';
import { UserRepository } from '../user/user.repository';
import { DataRepository } from '../data/data.repository';
import { Upsert } from './types';
import { PERSPECTIVE_SCHEMA_NAME, COMMIT_SCHEMA_NAME } from './uprtcl.schema';
import { ipldService } from '../ipld/ipldService';
import { decodeData } from '../data/utils';

const dgraph = require('dgraph-js');

export enum Join {
  inner = 'INNER_JOIN',
  full = 'FULL_JOIN',
}

export enum SearchType {
  linksTo = 'linksTo',
  under = 'under',
  above = 'above',
}

export interface Text {
  value: string;
  levels: number;
}

export interface SearchUpsert {
  startQuery: string;
  internalWrapper: string;
  optionalWrapper: string;
}
export interface DgRef {
  [x: string]: string;
  uid: string;
}

interface DgPerspective {
  uid?: string;
  xid: string;
  name: string;
  context: DgContext;
  remote: string;
  path: string;
  creator: DgRef;
  timextamp: number;
  'dgraph.type'?: string;
  stored: boolean;
  deleted: boolean;
  signature: string;
  proof_type: string;
  delegate: boolean;
  delegateTo: DgPerspective;
  finDelegatedTo: DgPerspective;
  publicRead: boolean;
  publicWrite: boolean;
  canRead: DgRef[];
  canWrite: DgRef[];
  canAdmin: DgRef[];
}

interface DgContext {
  name: string;
  perspectives: DgPerspective[];
}
interface DgCommit {
  uid?: string;
  xid: string;
  creators: DgRef[];
  timextamp: number;
  message: string;
  parents: DgRef[];
  data: DgRef;
  'dgraph.type'?: string;
  stored: boolean;
  signature: string;
  proof_type: string;
}

const defaultFirst = 10;

export interface FetchResult {
  perspectiveIds: string[];
  ended?: boolean;
  details: PerspectiveDetails;
  slice: Slice;
  forksDetails?: ForkOf[];
}

export class UprtclRepository {
  constructor(
    protected db: DGraphService,
    protected userRepo: UserRepository,
    protected dataRepo: DataRepository
  ) {}

  createPerspectiveUpsert(
    upsertedProfiles: string[],
    externalParentIds: string[],
    upsert: Upsert,
    newPerspective: NewPerspective,
    loggedUserId: string
  ) {
    // Perspective object destructuring
    const {
      hash: id,
      object: {
        payload: { creatorId, timestamp, context, remote, path },
        proof,
      },
    } = newPerspective.perspective;

    let { query, nquads } = upsert;

    if (!upsertedProfiles.includes(creatorId)) {
      upsertedProfiles.push(creatorId);
      const creatorSegment = this.userRepo.upsertQueries(creatorId);
      query = query.concat(creatorSegment.query);
      nquads = nquads.concat(creatorSegment.nquads);
    }

    if (loggedUserId !== creatorId) {
      throw new Error(
        `Can only store perspectives whose creatorId is the creator, but ${creatorId} is not ${loggedUserId}`
      );
    }

    query = query.concat(`\npersp${id} as var(func: eq(xid, "${id}"))`);
    query = query.concat(
      `\ncontextOf${id} as var(func: eq(name, "${context}"))`
    );

    nquads = nquads.concat(`\nuid(persp${id}) <xid> "${id}" .`);
    nquads = nquads.concat(`\nuid(persp${id}) <stored> "true" .`);
    nquads = nquads.concat(
      `\nuid(persp${id}) <creator> uid(profile${this.userRepo.formatDid(
        creatorId
      )}) .`
    );
    nquads = nquads.concat(
      `\nuid(persp${id}) <timextamp> "${timestamp}"^^<xs:int> .`
    );

    nquads = nquads.concat(`\nuid(contextOf${id}) <name> "${context}" .`);
    nquads = nquads.concat(
      `\nuid(contextOf${id}) <perspectives> uid(persp${id}) .`
    );
    nquads = nquads.concat(`\nuid(persp${id}) <context> uid(contextOf${id}) .`);

    nquads = nquads.concat(`\nuid(persp${id}) <deleted> "false" .`);
    nquads = nquads.concat(`\nuid(persp${id}) <remote> "${remote}" .`);
    nquads = nquads.concat(`\nuid(persp${id}) <path> "${path}" .`);
    nquads = nquads.concat(
      `\nuid(persp${id}) <dgraph.type> "${PERSPECTIVE_SCHEMA_NAME}" .`
    );

    nquads = nquads.concat(
      `\nuid(persp${id}) <signature> "${proof.signature}" .`
    );
    nquads = nquads.concat(`\nuid(persp${id}) <proof_type> "${proof.type}" .`);

    // Permissions and ACL
    //-----------------------------//

    /** Sets default permissions */
    nquads = nquads.concat(
      `\nuid(persp${id}) <publicRead> "false" .
       \nuid(persp${id}) <publicWrite> "false" .
       \nuid(persp${id}) <canRead> uid(profile${this.userRepo.formatDid(
        creatorId
      )}) .
       \nuid(persp${id}) <canWrite> uid(profile${this.userRepo.formatDid(
        creatorId
      )}) .
       \nuid(persp${id}) <canAdmin> uid(profile${this.userRepo.formatDid(
        creatorId
      )}) .`
    );

    /** add itself as its ecosystem */
    nquads = nquads.concat(`\nuid(persp${id}) <ecosystem> uid(persp${id}) .`);

    if (newPerspective.update.details.guardianId) {
      // We need to bring that parentId if it is external
      if (
        externalParentIds.includes(newPerspective.update.details.guardianId)
      ) {
        /** This perspective is an external perspective and has a parentId that already
         * exists on the database */

        query = query.concat(`\nparentOfExt${id} as var(func: eq(xid, ${newPerspective.update.details.guardianId})) {
          finDelOfParentOfExt${id} as finDelegatedTo
        }`);

        nquads = nquads.concat(
          `\nuid(persp${id}) <delegateTo> uid(parentOfExt${id}) .`
        );
        nquads = nquads.concat(
          `\nuid(persp${id}) <finDelegatedTo> uid(finDelOfParentOfExt${id}) .`
        );
      } else {
        nquads = nquads.concat(
          `\nuid(persp${id}) <delegateTo> uid(persp${newPerspective.update.details.guardianId}) .`
        );
        /** because the parent is in the batch, we cannot set the finDelegateTo and
         * have to postpone it to another subsequent query */
      }

      nquads = nquads.concat(`\nuid(persp${id}) <delegate> "true" .`);
    } else {
      // Assings itself as finalDelegatedTo
      nquads = nquads.concat(
        `\nuid(persp${id}) <finDelegatedTo> uid(persp${id}) .
         \nuid(persp${id}) <delegate> "false" .`
      );
    }

    return { query, nquads };
  }

  async createPerspectives(
    newPerspectives: NewPerspective[],
    loggedUserId: string
  ) {
    if (newPerspectives.length === 0) return;
    await this.db.ready();

    let upsert: Upsert = {
      query: ``,
      nquads: ``,
    };

    let ACLupsert: Upsert = {
      query: ``,
      nquads: ``,
    };

    let upsertedProfiles: string[] = [];
    let perspectiveIds = newPerspectives.map((p) => p.perspective.hash);

    const externalParentPerspectives = newPerspectives.filter((p) => {
      if (p.update.details.guardianId !== null) {
        if (p.update.details.guardianId !== undefined) {
          if (!perspectiveIds.includes(p.update.details.guardianId)) {
            return p;
          }
        } else {
          return p;
        }
      } else {
        return p;
      }
    });

    const externalParentIds = [
      ...new Set(
        externalParentPerspectives.map((p) => p.update.details.guardianId)
      ),
    ];

    for (let i = 0; i < newPerspectives.length; i++) {
      const newPerspective = newPerspectives[i];
      const upsertString = this.createPerspectiveUpsert(
        upsertedProfiles,
        externalParentIds as string[],
        upsert,
        newPerspective,
        loggedUserId
      );

      if (i < 1) {
        upsert.query = upsert.query.concat(upsertString.query);
        upsert.nquads = upsert.nquads.concat(upsertString.nquads);
      }

      upsert = upsertString;
    }

    const mu = new dgraph.Mutation();
    const req = new dgraph.Request();

    req.setQuery(`query{${upsert.query}}`);
    mu.setSetNquads(upsert.nquads);
    req.setMutationsList([mu]);

    let result = await this.db.callRequest(req);

    // Keep the ACL redundant layer updated.
    for (let i = 0; i < externalParentPerspectives.length; i++) {
      const externalPerspective = externalParentPerspectives[i];
      const aclUpsertString = this.recurseACLupdateUpsert(
        externalPerspective.perspective.hash,
        ACLupsert
      );

      if (i < 1) {
        ACLupsert.query = ACLupsert.query.concat(aclUpsertString.query);
        ACLupsert.nquads = ACLupsert.nquads.concat(aclUpsertString.nquads);
      }

      ACLupsert = aclUpsertString;
    }

    const ACLmu = new dgraph.Mutation();
    const ACLreq = new dgraph.Request();

    ACLreq.setQuery(`query{${ACLupsert.query}}`);
    ACLmu.setSetNquads(ACLupsert.nquads);
    ACLreq.setMutationsList([ACLmu]);

    let ACLresult = await this.db.callRequest(ACLreq);
    console.log(
      '[DGRAPH] createPerspective',
      { upsert, ACLupsert },
      result.getUidsMap().toArray(),
      ACLresult.getUidsMap().toArray()
    );
  }

  recurseACLupdateUpsert(externalPerspectiveId: string, upsert: Upsert) {
    let { query, nquads } = upsert;
    query = query.concat(
      `\nexternal${externalPerspectiveId}(func: eq(xid, ${externalPerspectiveId}))
        @recurse {
          inheritingFrom${externalPerspectiveId} as ~delegateTo
          uid
        }`
    );

    query = query.concat(`\nexternalForFinDel${externalPerspectiveId}(func: eq(xid, ${externalPerspectiveId})) {
      finalDelegateOf${externalPerspectiveId} as finDelegatedTo
    }`);

    nquads = nquads.concat(
      `\nuid(inheritingFrom${externalPerspectiveId}) <finDelegatedTo> uid(finalDelegateOf${externalPerspectiveId}) .`
    );

    return { query, nquads };
  }

  async updatePerspectives(updates: Update[]): Promise<void> {
    let childrenUpsert: Upsert = { nquads: ``, delNquads: ``, query: `` };
    let ecoUpsert: Upsert = { query: ``, nquads: ``, delNquads: `` };

    /**
     * The reason why we have a second loop, is beacuse the first one
     * is to collect the external children. Once collected,
     * we'll resuse that data inside this loop.
     */
    for (let i = 0; i < updates.length; i++) {
      /**
       * We start building the DB query by calling the upsert function.
       * First, we start by the children.
       */
      const childrenUpsertString = this.updatePerspectiveUpsert(
        updates[i],
        childrenUpsert
      );

      /**
       * Consequently, we start calling the ecosystem upsert function.
       */
      const ecoUpsertString = this.updateEcosystemUpsert(updates[i], ecoUpsert);

      /**
       * To have in mind: The 2 previous functions are synchronous, which
       * means that, we do not actually talk to the db, we just build the
       * strings that will be send to perform the actual transactions.
       */

      //---------

      /**
       * We start concatenating the strings after having initialized the variables
       * with the first call, so we accumulate as the loop goes forward.
       */
      if (i < 1) {
        childrenUpsert.query = childrenUpsert.query.concat(
          childrenUpsertString.query
        );
        childrenUpsert.nquads = childrenUpsert.nquads.concat(
          childrenUpsertString.nquads
        );

        ecoUpsert.query = ecoUpsert.query.concat(ecoUpsertString.query);
        ecoUpsert.nquads = ecoUpsert.nquads.concat(ecoUpsertString.nquads);
      }

      childrenUpsert = childrenUpsertString;
      ecoUpsert = ecoUpsertString;
    }

    if (childrenUpsert.query && childrenUpsert.nquads !== '') {
      // We call the db to be prepared for transactions
      await this.db.ready();
      // We perform first, the children transaction | TRX #3
      const childrenMutation = new dgraph.Mutation();
      const childrenRequest = new dgraph.Request();

      childrenRequest.setQuery(`query{${childrenUpsert.query}}`);
      childrenMutation.setSetNquads(childrenUpsert.nquads);
      childrenMutation.setDelNquads(childrenUpsert.delNquads);

      childrenRequest.setMutationsList([childrenMutation]);

      console.log('[DGRAPH] updatePerspectives - childrenRequest', {
        childrenUpsert,
      });
      await this.db.callRequest(childrenRequest);

      // Consequently, we perform the ecosystem transaction | TRX #4
      /**
       * We need to perforn TXR #4 after TXR #3, because the ecosystem query will rely
       * on the children of each perspective that already exists inside the database.
       * Think of the ecosystem as the geonological tree of a human.
       */
      const ecoMutation = new dgraph.Mutation();
      const ecoRequest = new dgraph.Request();

      ecoRequest.setQuery(`query{${ecoUpsert.query}}`);
      ecoMutation.setSetNquads(ecoUpsert.nquads);
      ecoMutation.setDelNquads(ecoUpsert.delNquads);

      ecoRequest.setMutationsList([ecoMutation]);

      console.log('[DGRAPH] updatePerspectives - ecoRequest', {
        ecoUpsert,
      });
      const result = await this.db.callRequest(ecoRequest);
      console.log('[DGRAPH] updatePerspectives - result', { result });
    }
  }

  updatePerspectiveUpsert(update: Update, upsert: Upsert) {
    let { query, nquads, delNquads } = upsert;
    const { perspectiveId: id } = update;

    // WARNING: IF THE PERSPECTIVE ENDS UP HAVING TWO HEADS, CHECK DGRAPH DOCS FOR RECENT UPDATES
    // IF NO SOLUTION, THEN BATCH DELETE ALL HEADS BEFORE BATCH UPDATE THEM

    query = query.concat(
      `\npersp${id} as var(func: eq(xid, ${id})) {
          xid
        }`
    );

    // We update the current xid.
    nquads = nquads.concat(`\nuid(persp${id}) <xid> "${id}" .`);

    // If the current perspective we are seeing isn't headless, we proceed to update the ecosystem and its head.
    if (update.details !== undefined) {
      if (update.details.headId !== undefined) {
        const { details } = update;

        const linkChanges = update.indexData?.linkChanges;
        const text = update.indexData?.text;
        const headId = details.headId;
        const addedLinksTo = linkChanges?.linksTo?.added;
        const removedLinksTo = linkChanges?.linksTo?.removed;
        const addedChildren = linkChanges?.children?.added;
        const removedChildren = linkChanges?.children?.removed;

        // We set the head for previous created perspective.
        query = query.concat(
          `\nheadOf${id} as var(func: eq(xid, "${headId}"))`
        );
        nquads = nquads.concat(`\nuid(headOf${id}) <xid> "${headId}" .`);
        nquads = nquads.concat(`\nuid(persp${id}) <head> uid(headOf${id}) .`);

        if (text)
          nquads = nquads.concat(
            `\nuid(persp${id}) <text> "${text
              .toString()
              .replace(/"/g, '\\"')}" .`
          );

        // The linksTo edges are generic links from this perspective to any another perspective.
        // Once created, they can be used by the searchEngine to query the all perspectives that
        // have a linkTo another one.

        // linksTo[] to be added.
        addedLinksTo?.forEach((link, ix) => {
          query = query.concat(
            `\naddedLinkToOf${id}${ix} as var(func: eq(xid, ${link}))`
          );
          // create a stub xid in case the link does not exist locally
          nquads = nquads.concat(
            `\nuid(addedLinkToOf${id}${ix}) <xid> "${link}" .`
          );
          nquads = nquads.concat(
            `\nuid(persp${id}) <linksTo> uid(addedLinkToOf${id}${ix}) .`
          );
        });

        // linksTo[] to be removed.
        removedLinksTo?.forEach((link, ix) => {
          query = query.concat(
            `\nremovedLinksToOf${id}${ix} as var(func: eq(xid, ${link}))`
          );
          delNquads = delNquads?.concat(
            `\nuid(persp${id} ) <linksTo> uid(removedLinksToOf${id}${ix}) .`
          );
        });

        // Children links are a special case of linkTo and a first-class citizen in _Prtcl.
        // When forking and merging perpsectives of an evee, the children links are recursively forked and
        // merged (while linksTo are not). In addition, the children of a perspective build its "ecosystem"
        // (the set of itself, all its children and their children, recursively).
        // The ecosystem can be used by the searchEngine to search "under" a given perspective and it is
        // expected that searchEngine implementations will optimize for these kind of queries.

        // We set the external children for the previous created persvective.
        addedChildren?.forEach((child, ix) => {
          query = query.concat(
            `\naddedChildOf${id}${ix} as var(func: eq(xid, ${child}))`
          );
          nquads = nquads.concat(
            `\nuid(persp${id}) <children> uid(addedChildOf${id}${ix}) .`
          );
        });

        // We remove the possible external children for an existing perspective.
        removedChildren?.forEach((child, ix) => {
          query = query.concat(
            `\nremovedChildOf${id}${ix} as var(func: eq(xid, ${child}))`
          );
          delNquads = delNquads?.concat(
            `\nuid(persp${id}) <children> uid(removedChildOf${id}${ix}) .`
          );
        });
      }
    }

    return { query, nquads, delNquads };
  }

  updateEcosystemUpsert(update: Update, upsert: Upsert) {
    let { query, nquads, delNquads } = upsert;
    const { perspectiveId: id } = update;

    query = query.concat(
      `\npersp${id} as var(func: eq(xid, ${id}))
        @recurse
        {
          revEcosystem${id} as ~children
        }
       \nperspEl${id} as var(func: uid(persp${id}))
        @recurse
        {
          ecosystemOfUref${id} as children
        }`
    );

    nquads = nquads.concat(
      `\nuid(perspEl${id}) <ecosystem> uid(ecosystemOfUref${id}) .
       \nuid(revEcosystem${id}) <ecosystem> uid(ecosystemOfUref${id}) .`
    );

    return { query, nquads, delNquads };
  }

  async createCommits(commits: Secured<Commit>[]): Promise<Entity<any>[]> {
    if (commits.length === 0) return [];
    await this.db.ready();

    let query = ``;
    let nquads = ``;
    let enitites: Entity<any>[] = [];
    const addedUsers: string[] = [];

    for (let securedCommit of commits) {
      const commit = securedCommit.object.payload;
      const proof = securedCommit.object.proof;

      const id = await ipldService.validateSecured(securedCommit);

      /** make sure creatorId exist */
      for (let ix = 0; ix < commit.creatorsIds.length; ix++) {
        const did = commit.creatorsIds[ix];
        if (!addedUsers.includes(did)) {
          addedUsers.push(did);
          const segment = this.userRepo.upsertQueries(did);
          query = query.concat(segment.query);
          nquads = nquads.concat(segment.nquads);
        }
      }

      /** commit object might exist because of parallel update head call */
      query = query.concat(`\ncommit${id} as var(func: eq(xid, ${id}))`);
      query = query.concat(
        `\ndataof${id} as var(func: eq(xid, "${commit.dataId}"))`
      );
      nquads = nquads.concat(`\nuid(dataof${id}) <xid> "${commit.dataId}" .`);

      nquads = nquads.concat(`\nuid(commit${id}) <xid> "${id}" .`);
      nquads = nquads.concat(`\nuid(commit${id}) <stored> "true" .`);
      nquads = nquads.concat(
        `\nuid(commit${id}) <dgraph.type> "${COMMIT_SCHEMA_NAME}" .`
      );
      nquads = nquads.concat(
        `\nuid(commit${id}) <message> "${commit.message}" .`
      );

      for (let creatorDid of commit.creatorsIds) {
        nquads = nquads.concat(
          `\nuid(commit${id}) <creators> uid(profile${this.userRepo.formatDid(
            creatorDid
          )}) .`
        );
      }

      nquads = nquads.concat(
        `\nuid(commit${id}) <timextamp> "${commit.timestamp}"^^<xs:int> .`
      );
      nquads = nquads.concat(`\nuid(commit${id}) <data> uid(dataof${id}) .`);

      nquads = nquads.concat(
        `\nuid(commit${id}) <signature> "${proof.signature}" .`
      );
      nquads = nquads.concat(
        `\nuid(commit${id}) <proof_type> "${proof.type}" .`
      );

      /** get and set the uids of the links */
      for (let ix = 0; ix < commit.parentsIds.length; ix++) {
        query = query.concat(
          `\nparents${id}${ix} as var(func: eq(xid, ${commit.parentsIds[ix]}))`
        );
        nquads = nquads.concat(
          `\nuid(commit${id}) <parents> uid(parents${id}${ix}) .`
        );
        /** set the parent xid in case it was not created */
        nquads = nquads.concat(
          `\nuid(parents${id}${ix}) <xid> "${commit.parentsIds[ix]}" .`
        );
      }

      enitites.push({
        hash: id,
        object: securedCommit.object,
        remote: '',
      });
    }

    const mu = new dgraph.Mutation();
    const req = new dgraph.Request();

    req.setQuery(`query{${query}}`);
    mu.setSetNquads(nquads);
    req.setMutationsList([mu]);

    let result = await this.db.callRequest(req);
    console.log(
      '[DGRAPH] createCommit',
      { query },
      { nquads },
      result.getUidsMap().toArray()
    );

    return enitites;
  }

  getForksUpsert(
    perspectiveId: string[],
    loggedUserId: string | null,
    independent?: boolean,
    independentOf?: string,
    ecoLevels?: number
  ) {
    let query = ``;
    independent = independent === undefined ? true : independent;
    ecoLevels = ecoLevels === undefined ? -1 : ecoLevels;

    if (ecoLevels !== 0) {
      query = `persp as var(func: eq(xid, ${perspectiveId})) 
          ${ecoLevels > 0 ? `@recurse (depth: ${ecoLevels})` : ``}          
          {
            eco as ${ecoLevels >= 1 ? `children` : `ecosystem`}
          }

          ${
            independentOf
              ? ` official(func: eq(xid, ${perspectiveId})) {
                context {
                  officialContext as uid
                }
              }`
              : ``
          }

          ${
            independent || independentOf
              ? ``
              : ` forks(func: uid(eco ${ecoLevels >= 0 ? `, persp` : ``})) {
              context {
                forksContext as uid
              }
            }          
            
            context(func: uid(forksContext)) @cascade {
              forks as ~context @filter(not(uid(eco, persp)))
            }`
          }
         `;

      /**
       *  We check for independent criteria inside the ecoLevels != 0
       * case because this criteria exclusively applies to the children of
       * its children.
       */
      if (independent) {
        // Verify indepent perspectives criteria with parents

        /**
         * In the query below called @recurseChildren, we retrieve the context of:
         * a) The *children of the previous recurse query result a.k.a eco*, whether the query
         * is aimed at walking the tree downwards ("under" asking for children) or upwards ("above"
         * asking for parents) also known as children context.
         * b) The *previous recurse query result* also know as the parent context.
         */
        query = query.concat(`\nrecurseChildren(func: uid(eco)) @filter(not(uid(persp))) {
          children {
						context {
              childrenContext as uid
            }
          }
          context {
            parentContext as uid
          }
        }
        normalRef(func: uid(childrenContext)) {
          normalPersps as ~context @filter(
            not(uid(persp))
            ) @cascade {
              ~children {
                context @filter(not(uid(parentContext)))
              }
            }
        }`);

        // Verify indepent perspectives criteria without parents
        query = query.concat(`\norphanRef(func: uid(childrenContext)) {
          orphanPersps as ~context @filter(
            not(uid(persp))
            AND
            eq(count(~children), 0)
            )
        }`);
      }
    } else if (ecoLevels === 0) {
      query = `persp ${
        independentOf ? `as var` : ``
      }(func: eq(xid, ${perspectiveId})) {
        context {
          officialContext as uid
        }
      }
      
      ${
        independentOf
          ? ``
          : `context(func: uid(officialContext)) @cascade {
          forks as ~context @filter(not(eq(xid, ${perspectiveId})))
        }`
      }`;
    }

    // IndependentOf case will be implemented whether ecoLevels === 0 or not.
    if (independentOf) {
      query = query.concat(`\nparent(func: eq(xid, ${independentOf})) {
        context {
          independentOfContext as uid
        }
      }
      
      normalIndependentOf(func: uid(officialContext)) {
        normalIndependentOf as ~context @filter(
          not(uid(persp
            ${independent || ecoLevels === 0 ? `` : `,forks`}))
        ) @cascade {
          ~children {
            context @filter(not(uid(independentOfContext)))
          }
        }
      }

      orphanIndependentOf(func: uid(officialContext)) {
        orphanIndependentOf as ~context @filter(
          not(uid(persp
            ${independent || ecoLevels === 0 ? `` : `,forks`}))
          AND
          eq(count(~children), 0)
        )
      }`);
    }

    // Collect results first

    /**
     * If ecoLevels === 0, we only check if
     * independentOf is required, else we return
     * forks without filtering.
     *
     * If ecoLevels != 0, we check for Both
     * independentOf and independent, we are checking
     * for the top element and its children of its children.
     */
    query = query.concat(
      `\nindPersp as var(func: uid(
        ${
          ecoLevels === 0
            ? independentOf
              ? `normalIndependentOf, orphanIndependentOf`
              : `forks`
            : independent && independentOf
            ? `normalPersps, orphanPersps, normalIndependentOf, orphanIndependentOf`
            : !independent && independentOf
            ? `forks, normalIndependentOf, orphanIndependentOf`
            : independent && !independentOf
            ? `normalPersps, orphanPersps`
            : `forks`
        }
      ))`
    );

    // Add access control layer before delivering perspectives
    if (loggedUserId) {
      query = query.concat(
        `\npublicAccess as var(func: uid(indPersp)) @filter(eq(publicRead, true))`
      );
      query = query.concat(`\npublicRead(func: uid(publicAccess)) {
         xid
       }`);
      // If loggedUserId is provided, return accessible perspectives
      // to this user as well.
      query = query.concat(`\nuserRead(func: uid(indPersp)) @filter(not(uid(publicAccess))) @cascade {
         xid
         canRead @filter(eq(did, "${loggedUserId}"))
       }`);
    } else {
      // Return only those perspectives publicly accessible.
      query = query.concat(`\npublicRead(func: uid(indPersp)) @filter(eq(publicRead, true)) {
         xid
       }`);
    }

    query = query.concat(`\nforksOf(func: ${
      ecoLevels !== 0 ? `uid(eco, persp)` : `eq(xid, ${perspectiveId})`
    }) {
      ofPerspective: xid
      context {
        forks: ~context @filter(uid(indPersp)) {
          forkId: xid
        }
      }
    }`);
    return query;
  }

  async getForks(
    perspectiveIds: string[],
    forkOptions: SearchForkOptions,
    loggedUserId: string | null,
    ecoLevels?: number
  ): Promise<Array<string>> {
    const query = this.getForksUpsert(
      perspectiveIds,
      loggedUserId,
      forkOptions.independent,
      forkOptions.independentOf,
      ecoLevels
    );

    await this.db.ready();

    let result = (
      await this.db.client.newTxn().query(`query{${query}}`)
    ).getJson();

    let publicRead = [];
    let userRead = [];

    if (result.userRead) {
      userRead = result.userRead.map((persp: any) => {
        return persp.xid;
      });
    }

    if (result.publicRead) {
      publicRead = result.publicRead.map((persp: any) => {
        return persp.xid;
      });
    }

    return [].concat(...userRead).concat([].concat(...publicRead));
  }

  async getPerspectiveRelatives(
    perspectiveId: string,
    relatives: 'ecosystem' | 'children'
  ): Promise<Array<string>> {
    await this.db.ready();
    const query = `query {
      perspective(func: eq(xid, ${perspectiveId})) {
        ${relatives} {
          xid
        }
      }
    }`;

    const result = await this.db.client.newTxn().query(query);

    return result.getJson().perspective[0]
      ? result
          .getJson()
          .perspective[0][`${relatives}`].map((persp: any) => persp.xid)
      : [];
  }

  setDeletedUpsert(perspectiveId: string, value: boolean, upsert: Upsert) {
    upsert.query = upsert.query.concat(
      `\nperspective as var(func: eq(xid, "${perspectiveId}"))`
    );

    upsert.nquads = upsert.nquads.concat(
      `\nuid(perspective) <xid> "${perspectiveId}" .`
    );
    upsert.nquads = upsert.nquads.concat(
      `\nuid(perspective) <deleted> "${value ? 'true' : 'false'}" .`
    );
  }

  async setDeletedPerspectives(
    perspectiveIds: string[],
    deleted: boolean
  ): Promise<void> {
    await this.db.ready();

    /**  */

    let upsert: Upsert = {
      query: ``,
      nquads: ``,
    };

    for (let i = 0; i < perspectiveIds.length; i++) {
      this.setDeletedUpsert(perspectiveIds[i], deleted, upsert);
    }

    const mu = new dgraph.Mutation();
    const req = new dgraph.Request();

    req.setQuery(`query{${upsert.query}}`);
    mu.setSetNquads(upsert.nquads);
    req.setMutationsList([mu]);

    let result = await this.db.callRequest(req);
    console.log(
      '[DGRAPH] deletePerspective',
      { upsert },
      result.getUidsMap().toArray()
    );
  }

  async findPerspectives(context: string): Promise<string[]> {
    await this.db.ready();
    const query = `query {
      perspective(func: eq(stored, "true")) {
        xid
        name
        context @filter(eq(name, "${context}")) {
          name
        }
        authority
        creator {
          did
        }
        timextamp
        nonce
        signature
        type
      }
    }`;

    const result1 = await this.db.client.newTxn().query(query);
    console.log(
      '[DGRAPH] getContextPerspectives',
      { query },
      result1.getJson()
    );
    let perspectives = result1.getJson().perspective.map(
      (dperspective: DgPerspective): Perspective => {
        return {
          remote: dperspective.remote,
          path: dperspective.path,
          creatorId: dperspective.creator.did,
          timestamp: dperspective.timextamp,
          context: dperspective.context.name,
        };
      }
    );

    const result2 = await this.db.client.newTxn().query(query);
    const json = result2.getJson();
    console.log('[DGRAPH] findPerspectives', { query }, json);
    const securedPerspectives = json.perspective.map(
      (dperspective: DgPerspective): string => dperspective.xid
    );

    return securedPerspectives;
  }

  async locatePerspective(
    perspectiveId: string,
    forks: boolean = false,
    loggedUserId: string | null
  ): Promise<ParentAndChild[]> {
    await this.db.ready();
    const userId = loggedUserId !== null ? loggedUserId : '';

    const parentsPortion = `
    {
      xid
      ~children {
        xid
        finDelegatedTo {
          canRead @filter(eq(did, "${userId}")) {
            count(uid)
          }
          publicRead
        }
      }
    }
    `;

    const query = `query {
      perspective(func: eq(xid, "${perspectiveId}")) {
        ${
          forks
            ? `
          context {
            perspectives {
              ${parentsPortion}
            }    
          }`
            : parentsPortion
        }
      }
    }`;

    const result = await this.db.client.newTxn().query(query);
    console.log('[DGRAPH] getContextPerspectives', { query }, result.getJson());

    const data = result.getJson();

    if (data.perspective.length === 0) {
      return [];
    }

    const perspectives: DgPerspective[] = forks
      ? data.perspective[0].context.perspectives
      : data.perspective;

    /** A map to de-duplicate parents entries */
    const parentsAndChildrenMap = new Map<string, ParentAndChild[]>();

    perspectives.forEach((perspective: any) => {
      if (perspective['~children']) {
        perspective['~children'].forEach((parent: any) => {
          const current = parentsAndChildrenMap.get(parent.xid) || [];
          current.push({
            parentId: parent.xid,
            childId: perspective.xid,
          });
          parentsAndChildrenMap.set(parent.xid, current);
        });
      }
    });

    // concatenate all the parents of all perspectives
    return Array.prototype.concat.apply(
      [],
      Array.from(parentsAndChildrenMap.values())
    );
  }

  async getPerspective(
    perspectiveId: string,
    loggedUserId: string | null,
    getPerspectiveOptions: GetPerspectiveOptions = {}
  ): Promise<PerspectiveGetResult> {
    /** getPerspective is about getting the details */
    getPerspectiveOptions.details = true;

    const exploreResult = await this.fetchPerspectives(
      loggedUserId,
      getPerspectiveOptions,
      perspectiveId
    );
    return {
      details: exploreResult.details,
      slice: exploreResult.slice,
    };
  }

  async explorePerspectives(
    searchOptions: SearchOptions,
    loggedUserId: string | null,
    getPerspectiveOptions: GetPerspectiveOptions = {}
  ): Promise<SearchResult> {
    const exploreResult = await this.fetchPerspectives(
      loggedUserId,
      getPerspectiveOptions,
      undefined,
      searchOptions
    );
    return {
      perspectiveIds: exploreResult.perspectiveIds,
      ended: exploreResult.ended ? exploreResult.ended : false,
      slice: exploreResult.slice,
      forksDetails: exploreResult.forksDetails,
    };
  }

  /** A reusable function that can get a perspective or search perspectives while fetching the perspective ecosystem and
  its entities */
  private async fetchPerspectives(
    loggedUserId: string | null,
    getPerspectiveOptions: GetPerspectiveOptions = {},
    perspectiveId?: string,
    searchOptions?: SearchOptions
  ): Promise<FetchResult> {
    let query = ``;
    const { levels, entities, details } = getPerspectiveOptions;

    // Search options
    const start = searchOptions?.start;
    // - LinksTo
    const linksTo = searchOptions?.linksTo;
    // - Text
    const text = searchOptions?.text;

    // - Pagination
    let pagination = searchOptions?.pagination;
    let first = defaultFirst;
    let offset = 0;

    if (searchOptions) {
      // If start, get JoinTree
      if (start) {
        // We check if there will be a next search.
        // If so we have to prepare the query for next search.
        const searchAfterStart = linksTo || text ? true : false;
      }

      if (linksTo) {
        // We check if there was a previous search.
        // If so we have to keep filtering  upon a previous filtering result.
        const searchBeforeLinks = start ? true : false;
        // We check if there will be a next search.
        // If so we have to prepare the query for next search.
        const searchAfterLinks = text ? true : false;
        query = query.concat(
          this.linksToQuery(
            searchBeforeLinks,
            searchAfterLinks,
            linksTo.elements,
            linksTo.joinType
          )
        );
      }

      if (text) {
        // We check if there was a previous search.
        // If so we have to keep filtering  upon a previous filtering result.
        const searchBeforeText = linksTo || start ? true : false;
        query = query.concat(
          this.textSearchQuery(searchBeforeText, text.value, text.textLevels)
        );
      }

      first = pagination ? pagination.first : defaultFirst;
      offset = pagination ? pagination.offset : 0;

      // Set ACL to search result
      const DgraphACL = `
        private as aclPriv(func: uid(filtered)) @filter(eq(deleted, false)) @cascade {
          finDelegatedTo {
            canRead @filter(eq(did, "${loggedUserId}"))
          }
        }
        public as aclPub(func: uid(filtered)) @filter(eq(deleted, false)) @cascade {
          finDelegatedTo @filter(eq(publicRead, true))
        }
        `;

      query = query.concat(DgraphACL);
    } else {
      query = query.concat(
        `filtered as search(func: eq(xid, ${perspectiveId}))`
      );
    }

    /**
     * Order by subnode has been clarified here:
     * https://discuss.dgraph.io/t/sort-query-results-by-any-edge-property/12989
     */

    /** The query uses ecosystem if levels === -1 and get the head and data json objects if entities === true */
    let elementQuery = `
      xid
      stored
      jsonString
      deleted
      finDelegatedTo {
        canWrite @filter(eq(did, "${loggedUserId}")) {
          count(uid)
        }
        canRead @filter(eq(did, "${loggedUserId}")) {
          count(uid)
        }
        publicWrite
        publicRead
      }
    `;

    if (details) {
      elementQuery = elementQuery.concat(
        `\nhead {
          xid
          data {
            xid
            ${entities ? `jsonString` : ''}
          }
          ${entities ? `jsonString` : ''}
        }
        delegate
        delegateTo {
          xid
        }`
      );
    }

    query = query.concat(`
      \nelements as var(func: uid(filtered)) {
        head {
          date as timextamp
        }
        datetemp as max(val(date))
      }
    `);

    if (levels && levels > 0) {
      query = query.concat(
        `\ntopElements as var(func: uid(elements), orderdesc: val(datetemp)
            ${searchOptions ? `,first: ${first}, offset: ${offset}` : ''})
            ${
              searchOptions ? `@filter(uid(private) OR uid(public))` : ''
            } @recurse(depth: ${levels}) {
              recurseIds as children
            }

        perspectives(func: uid(topElements)) {
          ${elementQuery}
        }
        recurseChildren(func: uid(recurseIds)) {
          ${elementQuery}
        }`
      );
    } else {
      query = query.concat(
        `\nperspectives(func: uid(elements), orderdesc: val(datetemp)
          ${searchOptions ? `,first: ${first}, offset: ${offset}` : ''})
          ${searchOptions ? `@filter(uid(private) OR uid(public))` : ''} {
            ${
              levels === -1
                ? `xid ecosystem {${elementQuery}}`
                : `${elementQuery}`
            }
          }`
      );
    }

    let dbResult = await this.db.client.newTxn().query(`query{${query}}`);
    let json = dbResult.getJson();

    const perspectives = json.perspectives;
    // initalize the returned result with empty values
    let result: FetchResult = {
      details: {},
      perspectiveIds: [],
      slice: {
        perspectives: [],
        entities: [],
      },
      forksDetails: [],
    };

    if (first && perspectives.length < first) {
      result.ended = true;
    }

    // then loop over the dgraph results and fill the function output result
    perspectives.forEach((persp: any) => {
      let all = [];
      if (levels && levels > 0) {
        all = [persp].concat(json.recurseChildren);
      } else {
        all = levels && levels > -1 ? [persp] : persp.ecosystem;
      }

      result.perspectiveIds.push(persp.xid);

      all.forEach((element: any) => {
        if (element) {
          /** check access control, if user can't read, simply return undefined head  */

          const canRead = !element.finDelegatedTo.publicRead
            ? element.finDelegatedTo.canRead
              ? element.finDelegatedTo.canRead[0].count > 0
              : false
            : true;

          if (details) {
            const elementDetails = {
              headId:
                canRead && !element.deleted ? element.head.xid : undefined,
              guardianId: element.delegate ? element.delegateTo.xid : undefined,
              canUpdate: !element.finDelegatedTo.publicWrite
                ? element.finDelegatedTo.canWrite
                  ? element.finDelegatedTo.canWrite[0].count > 0
                  : false
                : true,
            };

            if (element.xid === perspectiveId) {
              result.details = elementDetails;
            } else {
              result.slice.perspectives.push({
                id: element.xid,
                details: elementDetails,
              });
            }
          }

          if (entities) {
            const commit = {
              hash: element.head.xid,
              object: decodeData(element.head.jsonString),
              remote: '',
            };

            const data: Entity<any> = {
              hash: element.head.data.xid,
              object: decodeData(element.head.data.jsonString),
              remote: '',
            };

            result.slice.entities.push(commit, data);

            if (element.xid !== perspectiveId) {
              // add the perspective entity only if a subperspective
              const perspective = {
                hash: element.xid,
                object: decodeData(element.jsonString),
                remote: '',
              };
              result.slice.entities.push(perspective);
            }
          }
        }
      });
    });

    // We avoid duplicated results
    result.perspectiveIds = Array.from(new Set(result.perspectiveIds));
    result.slice.perspectives = Array.from(new Set(result.slice.perspectives));
    result.slice.entities = Array.from(new Set(result.slice.entities));

    if (json.forksOf) {
      json.forksOf.map((persp: any) => {
        if (persp.context)
          result.forksDetails!.push({
            forkIds: persp.context.forks.map((fork: any) => fork.forkId),
            ofPerspectiveId: persp.ofPerspective,
          });
      });
    }
    return result;
  }

  // private async fetchPerspectives(
  //   loggedUserId: string | null,
  //   getPerspectiveOptions: GetPerspectiveOptions = {},
  //   perspectiveId?: string,
  //   searchOptions?: SearchOptions
  // ): Promise<FetchResult> {
  //   let query = ``;
  //   const { levels, entities, details } = getPerspectiveOptions;

  //   if (!details && entities) {
  //     throw new Error('Entities can not be provided without details...');
  //   }

  //   /**
  //    * The same function is used for explore and get perspective so as
  //    * to reuse the GetPerspectiveOptions logic
  //    */

  //   let startQuery = '';
  //   let internalWrapper = '';
  //   let optionalWrapper = '';

  //   if (searchOptions) {
  //     enum StartCase {
  //       all = 'all',
  //       start = 'start',
  //       linksTo = 'linksTo',
  //       searchText = 'searchText',
  //     }

  //     const startCase = searchOptions.start && searchOptions.start.elements.length > 0;
  //     const linksToCase = searchOptions.linksTo && searchOptions.linksTo.elements.length > 0;

  //     const start: StartCase = startCase
  //       ? StartCase.start
  //       : linksToCase
  //       ? StartCase.linksTo
  //       : searchOptions.text
  //       ? StartCase.searchText
  //       : StartCase.all;

  //     switch (start) {
  //       case StartCase.all:
  //         /** consider all perspectives in the DB (paginated of course) */
  //         startQuery = `filtered as search(func: eq(dgraph.type, "Perspective"))`;
  //         break;

  //       case StartCase.start:
  //         const ecoSearchA = this.ecosystemSearchUpsert(
  //           searchOptions
  //           {
  //             startQuery,
  //             internalWrapper,
  //             optionalWrapper,
  //           },
  //           loggedUserId
  //         );

  //         startQuery = ecoSearchA.startQuery;

  //         internalWrapper = ecoSearchA.internalWrapper;

  //         optionalWrapper = ecoSearchA.optionalWrapper;

  //         break;

  //       case StartCase.searchText:
  //         startQuery = `filtered as search(func: anyoftext(text, "${searchText}"))`;
  //         break;

  //       case StartCase.under:
  //         const ecoSearch = this.ecosystemSearchUpsert(
  //           under,
  //           linksTo,
  //           SearchType.under,
  //           searchOptions.forks,
  //           text,
  //           {
  //             startQuery,
  //             internalWrapper,
  //             optionalWrapper,
  //           },
  //           loggedUserId
  //         );

  //         startQuery = ecoSearch.startQuery;

  //         internalWrapper = ecoSearch.internalWrapper;

  //         optionalWrapper = ecoSearch.optionalWrapper;

  //         break;

  //       case StartCase.linksTo:
  //         const linksToIds = linksTo.elements.map((el) => el.id);
  //         // We first define the starting query according to each type
  //         if (linksTo.type === Join.full) {
  //           startQuery = `filtered as search(func: eq(dgraph.type, "Perspective")) @cascade`;
  //           internalWrapper = `linksTo @filter(eq(xid, ${linksToIds}))`;

  //           if (searchText !== '') {
  //             if (textLevels === -1) {
  //               // We move the filtered variable to the internal wrapper instead.
  //               startQuery = startQuery.replace('filtered as', '');
  //               internalWrapper = internalWrapper.concat(
  //                 `@cascade {
  //                   ~linksTo  @filter(anyoftext(text, "${searchText}")) {
  //                     filtered as ecosystem
  //                   }
  //                 }`
  //               );
  //             } else {
  //               // We move the filtered variable to the internal wrapper instead.
  //               startQuery = startQuery.replace('filtered as', '');
  //               internalWrapper = internalWrapper.concat(
  //                 `@cascade {
  //                     filtered as ~linksTo @filter(anyoftext(text, "${searchText}"))
  //                   }`
  //               );
  //             }
  //           }
  //         } else if (linksTo.type === Join.inner) {
  //           for (let i = 0; i < linksTo.elements.length; i++) {
  //             startQuery = startQuery.concat(
  //               `\nvar(func: eq(xid, ${linksToIds[i]})) {
  //                 perspectives${i} as ~linksTo ${
  //                 i > 0 ? `@filter(uid(perspectives${i - 1}))` : ''
  //               }
  //               }`
  //             );
  //           }

  //           // We leave the filter open for more options
  //           startQuery = startQuery.concat(
  //             `\nfiltered as search(func: uid(perspectives${
  //               linksToIds.length - 1
  //             })) @filter(type(Perspective)`
  //           );

  //           if (searchText !== '') {
  //             if (textLevels === -1) {
  //               startQuery = startQuery.replace('filtered as', '');
  //               startQuery = startQuery.concat(
  //                 ` AND anyoftext(text, "${searchText}")) {
  //                   filtered as ecosystem
  //                 }`
  //               );
  //             } else {
  //               startQuery = startQuery.concat(
  //                 `AND anyoftext(text, "${searchText}"))`
  //               );
  //             }
  //           } else {
  //             // We close the filter if no more options are needed.
  //             startQuery = startQuery.concat(')');
  //           }
  //         } else {
  //           throw new Error(
  //             'LinksTo operation type must be specified. INNER_JOIN or FULL_JOIN'
  //           );
  //         }
  //         break;
  //     }
  //   } else {
  //     startQuery = `filtered as search(func: eq(xid, ${perspectiveId}))`;
  //   }

  //   query = query.concat(`
  //     ${startQuery} ${
  //     internalWrapper !== ''
  //       ? `{
  //         ${internalWrapper}
  //       }`
  //       : ''
  //   }
  //     ${optionalWrapper}`);

  //   if (searchOptions) {
  //     const DgraphACL = `
  //       private as aclPriv(func: uid(filtered)) @filter(eq(deleted, false)) @cascade {
  //         finDelegatedTo {
  //           canRead @filter(eq(did, "${loggedUserId}"))
  //         }
  //       }
  //       public as aclPub(func: uid(filtered)) @filter(eq(deleted, false)) @cascade {
  //         finDelegatedTo @filter(eq(publicRead, true))
  //       }
  //       `;

  //     query = query.concat(DgraphACL);
  //   }

  //   // Initializes pagination parameters
  //   const { first, offset } = {
  //     first:
  //       searchOptions && searchOptions.pagination
  //         ? searchOptions.pagination.first
  //         : defaultFirst,
  //     offset:
  //       searchOptions && searchOptions.pagination
  //         ? searchOptions.pagination.offset
  //         : 0,
  //   };

  //   /**
  //    * Order by subnode has been clarified here:
  //    * https://discuss.dgraph.io/t/sort-query-results-by-any-edge-property/12989
  //    */

  //   /** The query uses ecosystem if levels === -1 and get the head and data json objects if entities === true */
  //   let elementQuery = `
  //     xid
  //     stored
  //     jsonString
  //     deleted
  //     finDelegatedTo {
  //       canWrite @filter(eq(did, "${loggedUserId}")) {
  //         count(uid)
  //       }
  //       canRead @filter(eq(did, "${loggedUserId}")) {
  //         count(uid)
  //       }
  //       publicWrite
  //       publicRead
  //     }
  //   `;

  //   if (details) {
  //     elementQuery = elementQuery.concat(
  //       `\nhead {
  //         xid
  //         data {
  //           xid
  //           ${entities ? `jsonString` : ''}
  //         }
  //         ${entities ? `jsonString` : ''}
  //       }
  //       delegate
  //       delegateTo {
  //         xid
  //       }`
  //     );
  //   }

  //   query = query.concat(`
  //     \nelements as var(func: uid(filtered)) {
  //       head {
  //         date as timextamp
  //       }
  //       datetemp as max(val(date))
  //     }
  //   `);

  //   if (levels && levels > 0) {
  //     query = query.concat(
  //       `\ntopElements as var(func: uid(elements), orderdesc: val(datetemp)
  //                     ${
  //                       searchOptions
  //                         ? `,first: ${first}, offset: ${offset}`
  //                         : ''
  //                     })
  //                     ${
  //                       searchOptions
  //                         ? `@filter(uid(private) OR uid(public))`
  //                         : ''
  //                     } @recurse(depth: ${levels}) {
  //                       recurseIds as children
  //                     }

  //       perspectives(func: uid(topElements)) {
  //         ${elementQuery}
  //       }
  //       recurseChildren(func: uid(recurseIds)) {
  //         ${elementQuery}
  //       }`
  //     );
  //   } else {
  //     query = query.concat(
  //       `\nperspectives(func: uid(elements), orderdesc: val(datetemp)
  //         ${searchOptions ? `,first: ${first}, offset: ${offset}` : ''})
  //         ${searchOptions ? `@filter(uid(private) OR uid(public))` : ''} {
  //           ${
  //             levels === -1
  //               ? `xid ecosystem {${elementQuery}}`
  //               : `${elementQuery}`
  //           }
  //         }`
  //     );
  //   }

  //   let dbResult = await this.db.client.newTxn().query(`query{${query}}`);
  //   let json = dbResult.getJson();

  //   const perspectives = json.perspectives;
  //   // initalize the returned result with empty values
  //   let result: FetchResult = {
  //     details: {},
  //     perspectiveIds: [],
  //     slice: {
  //       perspectives: [],
  //       entities: [],
  //     },
  //     forksDetails: [],
  //   };

  //   if (first && perspectives.length < first) {
  //     result.ended = true;
  //   }

  //   // then loop over the dgraph results and fill the function output result
  //   perspectives.forEach((persp: any) => {
  //     let all = [];
  //     if (levels && levels > 0) {
  //       all = [persp].concat(json.recurseChildren);
  //     } else {
  //       all = levels === -1 ? persp.ecosystem : [persp];
  //     }

  //     result.perspectiveIds.push(persp.xid);

  //     all.forEach((element: any) => {
  //       if (element) {
  //         /** check access control, if user can't read, simply return undefined head  */

  //         const canRead = !element.finDelegatedTo.publicRead
  //           ? element.finDelegatedTo.canRead
  //             ? element.finDelegatedTo.canRead[0].count > 0
  //             : false
  //           : true;

  //         if (details) {
  //           const elementDetails = {
  //             headId:
  //               canRead && !element.deleted ? element.head.xid : undefined,
  //             guardianId: element.delegate ? element.delegateTo.xid : undefined,
  //             canUpdate: !element.finDelegatedTo.publicWrite
  //               ? element.finDelegatedTo.canWrite
  //                 ? element.finDelegatedTo.canWrite[0].count > 0
  //                 : false
  //               : true,
  //           };

  //           if (element.xid === perspectiveId) {
  //             result.details = elementDetails;
  //           } else {
  //             result.slice.perspectives.push({
  //               id: element.xid,
  //               details: elementDetails,
  //             });
  //           }
  //         }

  //         if (entities) {
  //           const commit = {
  //             hash: element.head.xid,
  //             object: decodeData(element.head.jsonString),
  //             remote: '',
  //           };

  //           const data: Entity<any> = {
  //             hash: element.head.data.xid,
  //             object: decodeData(element.head.data.jsonString),
  //             remote: '',
  //           };

  //           result.slice.entities.push(commit, data);

  //           if (element.xid !== perspectiveId) {
  //             // add the perspective entity only if a subperspective
  //             const perspective = {
  //               hash: element.xid,
  //               object: decodeData(element.jsonString),
  //               remote: '',
  //             };
  //             result.slice.entities.push(perspective);
  //           }
  //         }
  //       }
  //     });
  //   });

  //   // We avoid duplicated results
  //   result.perspectiveIds = Array.from(new Set(result.perspectiveIds));
  //   result.slice.perspectives = Array.from(new Set(result.slice.perspectives));
  //   result.slice.entities = Array.from(new Set(result.slice.entities));

  //   if (json.forksOf) {
  //     json.forksOf.map((persp: any) => {
  //       if (persp.context)
  //         result.forksDetails!.push({
  //           forkIds: persp.context.forks.map((fork: any) => fork.forkId),
  //           ofPerspectiveId: persp.ofPerspective,
  //         });
  //     });
  //   }
  //   return result;
  // }

  async explore(
    searchOptions: SearchOptions,
    getPerspectiveOptions: GetPerspectiveOptions = {
      levels: 0,
      details: false,
      entities: false,
    },
    loggedUserId: string | null
  ): Promise<SearchResult> {
    return await this.explorePerspectives(
      searchOptions,
      loggedUserId,
      getPerspectiveOptions
    );
  }

  private ecosystemSearchUpsert(
    searchOptions: SearchOptions,
    searchUpsert: SearchUpsert,
    loggedUserId: string | null
  ): SearchUpsert {
    /** build the treePERPID variables with the three (under or above) of each
     * of the JointTree elements in the start property */
    if (searchOptions.start) {
      // searchOptions.start.elements.forEach(el => {
      //   const ecosystem = el.levels ? el.levels < 0 : true;
      //   const direction = el.direction ? el.direction : 'under';
      //   const forks = el.forks !== undefined;
      //   // if fork,  then ecoOf is more complex in the sense that it is expected to include the forks of el.id and its children and maybe only those independent
      //   const ecoOfQuery = `ecoOf${el.id}(func: eq(xid, ${el.id})) @cascade ${ecosystem ? '' : `@recurse(depth: ${el.levels})`} {
      //     ${`ecoOf${el.id} as ${`${direction === 'above' ? '~' : ''} ${ecosystem ? 'ecosystem' : 'children'}`}`
      //   }`;
      // })
      // // then joined
      // ..`filtered = func(OR(uid(ecoOf())))`
      // // then further filtered based on linksTo
      // // then further filtered absed on text.
    }

    const ids = searchEcoOption.elements.map((el) => el.id);
    const ecoLevels =
      searchEcoOption.levels !== undefined ? searchEcoOption.levels : -1;

    let { startQuery, internalWrapper, optionalWrapper } = searchUpsert;

    if (searchEcoOption.type === Join.full) {
      startQuery = `search(func: eq(xid, ${ids})) @cascade ${
        ecoLevels > 0 ? `@recurse (depth: ${ecoLevels})` : ``
      }`;
    } else if (searchEcoOption.type === Join.inner) {
      for (let i = 0; i < ids.length; i++) {
        startQuery = startQuery.concat(
          `\nvar(func: eq(xid, ${ids[i]}))  ${
            ecoLevels > 0 ? `@recurse (depth: ${ecoLevels})` : ``
          } {
            eco${i} as ${ecoLevels > 0 ? `children` : `ecosystem`} ${
            i > 0 ? `@filter(uid(eco${i - 1}))` : ''
          }
          }`
        );
      }
      startQuery = startQuery.concat(
        `\nsearch(func: uid(eco${ids.length - 1})) @filter(type(Perspective)) ${
          ecoLevels > 0 ? `@recurse (depth: ${ecoLevels})` : ``
        }`
      );
    } else {
      throw new Error(
        'Ecosystem operation type must be specified. INNER_JOIN or FULL_JOIN'
      );
    }

    if (linksTo.elements && linksTo.elements.length > 0) {
      // under and linksTo
      const linksToIds = linksTo.elements.map((el) => el.id);
      if (linksTo.type === Join.full) {
        internalWrapper = `linkingTo as ${
          ecoLevels > 0 ? `children` : `ecosystem`
        } {
          linksTo @filter(eq(xid, ${linksToIds}))
        }`;
      } else if (linksTo.type === Join.inner) {
        internalWrapper = `link0 as ${
          ecoLevels > 0 ? `children` : `ecosystem`
        }`;

        for (let i = 0; i < linksToIds.length; i++) {
          optionalWrapper = optionalWrapper.concat(
            `\nvar(func: eq(xid, ${linksToIds[i]})) {
              link${i + 1} as ~linksTo @filter(uid(link${i}))
            }`
          );
        }
        optionalWrapper = optionalWrapper.concat(
          `linkingTo as var(func: uid(link${linksToIds.length})) @filter(type(Perspective))`
        );
      } else {
        throw new Error(
          'LinksTo operation type must be specified. INNER_JOIN or FULL_JOIN'
        );
      }

      if (searchText.value !== '') {
        // under and linksTo and textSearch
        if (searchText.levels === -1) {
          // in ecosystem of each linkTo matched
          // WARNING THIS IS SAMPLE CODE. How can it be fixed without changing its logic/spirit?
          optionalWrapper = optionalWrapper.concat(`
            \noptionalWrapper(func: uid(linkingTo)) @filter(anyoftext(text, "${searchText.value}")) {
              filtered as ecosystem
            }`);
        } else {
          optionalWrapper = optionalWrapper.concat(
            `\nfiltered as var(func: uid(linkingTo)) @filter(anyoftext(text, "${searchText.value}"))`
          );
        }
      } else {
        // only under and linksTo
        internalWrapper = internalWrapper.replace('linkingTo', 'filtered');
        optionalWrapper = optionalWrapper.replace('linkingTo', 'filtered');
      }
      // Under and search
    } else if (searchText.value !== '') {
      if (searchText.levels === -1) {
        internalWrapper = `
        ${ecoLevels > 0 ? `children` : `ecosystem`} @filter(anyoftext(text, "${
          searchText.value
        }")) {
            filtered as ecosystem
          }
        `;
      } else {
        internalWrapper = `
          filtered as ${
            ecoLevels > 0 ? `children` : `ecosystem`
          } @filter(anyoftext(text, "${searchText.value}"))
        `;
      }
    } else if (forks) {
      // if only under or above and fork
      let independentUpsert = this.getForksUpsert(
        ids,
        loggedUserId,
        forks.independent,
        forks.independentOf,
        ecoLevels
      );

      if (loggedUserId !== null) {
        independentUpsert = independentUpsert.replace(
          'publicRead(',
          'publicRead as var ('
        );
        independentUpsert = independentUpsert.replace(
          'userRead(',
          'userRead as var ('
        );
        optionalWrapper = optionalWrapper.concat(independentUpsert);
      } else {
        independentUpsert = independentUpsert.replace(
          'publicRead(',
          'publicRead as var ('
        );
        optionalWrapper = optionalWrapper.concat(independentUpsert);
      }

      optionalWrapper = optionalWrapper.concat(
        `\n${
          forks.exclusive ? `filtered` : `ecoForks`
        } as var(func: uid(publicRead ${
          loggedUserId !== null ? `,userRead` : ``
        }))`
      );

      if (!forks.exclusive) {
        internalWrapper = 'ecoElements as ecosystem';
        optionalWrapper = optionalWrapper.concat(
          `\n filtered as var(func: uid(ecoElements, ecoForks))`
        );
      }
    } else {
      internalWrapper = `filtered as ${
        ecoLevels > 0 ? `children` : `ecosystem`
      }`;
    }

    if (searchType === SearchType.above) {
      if (ecoLevels > 0) {
        startQuery = startQuery.replace('children', '~children');
        internalWrapper = internalWrapper.replace('children', '~children');
        optionalWrapper = optionalWrapper.replace('children', '~children');
      } else {
        startQuery = startQuery.replace('ecosystem', '~ecosystem');
        internalWrapper = internalWrapper.replace('ecosystem', '~ecosystem');
        optionalWrapper = optionalWrapper.replace('ecosystem', '~ecosystem');
      }
    }

    return {
      startQuery,
      internalWrapper,
      optionalWrapper,
    };
  }

  private linksToQuery(
    previousSearch: boolean,
    nextSearch: boolean,
    elements: string[],
    type?: Join
  ): string {
    if (type === Join.full || !type) {
      return `
        ${
          previousSearch
            ? `${
                nextSearch ? `searchResult` : `filtered`
              } as search(func: uid(treeResult)) @cascade {
            linksTo @filter(eq(xid, ${elements}))
          }`
            : `${
                nextSearch ? `searchResult` : `filtered`
              } as search(func: type(Perspective)) @cascade {
            linksTo @filter(eq(xid, ${elements}))
          }`
        }
      `;
    } else if (type === Join.inner) {
      let query = ``;

      for (let i = 0; i < elements.length; i++) {
        query = query.concat(`
        \nvar(func: eq(xid, ${elements[i]})) {
          perspectives${i} as ~linksTo 
          ${i > 0 ? `@filter(uid(perspectives${i - 1}))` : ''}
        }`);
      }

      return `
        ${query}
        \n
        ${
          previousSearch
            ? `${
                nextSearch ? `searchResult` : `filtered`
              } as search(func: uid(perspectives${elements.length - 1}))
          @filter(type(treeResult))`
            : `${
                nextSearch ? `searchResult` : `filtered`
              } as search(func: uid(perspectives${elements.length - 1}))
          @filter(type(Perspective))`
        }
      `;
    }
    return '';
  }

  private textSearchQuery(
    previousSearch: boolean,
    value: string,
    levels?: number
  ): string {
    if (levels) {
      // We return the depth of the perspective found.
      return `
      ${
        previousSearch
          ? `search(func: uid(searchResult)) @filter(anyoftext(text, "${value}"))`
          : `search(func: anyoftext(text, "${value}"))`
      }

      search(func: anyoftext(text, "${value}")) 
        ${
          levels
            ? `@recurse(depth: ${levels}) {
            filtered as children
          }`
            : `{
            filtered as ecosystem
          }`
        }
      }`;
    } else {
      return `
      ${
        previousSearch
          ? `filtered as search(func: uid(searchResult)) @filter(anyoftext(text, "${value}"))`
          : `filtered as search(func: anyoftext(text, "${value}"))`
      }`;
    }
  }

  private startQuery(type: Join, elements: JoinTree[]): string {
    // First we retrieve the Join Trees
    // Then we join every join tree element depending on the Join Type
  }

  private retrieveJoinTree(
    id: string,
    direction?: 'under' | 'above',
    levels?: number,
    exclusive?: boolean,
    independent?: boolean,
    independentOf?: string
  ): string {
    const forks = exclusive || independent || independentOf;
    const under = direction === 'under' ? true : false;
    const eco = levels && levels < 0 ? true : false;

    // We collect first the perspectives corresponding the tree element.
    let query = `
      original${id} as var(func: eq(xid, ${id}))
      ${
        eco
          ? `{
          ${under ? `ecosystem` : `~ecosystem`}
        }`
          : `@recurse (depth: ${levels}) {
          ${under ? `children` : `~children`}
        }`
      }
    `;
    // Consequently, we check for forks regarding the given element.
    if (forks) {
      // TODO: Deliver forks.
    }
  }
}
