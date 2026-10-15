'use strict';

/*
 * The discovery documents (RFC 7643 §5–§7, RFC 7644 §4). They describe what this server ACTUALLY
 * does: an IdP reads ServiceProviderConfig to decide whether to send PATCH, filters or bulk
 * requests, and a document that promises more than we do produces failures nobody can diagnose.
 */

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RT = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const MAX_RESULTS = 200;

function serviceProviderConfig(base) {
  return {
    schemas: [SPC],
    documentationUri: 'https://github.com/screentinker/screentinker/blob/main/docs/scim.md',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'A provisioning token minted by an organization admin under Settings > User provisioning (SCIM).',
      primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

function resourceTypes(base) {
  return [
    { schemas: [RT], id: 'User', name: 'User', endpoint: '/Users', description: 'A person in the organization', schema: USER, schemaExtensions: [], meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
    { schemas: [RT], id: 'Group', name: 'Group', endpoint: '/Groups', description: 'A group whose members receive workspace access', schema: GROUP, schemaExtensions: [], meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
  ];
}

const attr = (name, type, extra = {}) => ({
  name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
});

function schemas(base) {
  return [
    {
      schemas: [SCHEMA], id: USER, name: 'User', description: 'User account',
      attributes: [
        attr('userName', 'string', { required: true, uniqueness: 'server' }),
        attr('name', 'complex', { subAttributes: [attr('givenName', 'string'), attr('familyName', 'string'), attr('formatted', 'string', { mutability: 'readOnly' })] }),
        attr('displayName', 'string'),
        attr('active', 'boolean'),
        attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
        attr('groups', 'complex', { multiValued: true, mutability: 'readOnly', subAttributes: [attr('value', 'string', { mutability: 'readOnly' }), attr('display', 'string', { mutability: 'readOnly' })] }),
        attr('externalId', 'string', { caseExact: true }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${USER}` },
    },
    {
      schemas: [SCHEMA], id: GROUP, name: 'Group', description: 'Group',
      attributes: [
        attr('displayName', 'string', { required: true, uniqueness: 'server' }),
        attr('members', 'complex', { multiValued: true, subAttributes: [attr('value', 'string', { mutability: 'immutable' }), attr('display', 'string', { mutability: 'readOnly' })] }),
        attr('externalId', 'string', { caseExact: true }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${GROUP}` },
    },
  ];
}

module.exports = { USER, GROUP, LIST, ERROR, MAX_RESULTS, serviceProviderConfig, resourceTypes, schemas };
