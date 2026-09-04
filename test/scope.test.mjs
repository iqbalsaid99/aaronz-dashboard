import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAgentScope, filterPayload, isForwardable,
  redactOwnerContacts, canSeeOwnerContacts,
} from '../functions/_lib/scope.js';

const lead = (id, agentId) => ({ id, agents: [{ id: agentId, name: 'X' }] });

/* --------------------------- the upstream filter --------------------------- */

/**
 * Probed against the live API: assigned_to takes exactly one value. Every
 * multi-value form — comma-joined, repeated, bracketed — comes back 400, which
 * meant any manager with more than one report could not load leads at all.
 */
test('one allowed id sets assigned_to', () => {
  const p = applyAgentScope('/leads', new URLSearchParams('page=1'), new Set(['11']));
  assert.equal(p.get('assigned_to'), '11');
  assert.equal(p.get('page'), '1');
});

test('several allowed ids omit assigned_to rather than sending a 400', () => {
  const p = applyAgentScope('/leads', new URLSearchParams('page=1'), new Set(['11', '22']));
  assert.equal(p.get('assigned_to'), null, 'a comma-joined list is rejected upstream');
  assert.equal(p.get('page'), '1', 'the rest of the query must survive');
});

test('omitting the upstream filter does not widen what comes back', () => {
  // The safety net: filterPayload runs on every response regardless of what
  // the request asked for, so a manager pages more and still sees only theirs.
  const allowed = new Set(['11', '22']);
  const page = { data: [lead(1, 11), lead(2, 99), lead(3, 22), lead(4, 77)] };
  assert.deepEqual(filterPayload(page, allowed).json.data.map((l) => l.id), [1, 3]);
});

test('unrestricted and empty are not the same thing', () => {
  const page = { data: [lead(1, 11)] };
  assert.equal(filterPayload(page, null).json.data.length, 1, 'null = no filter');
  assert.equal(filterPayload(page, new Set()).json.data.length, 0, 'empty set = see nothing');
  assert.equal(
    applyAgentScope('/leads', new URLSearchParams(), new Set()).get('assigned_to'), null
  );
});

test('assigned_to is never applied off lead paths', () => {
  for (const p of ['/listings', '/options/agents']) {
    assert.equal(
      applyAgentScope(p, new URLSearchParams(), new Set(['11'])).get('assigned_to'), null
    );
  }
});

/* ------------------------------- allowlist ------------------------------- */

test('the contact book is not forwardable', () => {
  assert.equal(isForwardable('/contacts'), false);
  assert.equal(isForwardable('/contacts/1'), false);
});

test('what the app actually calls is forwardable', () => {
  for (const p of ['/leads', '/leads/1', '/listings', '/listings/9',
                   '/options/agents', '/options/sub_statuses']) {
    assert.equal(isForwardable(p), true, p);
  }
});

/* ------------------------------- owner PII ------------------------------- */

test('owner contacts are stripped for anyone below admin', () => {
  const l = { id: 1, price: 100, owner: { id: 7, name: 'A', email: 'a@b.c', mobile: '+971' },
              agent: { id: 4412, name: 'Dennis', email: 'd@x.com' } };
  const r = redactOwnerContacts(l);
  assert.equal(r.owner.name, undefined);
  assert.equal(r.owner.email, undefined);
  assert.equal(r.owner.mobile, undefined);
  assert.equal(r.owner.id, 7, 'the id is not personal information');
  assert.equal(r.owner.redacted, true);
  assert.equal(r.price, 100);
  assert.equal(r.agent.email, 'd@x.com', 'colleagues are not redacted');
});

test('only admin and super_admin see owner contacts', () => {
  assert.equal(canSeeOwnerContacts({ role: 'super_admin' }), true);
  assert.equal(canSeeOwnerContacts({ role: 'admin' }), true);
  assert.equal(canSeeOwnerContacts({ role: 'manager' }), false);
  assert.equal(canSeeOwnerContacts({ role: 'broker' }), false);
  assert.equal(canSeeOwnerContacts({}), false);
});

/* ------------------ meta.total must not survive scoping ------------------ */

test('a scoped caller does not receive the upstream total', () => {
  // meta.total is the size of the result set BEFORE filtering, so it describes
  // rows this caller may not see. /leads?assigned_to=<someone else>&per_page=1
  // would otherwise hand a broker another broker's exact lead count with no row
  // ever crossing the boundary.
  const allowed = new Set(['7']);
  const page = {
    data: [{ id: 1, agents: [{ id: 7 }] }],
    meta: { total: 42_869, page: 1, per_page: 1 },
  };

  const { json } = filterPayload(page, allowed);
  assert.equal(json.meta.total, undefined, 'the unscoped total must not leak');
  assert.equal(json.meta.page, 1, 'the rest of the envelope is left alone');
  assert.deepEqual(json.data.map((l) => l.id), [1]);
});

test('an unscoped caller keeps the total', () => {
  const page = { data: [{ id: 1, agents: [{ id: 7 }] }], meta: { total: 42_869 } };
  const { json } = filterPayload(page, null);
  assert.equal(json.meta.total, 42_869);
});

test('a payload with no meta does not gain one', () => {
  const { json } = filterPayload({ data: [{ id: 1, agents: [{ id: 7 }] }] }, new Set(['7']));
  assert.ok(!('meta' in json), 'inventing a meta key would be a different lie');
});
