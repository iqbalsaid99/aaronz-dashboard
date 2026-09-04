/**
 * GET /api/bayut — Bayut website-client-leads.
 *
 * Deliberately nothing but a mount point. Everything, including the upstream
 * base URL and which query parameters are allowed through, lives in the config
 * map in _lib/portalLeads.js so that adding dubizzle — same key, same schema,
 * different host — is an entry in that map and a file exactly like this one.
 */
export { onRequest } from '../_lib/portalLeads.js';
