'use strict';

/*
 * Shared pieces for the vendor adapters: bounded pagination, GraphQL calls, and the limits that
 * keep one scan from walking an unbounded account (a catalog is stored as JSON on the job row).
 */

const { MigrateHttpError } = require('../transport');

const MAX_ITEMS = 20000;      // per kind; an account larger than this is imported in part, and says so
const PAGE = 100;

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

/**
 * Offset pagination. fetchPage(offset, limit) -> { rows, total? }. Stops on a short page, on the
 * total, or at MAX_ITEMS (then `truncated` is set so the scan can say so).
 */
async function offsetPages(fetchPage, { page = PAGE, max = MAX_ITEMS } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { rows, total } = await fetchPage(offset, page);
    const list = Array.isArray(rows) ? rows : [];
    out.push(...list);
    offset += list.length;
    if (out.length >= max) return { rows: out.slice(0, max), truncated: true };
    if (list.length < page || (Number.isFinite(total) && offset >= total) || !list.length) return { rows: out, truncated: false };
  }
}

/** A GraphQL query through a transport client. Errors in `errors[]` (HTTP 200) are surfaced. */
async function gql(client, query, variables = {}) {
  const { body } = await client.api('', { method: 'POST', body: JSON.stringify({ query, variables }), extraHeaders: { 'Content-Type': 'application/json' } });
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const code = body.errors[0] && body.errors[0].extensions && body.errors[0].extensions.code;
    if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') throw new MigrateHttpError('The token was refused. Check it and that it can read this account.', 'unauthorized', 401);
    throw new MigrateHttpError('The vendor refused the query. The token may be missing a read permission.', 'graphql');
  }
  return (body && body.data) || {};
}

/** Relay-style connection pagination over GraphQL: pick(data) -> { nodes, pageInfo }. */
async function cursorPages(client, query, pick, { first = PAGE, max = MAX_ITEMS, variables = {} } = {}) {
  const out = [];
  let after = null;
  for (let guard = 0; guard < 1000; guard++) {
    const data = await gql(client, query, { ...variables, first, after });
    const { nodes, pageInfo } = pick(data) || {};
    out.push(...(nodes || []));
    if (out.length >= max) return { rows: out.slice(0, max), truncated: true };
    if (!pageInfo || !pageInfo.hasNextPage || !pageInfo.endCursor || !(nodes || []).length) break;
    after = pageInfo.endCursor;
  }
  return { rows: out, truncated: false };
}

function truncatedNote(unmapped, kind, truncated) {
  if (truncated) unmapped.push({ kind, name: `${kind} beyond the first ${MAX_ITEMS}`, reason: `Only the first ${MAX_ITEMS} are read in one import. Bring the rest with the zip import, or ask your administrator.` });
}

function str(v, max = 300) { return v == null ? '' : String(v).slice(0, max); }

module.exports = { offsetPages, gql, cursorPages, truncatedNote, userError, str, MAX_ITEMS, PAGE };
