/**
 * Field-level access for fields that record what happened, rather than ask for it.
 *
 * `createdAt` and `statusChangedAt` are stamped by the server (a default or a
 * hook). Neither a customer nor a staff member may write them through the API: an
 * editable "created at" is not a record, it is a suggestion.
 *
 * The explicit throwing-free functions matter to Keystone's typing: a plain
 * `false` is also legal, but these read as "nobody, ever" at the call site.
 *
 * NOTE FOR FUTURE READERS: the access-control tripwire in
 * `test/access-rules.test.js` matches `update: () => false` as evidence of a list
 * whose updates are denied (finding F5). That is why these live here as a named
 * constant instead of being repeated inline in a list's `access` block — a
 * field-level guard inside `fields:` must not be mistaken for a list-level one.
 */
export const READ_ONLY = {
  create: () => false,
  update: () => false,
};
