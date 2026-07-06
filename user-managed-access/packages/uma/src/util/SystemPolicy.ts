import { RDF } from '@solid/community-server';
import { DataFactory, Store } from 'n3';
import { ODRL } from '../ucp/util/Vocabularies';

const { namedNode, quad } = DataFactory;

export const SYSTEM_POLICY_TYPE_IRI = 'urn:solidlab:uma:SystemPolicy';

export const OWNER_ACCESS_ACTIONS = [
  ODRL.terms.read,
  ODRL.terms.append,
  ODRL.terms.create,
  ODRL.terms.delete,
  namedNode(`${ODRL.namespace}modify`),
];

const encodeResourceId = (resourceId: string): string => Buffer.from(resourceId).toString('base64url');

export const getOwnerReadPolicyId = (resourceId: string): string =>
  `urn:solidlab:uma:policy:owner-access:${encodeResourceId(resourceId)}`;

export const getOwnerReadPermissionId = (resourceId: string): string =>
  `urn:solidlab:uma:permission:owner-read:${encodeResourceId(resourceId)}`;

export const getOwnerAccessPolicyId = getOwnerReadPolicyId;

export const getOwnerAccessPermissionId = (resourceId: string, action: string): string => {
  if (action === ODRL.read) {
    return getOwnerReadPermissionId(resourceId);
  }
  return `urn:solidlab:uma:permission:owner-${action.slice(ODRL.namespace.length)}:${encodeResourceId(resourceId)}`;
};

export const getRegisteredResourceAccessPolicyId = (resourceId: string, assignee: string): string =>
  `urn:solidlab:uma:policy:registered-resource-access:${encodeResourceId(resourceId)}:${encodeResourceId(assignee)}`;

export const getRegisteredResourceAccessPermissionId = (
  resourceId: string,
  assignee: string,
  action: string,
): string =>
  `urn:solidlab:uma:permission:registered-resource-access:${
    encodeResourceId(`${resourceId}|${assignee}|${action}`)
  }`;

const CSS_SCOPE_TO_ODRL_ACTION: Record<string, string> = {
  'urn:example:css:modes:read': ODRL.read,
  'urn:example:css:modes:append': ODRL.append,
  'urn:example:css:modes:create': ODRL.create,
  'urn:example:css:modes:delete': ODRL.delete,
  'urn:example:css:modes:write': ODRL.write,
};

const toOdrlAction = (action: string): string => CSS_SCOPE_TO_ODRL_ACTION[action] ?? action;

export const createRegisteredResourceAccessPolicy = (
  resourceId: string,
  assigner: string,
  assignee: string,
  actions: string[] = [],
): Store => {
  const uniqueActions = Array.from(new Set(actions
    .map(toOdrlAction)
    .filter((action) => action.trim().length > 0)));
  if (uniqueActions.length === 0) {
    return new Store();
  }

  const policyId = getRegisteredResourceAccessPolicyId(resourceId, assignee);
  const result = new Store([
    quad(namedNode(policyId), RDF.terms.type, ODRL.terms.Agreement),
    quad(namedNode(policyId), ODRL.terms.uid, namedNode(policyId)),
  ]);

  for (const action of uniqueActions) {
    const permissionId = getRegisteredResourceAccessPermissionId(resourceId, assignee, action);
    result.addQuads([
      quad(namedNode(policyId), ODRL.terms.permission, namedNode(permissionId)),
      quad(namedNode(permissionId), RDF.terms.type, ODRL.terms.Permission),
      quad(namedNode(permissionId), ODRL.terms.action, namedNode(action)),
      quad(namedNode(permissionId), ODRL.terms.target, namedNode(resourceId)),
      quad(namedNode(permissionId), ODRL.terms.assignee, namedNode(assignee)),
      quad(namedNode(permissionId), ODRL.terms.assigner, namedNode(assigner)),
    ]);
  }

  return result;
};

export const createOwnerAccessPolicy = (resourceId: string, owner: string): Store => {
  const policyId = getOwnerReadPolicyId(resourceId);
  const result = new Store([
    quad(namedNode(policyId), RDF.terms.type, ODRL.terms.Agreement),
    quad(namedNode(policyId), ODRL.terms.uid, namedNode(policyId)),
  ]);

  for (const action of OWNER_ACCESS_ACTIONS) {
    const permissionId = getOwnerAccessPermissionId(resourceId, action.value);
    result.addQuads([
      quad(namedNode(policyId), ODRL.terms.permission, namedNode(permissionId)),
      quad(namedNode(permissionId), RDF.terms.type, ODRL.terms.Permission),
      quad(namedNode(permissionId), ODRL.terms.action, action),
      quad(namedNode(permissionId), ODRL.terms.target, namedNode(resourceId)),
      quad(namedNode(permissionId), ODRL.terms.assignee, namedNode(owner)),
      quad(namedNode(permissionId), ODRL.terms.assigner, namedNode(owner)),
    ]);
  }

  return result;
};

export const createOwnerReadPolicy = createOwnerAccessPolicy;

export const hasOwnerAccessPolicy = (store: Store, resourceId: string): boolean =>
  OWNER_ACCESS_ACTIONS.every((action) => {
    const permission = namedNode(getOwnerAccessPermissionId(resourceId, action.value));
    return store.countQuads(namedNode(getOwnerAccessPolicyId(resourceId)), ODRL.terms.permission, permission, null) > 0 &&
      store.countQuads(permission, ODRL.terms.action, action, null) > 0;
  });

export const hasOwnerReadPolicy = hasOwnerAccessPolicy;

export const hasAnyOwnerAccessPolicy = (store: Store, owner: string): boolean =>
  store.getSubjects(RDF.terms.type, namedNode(SYSTEM_POLICY_TYPE_IRI), null)
    .some((policy) => store.getObjects(policy, ODRL.terms.permission, null)
      .some((permission) => store.countQuads(permission, ODRL.terms.assigner, namedNode(owner), null) > 0));

export const isOwnerAccessPolicyId = (policyId: string): boolean =>
  policyId.startsWith('urn:solidlab:uma:policy:owner-access:');

export const isSystemPolicy = (store: Store, policyId: string): boolean =>
  store.getSubjects(ODRL.terms.uid, namedNode(policyId), null)
    .some((subject) => store.has(quad(subject, RDF.terms.type, namedNode(SYSTEM_POLICY_TYPE_IRI))));
