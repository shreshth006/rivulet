# Querying, Filtering and Projection

Rivulet provides a rich, dependency-free query interface for querying local materialised CRDT documents synchronously without network latency.

## Query Methods

Queries operate directly over in-memory collections and return plain JavaScript records:

```js
// Fetch single document by ID (returns null if deleted or missing)
const note = client.get('notes', 'note-id');

// Check document presence and active (non-tombstone) status
const exists = client.exists('notes', 'note-id');

// Find first matching document
const urgent = client.find('notes', { pinned: true });
const urgent2 = client.findOne('notes', { pinned: true }); // alias

// List documents with filtering, sorting, pagination and projection
const results = client.list('notes', {
  where: { reads: { $gte: 10 } },
  sort: '-reads',
  limit: 25,
  offset: 0,
  select: ['title', 'reads', 'tags'],
});

// Count matching documents
const count = client.count('notes', { where: { tags: 'work' } });
```

---

## Comparison and Logical Operators

Filters in `where` support both direct value matching and operator expressions:

### Value Equality and Inclusion
```js
// Direct equality on primitives
client.list('notes', { where: { pinned: true } });

// Set/array membership (matches if tags array or set contains 'work')
client.list('notes', { where: { tags: 'work' } });
```

### Relational Operators
```js
// Numerical and date comparisons ($gt, $gte, $lt, $lte, $ne)
client.list('notes', {
  where: {
    reads: { $gte: 5, $lt: 100 },
    status: { $ne: 'archived' },
  },
});
```

### Set Membership ($in, $nin)
```js
client.list('notes', {
  where: {
    category: { $in: ['work', 'personal'] },
    status: { $nin: ['spam', 'deleted'] },
  },
});
```

### Field Existence ($exists)
```js
// Filter documents where a field is defined and non-null
client.list('notes', { where: { estimate: { $exists: true } } });
```

### Regular Expressions ($regex)
```js
// String pattern matching using strings or RegExp instances
client.list('notes', {
  where: {
    title: { $regex: '^Meeting' },
  },
});
```

### Function Predicates
For complex business logic, provide a custom predicate function:
```js
client.list('notes', {
  where: (doc) => doc.reads > 10 && doc.title.toLowerCase().includes('wifi'),
});
```

---

## Field Projection (`select`)

When querying wide documents with large text bodies or history, `select` restricts returned records to only the named fields plus `id`:

```js
const titles = client.list('notes', {
  select: ['title', 'pinned'],
});
// [{ id: '...', title: '...', pinned: true }, ...]
```

---

## Sorting Specs

Sort specifications support three ergonomic formats:

1. **Ascending field name:** `'title'`
2. **Descending field name:** `'-reads'`
3. **Object map:** `{ reads: -1, title: 1 }`
4. **Comparator function:** `(a, b) => a.reads - b.reads`

```js
// Sort by title ascending
client.list('notes', { sort: 'title' });

// Sort by reads descending
client.list('notes', { sort: '-reads' });

// Multi-field sort: pinned first (desc), then reads (desc)
client.list('notes', { sort: { pinned: -1, reads: -1 } });
```

---

## Conflict Inspection

Concurrent edits across offline replicas to multi-value fields (`mv`) retain all conflicting siblings:

```js
// Check if a specific document has unresolved concurrent writes
const isConflicted = client.hasConflict('notes', id);

// Retrieve all conflicted documents across a collection
const conflicts = client.conflicts('notes');

// Resolving a conflict is a standard mutation:
// writing a chosen value supersedes the concurrent siblings
client.mutate((tx) => {
  tx.set('notes', id, 'estimate', '3d');
});
```
